// Reading somebody else's file, checked the way ADR-0025 asks: a known signal in, the
// same answer out of every format. The capture is generated here rather than committed
// — it is a synthetic fixture, not a golden one, and 30 MB of IQ does not belong in a
// repository. Golden captures arrive with the real decoders.
//
//   node web/test/capture.test.mjs

import * as dsp from '../src/dsp.js';
import { Capture, FORMATS, guessFormat, guessFromName, fromFiles } from '../src/capture.js';

let failed = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) failed++; };

const FS = 1_000_000, N = 200_000, TONE = 40_000;
const ref = new Float32Array(N * 2);
for (let i = 0; i < N; i++) {
  const w = (2 * Math.PI * TONE * i) / FS;
  ref[i * 2] = 0.6 * Math.cos(w);
  ref[i * 2 + 1] = 0.6 * Math.sin(w);
}

/** The same samples, written the way each capture format writes them. */
function encode(format) {
  const bps = FORMATS[format].bps;
  const buf = new ArrayBuffer(N * bps);
  const v = new DataView(buf);
  for (let i = 0; i < N; i++) {
    const re = ref[i * 2], im = ref[i * 2 + 1];
    if (format === 'cf32') { v.setFloat32(i * 8, re, true); v.setFloat32(i * 8 + 4, im, true); }
    else if (format === 'cs16') { v.setInt16(i * 4, Math.round(re * 32767), true); v.setInt16(i * 4 + 2, Math.round(im * 32767), true); }
    else if (format === 'cs8') { v.setInt8(i * 2, Math.round(re * 127)); v.setInt8(i * 2 + 1, Math.round(im * 127)); }
    else { v.setUint8(i * 2, Math.round(re * 127.5 + 127.5)); v.setUint8(i * 2 + 1, Math.round(im * 127.5 + 127.5)); }
  }
  return buf;
}

const peakHz = (iq, n, fs) => {
  const sp = dsp.spectrum(iq, n, 'Hann');
  let best = -Infinity, at = 0;
  for (let i = 0; i < n; i++) if (sp[i] > best) { best = sp[i]; at = i; }
  return { hz: (at - n / 2) * (fs / n), db: best };
};

// ── every format reads back the same signal ─────────────────────────────────
for (const format of Object.keys(FORMATS)) {
  const c = new Capture({ buffer: encode(format), format, sampleRate: FS, centerHz: 0, label: format });
  const p = peakHz(c.read(1000, 4096), 4096, FS);
  ok(c.samples === N && Math.abs(c.durationS - N / FS) < 1e-9,
     `${format}: ${c.samples} samples, ${c.durationS.toFixed(3)} s`);
  ok(Math.abs(p.hz - TONE) < FS / 4096, `${format}: the tone comes back at ${(p.hz / 1e3).toFixed(1)} kHz (want 40)`);
  ok(p.db > -20, `${format}: at ${p.db.toFixed(1)} dB, so the scaling survived the round trip`);
}

// ── reading past the end is silence, not a fault ────────────────────────────
{
  const c = new Capture({ buffer: encode('cu8'), format: 'cu8', sampleRate: FS, centerHz: 0, label: 'x' });
  const tail = c.read(N - 100, 4096);
  ok(tail.length === 8192, 'a window running off the end still comes back the size it asked for');
  let e = 0;
  for (let i = 300 * 2; i < tail.length; i++) e += Math.abs(tail[i]);
  ok(e === 0, 'and it is zeros past the last sample rather than wrapped or garbage');
}

// ── the window cache hands out a view of the same numbers ───────────────────
{
  const c = new Capture({ buffer: encode('cf32'), format: 'cf32', sampleRate: FS, centerHz: 0, label: 'x' });
  const a = Array.from(c.read(5000, 64));
  c.read(900_00, 64);                      // force a different window
  const b = Array.from(c.read(5000, 64));
  ok(a.join() === b.join(), 'the same window reads the same twice, cached or not');
}

// ── filenames, which are the only metadata most captures have ───────────────
ok(guessFormat('grab.cu8') === 'cu8' && guessFormat('x.cf32') === 'cf32' &&
   guessFormat('y.sc16') === 'cs16' && guessFormat('z.cs8') === 'cs8',
   'extensions map to formats');
{
  const g = guessFromName('gqrx_20240110_433920000Hz_2400000sps.raw');
  ok(g.centerHz === 433920000 && g.sampleRate === 2400000,
     `a gqrx filename yields ${g.centerHz} Hz at ${g.sampleRate} S/s`);
  const h = guessFromName('capture_433.92MHz_1000kSps.cf32');
  ok(Math.abs(h.centerHz - 433.92e6) < 1 && h.sampleRate === 1e6,
     `an rtl_433 filename yields ${h.centerHz} Hz at ${h.sampleRate} S/s`);
}

// ── SigMF beats the filename, which is the point of SigMF ───────────────────
{
  const data = encode('cf32');
  const meta = JSON.stringify({
    global: { 'core:datatype': 'cf32_le', 'core:sample_rate': FS },
    captures: [{ 'core:sample_start': 0, 'core:frequency': 433_920_000 }],
  });
  // a deliberately misleading pair: the data file's name says cu8 at 2.4 MS/s
  const files = [
    { name: 'chal.sigmf-meta', text: async () => meta },
    { name: 'chal.sigmf-data', arrayBuffer: async () => data },
  ];
  const c = await fromFiles(files);
  ok(c.format === 'cf32' && c.sampleRate === FS && c.centerHz === 433_920_000 && !!c.meta,
     `SigMF wins: ${c.format} at ${c.sampleRate} S/s, centered ${c.centerHz} Hz`);
}
{
  const bad = [{ name: 'x.sigmf-meta', text: async () => JSON.stringify({ global: { 'core:datatype': 'rf64_le' } }) },
               { name: 'x.sigmf-data', arrayBuffer: async () => new ArrayBuffer(16) }];
  let msg = '';
  try { await fromFiles(bad); } catch (e) { msg = e.message; }
  ok(/rf64_le/.test(msg), `an unreadable datatype is refused by name: "${msg}"`);
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
