// Spike: drive worker.py the way the server would, and time it from Node's side.
//
//   node drive.mjs <capture> <rate> <center> <out.f32>
//
// Prints warm block latency (as Node sees it, IPC included), retune-to-effect latency on
// a running chain, and writes 16 s of interleaved L/R to <out.f32> for a quality check.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [capture, rate, center, outPath] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const w = spawn('python3', [path.join(here, 'worker.py')], { stdio: ['pipe', 'pipe', 'inherit'] });

let buf = Buffer.alloc(0);
const waiting = [];
w.stdout.on('data', (d) => { buf = Buffer.concat([buf, d]); pump(); });
function pump() {
  while (waiting.length) {
    const nl = buf.indexOf(10);
    if (nl < 0) return;
    const head = JSON.parse(buf.subarray(0, nl).toString());
    const need = head.bytes || 0;
    if (buf.length < nl + 1 + need) return;
    const payload = need ? new Float32Array(buf.buffer.slice(buf.byteOffset + nl + 1, buf.byteOffset + nl + 1 + need)) : null;
    buf = buf.subarray(nl + 1 + need);
    waiting.shift()({ head, payload });
  }
}
const ask = (req) => new Promise((resolve) => { waiting.push(resolve); w.stdin.write(JSON.stringify(req) + '\n'); });
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

const t0 = performance.now();
await ask({ op: 'open', path: capture, rate: Number(rate) });
const first = await ask({ op: 'block', center: Number(center), t0: 5, seconds: 0.25 });
console.log(`worker up + first block: ${(performance.now() - t0).toFixed(0)} ms`);

const node = [], inside = [];
for (let k = 0; k < 20; k++) {
  const t = performance.now();
  const r = await ask({ op: 'block', center: Number(center), t0: 6 + k * 0.25, seconds: 0.25 });
  node.push(performance.now() - t); inside.push(r.head.ms);
}
console.log(`warm 0.25 s block: ${med(node).toFixed(0)} ms as Node sees it (worker ${med(inside).toFixed(0)} ms, ` +
  `IPC ${(med(node) - med(inside)).toFixed(1)} ms), max ${Math.max(...node).toFixed(0)} ms, ${first.head.frames} frames`);

// Sequential 0.25 s blocks for 16 s, which is also the audio for the quality check.
const t2 = performance.now(); const parts = [];
for (let k = 0; k < 64; k++) parts.push((await ask({ op: 'block', center: Number(center), t0: 8 + k * 0.25, seconds: 0.25 })).payload);
const el = performance.now() - t2;
const total = parts.reduce((n, p) => n + p.length, 0), all = new Float32Array(total);
let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
fs.writeFileSync(outPath, Buffer.from(all.buffer));
console.log(`16 s of stereo as 64 blocks: ${el.toFixed(0)} ms = ${(16000 / el).toFixed(1)}x real time`);

await ask({ op: 'live', center: Number(center), t0: 20 });
const rt = [];
for (let k = 0; k < 6; k++) {
  const r = await ask({ op: 'retune', center: Number(center) + (k % 2 === 0 ? 250_000 : 0) });
  rt.push(r.head.ms_to_90pct);
}
console.log(`retune to audible effect (90% of the level change): ${rt.map((v) => v == null ? '-' : v.toFixed(0)).join(', ')} ms`);
await ask({ op: 'stop' });
