import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { run } from '/app/server/adapters.js';
const w = spawn('python3', ['/tmp/spike/worker.py'], { stdio: ['pipe', 'pipe', 'ignore'] });
let buf = Buffer.alloc(0); const waiting = [];
w.stdout.on('data', (d) => { buf = Buffer.concat([buf, d]); for (;;) { const nl = buf.indexOf(10); if (nl < 0 || !waiting.length) return;
  const h = JSON.parse(buf.subarray(0, nl)); const need = h.bytes || 0; if (buf.length < nl + 1 + need) return;
  const p = need ? new Float32Array(buf.buffer.slice(buf.byteOffset + nl + 1, buf.byteOffset + nl + 1 + need)) : null; buf = buf.subarray(nl + 1 + need); waiting.shift()({ h, p }); } });
const ask = (q) => new Promise((r) => { waiting.push(r); w.stdin.write(JSON.stringify(q) + '\n'); });
await ask({ op: 'open', path: '/captures/ctf-sigid-sigid.sigmf-data', rate: 500000 });
for (const [label, margin] of [['one 16 s pass', 0.03], ['0.25 s blocks, 1 s margin', 1.0]]) {
  let lr;
  if (label.startsWith('one')) lr = (await ask({ op: 'block', center: -140000, t0: 8, seconds: 16, margin })).p;
  else { const parts = []; for (let k = 0; k < 64; k++) parts.push((await ask({ op: 'block', center: -140000, t0: 8 + k * 0.25, seconds: 0.25, margin })).p);
    lr = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { lr.set(p, o); o += p.length; } }
  for (const [c, side] of [[0, 'left'], [1, 'right']]) {
    const ch = new Float32Array(lr.length / 2); for (let i = 0; i < ch.length; i++) ch[i] = lr[i * 2 + c];
    const out = await run('ext.whisper', { data: ch, kind: 'real', sampleRate: 50000, params: {} });
    console.log(`${label.padEnd(26)} ${side.padEnd(5)}: ${out.records.map((r) => r.text).join(' ') || '(nothing)'}`);
  }
}
await ask({ op: 'stop' }); process.exit(0);
