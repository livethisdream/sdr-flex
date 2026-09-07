// The NRZ slicer and the plugin loader, on synthetic data with a known answer.
// The end-to-end run against a real challenge lives in the browser tests; this is the
// part that should be cheap enough to run on every commit.
//
//   node web/test/slicer.test.mjs

import * as dsp from '../src/dsp.js';
import * as plugins from '../src/plugins.js';

let failed = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) failed++; };

const FS = 64000, BAUD = 8000, SPS = FS / BAUD;
const PAYLOAD = [0xaa, 0xaa, 0xff, 0xff, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc];

/** Rectangular OOK, MSB-first, with lead-in silence and a little noise. */
function modulate(bytes, { lead = 137, snr = 0.02, offsetPhase = 0 } = {}) {
  const bits = [];
  for (const b of bytes) for (let k = 7; k >= 0; k--) bits.push((b >> k) & 1);
  const env = new Float32Array(lead + bits.length * SPS + 400);
  for (let i = 0; i < bits.length; i++) {
    for (let s = 0; s < SPS; s++) env[lead + i * SPS + s] = bits[i];
  }
  for (let i = 0; i < env.length; i++) env[i] += (Math.random() - 0.5) * snr;
  return env;
}

// ── the symbol rate comes out of the data ───────────────────────────────────
{
  const env = modulate(PAYLOAD);
  const otsu = dsp.otsuThreshold(env);
  const sym = dsp.estimateNrzSymbol(env, otsu.value, FS);
  ok(Math.abs(sym.value - 125) < 1, `symbol period ${sym.value.toFixed(2)} µs (want 125 = ${BAUD} baud)`);
  ok(sym.confident, `and it is confident: ${(sym.agreement * 100).toFixed(0)}% of ${sym.runs} runs are multiples`);
}

// ── bytes come back, with the sync word finding the boundary ────────────────
{
  const env = modulate(PAYLOAD);
  const otsu = dsp.otsuThreshold(env);
  const r = dsp.nrzSlice(env, otsu.value, FS, 125, { syncBits: dsp.syncBitsOf('ffff') });
  const got = [...r.bytes.subarray(0, 6)];
  ok(r.syncAt >= 0, `sync word found at bit ${r.syncAt}`);
  ok(got.join(',') === PAYLOAD.slice(4).join(','),
     `bytes after the sync are ${got.map((v) => v.toString(16)).join(' ')} (want 12 34 56 78 9a bc)`);
}

// ── a lead-in that is not a whole number of symbols still works ─────────────
{
  // this is the case the sync word exists for: the grid is right, the byte
  // boundary is not, and only a sync word can tell you where it is
  for (const lead of [0, 3, 137, 999]) {
    const env = modulate(PAYLOAD, { lead });
    const otsu = dsp.otsuThreshold(env);
    const r = dsp.nrzSlice(env, otsu.value, FS, 125, { syncBits: dsp.syncBitsOf('ffff') });
    const got = [...r.bytes.subarray(0, 6)].join(',');
    ok(got === PAYLOAD.slice(4).join(','), `lead-in of ${lead} samples: still recovers the payload`);
  }
}

// ── bit order is a real choice and reading it wrong is silent ───────────────
{
  // 0x01 MSB-first is 0000_0001 on the wire; read LSB-first the same wire bits
  // are 0x80. Nothing about the signal says which is right, which is exactly why
  // it is a parameter and why getting it wrong "demodulates cleanly to the wrong
  // bytes" rather than failing.
  const body = [0x01, 0x02, 0x04, 0x81];
  const env = modulate([0xaa, 0xaa, 0xff, 0xff, ...body]);
  const otsu = dsp.otsuThreshold(env);
  const sync = dsp.syncBitsOf('ffff');
  const msb = dsp.nrzSlice(env, otsu.value, FS, 125, { msbFirst: true, syncBits: sync });
  const lsb = dsp.nrzSlice(env, otsu.value, FS, 125, { msbFirst: false, syncBits: sync });
  const hex = (a, n) => [...a.subarray(0, n)].map((v) => v.toString(16).padStart(2, '0')).join(' ');
  ok(hex(msb.bytes, 4) === '01 02 04 81', `MSB-first: ${hex(msb.bytes, 4)} (want 01 02 04 81)`);
  ok(hex(lsb.bytes, 4) === '80 40 20 81', `LSB-first on the same wire: ${hex(lsb.bytes, 4)} (want 80 40 20 81)`);
}

// ── the loader validates rather than trusting ───────────────────────────────
{
  const bad = [
    ['export function decode(){}', 'no manifest export'],
    ['export const manifest = { name: "x", in: "bytes", out: "events" }; export function decode(){}', 'manifest.id'],
    ['export const manifest = { id: "a.b", in: "bytes", out: "events" }; export function decode(){}', 'manifest.name'],
    ['export const manifest = { id: "a.b", name: "x" }; export function decode(){}', 'manifest.in'],
    ['export const manifest = { id: "a.b", name: "x", in: "bytes", out: "events" };', 'no decode()'],
    ['export const manifest = { id: "a.b", name: "x", in: "bytes", out: "events", params: [{ id: "p" }] }; export function decode(){}', 'no default'],
  ];
  for (const [src, want] of bad) {
    let msg = '';
    try { await plugins.loadSource(src, 'bad.js'); } catch (e) { msg = e.message; }
    ok(msg.includes(want), `refused: "${msg}"`);
  }
}

// ── a good one loads, filters by type, and runs ─────────────────────────────
{
  const src = `
    export const manifest = { id: 'test.rev', name: 'Reverse', in: 'bytes', out: 'events',
                              params: [{ id: 'n', default: 2 }] };
    export function decode(bytes, p) {
      return [...bytes].slice(0, p.n).reverse().map((v) => ({ text: 'b' + v }));
    }`;
  const p = await plugins.loadSource(src, 'rev.js');
  ok(p.id === 'test.rev' && p.in === 'bytes', `loaded ${p.name}`);
  ok(plugins.forKind('bytes').some((x) => x.id === 'test.rev'), 'offered on a bytes node');
  ok(!plugins.forKind('iq').some((x) => x.id === 'test.rev'), 'and not on an iq node');
  const r = plugins.run('test.rev', new Uint8Array([7, 8, 9]), { n: 2 });
  ok(r.records.length === 2 && r.records[0].text === 'b8', `ran: ${JSON.stringify(r.records.map((x) => x.text))}`);
}

// ── a plugin that throws is a result, not a crash ───────────────────────────
{
  await plugins.loadSource(
    `export const manifest = { id: 'test.boom', name: 'Boom', in: 'bytes', out: 'events' };
     export function decode() { throw new Error('nope'); }`, 'boom.js');
  const r = plugins.run('test.boom', new Uint8Array(4), {});
  ok(r.records.length === 0 && /nope/.test(r.error), `a throw becomes an error record: "${r.error}"`);
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
