// GNU Radio stereo from the worker: separation on a standard signal by run-in, and alignment
// against the JS decoder on the L+R sum, which does not depend on the subcarrier's phase.
import fs from 'node:fs';
import { GrWorker } from '/app/server/gr/worker.js';
import * as dsp from '/app/web/src/dsp.js';
import { MockEngine } from '/app/web/src/engine.js';
import { FileCapture } from '/app/server/filecapture.js';
const FS = 500_000, N = FS * 3, file = '/tmp/stereo_std.cf32';
{ const buf = Buffer.alloc(N * 8); let ph = 0;
  for (let i = 0; i < N; i++) { const t = i / FS, L = Math.sin(2 * Math.PI * 400 * t), R = Math.sin(2 * Math.PI * 3000 * t);
    const th = 2 * Math.PI * 19000 * t, mpx = 0.45 * (L + R) / 2 + 0.09 * Math.sin(th) + 0.45 * (L - R) / 2 * Math.sin(2 * th);
    ph += 2 * Math.PI * 75_000 * mpx / FS; buf.writeFloatLE(0.5 * Math.cos(ph), i * 8); buf.writeFloatLE(0.5 * Math.sin(ph), i * 8 + 4); }
  fs.writeFileSync(file, buf); }
const decim = dsp.chooseDecimation(FS, 200_000 * 1.25), taps = dsp.lowPassTaps(65, 100_000, FS), fsFm = FS / decim, d = dsp.stereoDecimation(fsFm), fsA = fsFm / d;
const amp = (x, off, hz) => { let re = 0, im = 0, n = 0; for (let i = off; i < x.length; i += 2) { const a = 2 * Math.PI * hz * n / fsA; re += x[i] * Math.cos(a); im += x[i] * Math.sin(a); n++; } return 2 * Math.hypot(re, im) / n; };
const sep = (x) => Math.min(20 * Math.log10(amp(x, 0, 400) / amp(x, 0, 3000)), 20 * Math.log10(amp(x, 1, 3000) / amp(x, 1, 400)));
const w = new GrWorker();
const base = { op: 'stereo', path: file, format: 'cf32', rate: FS, taps: Array.from(taps), decim, offset: 0, scale: 1 / 75_000, audio_decim: d, mode: 'stereo', deemph_us: 0 };
const count = Math.round(0.25 * fsA), k0 = Math.round(1.2 * fsA);
for (const [width, nt, emph] of [[200_000, 65, 0], [200_000, 65, 75], [240_000, 65, 0], [240_000, 129, 0], [280_000, 129, 0]]) {
  const dc = dsp.chooseDecimation(FS, width * 1.25), tp = dsp.lowPassTaps(nt, width / 2, FS), ff = FS / dc, dd = dsp.stereoDecimation(ff);
  const { bytes } = await w.request({ ...base, taps: Array.from(tp), decim: dc, audio_decim: dd, deemph_us: emph, k0: Math.round(1.2 * ff / dd), count: Math.round(0.25 * ff / dd), runin_s: 0.02 });
  const x = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  const fa = ff / dd;
  const am = (off, hz) => { let re = 0, im = 0, n = 0; for (let i = off; i < x.length; i += 2) { const a = 2 * Math.PI * hz * n / fa; re += x[i] * Math.cos(a); im += x[i] * Math.sin(a); n++; } return 2 * Math.hypot(re, im) / n; };
  const sp = Math.min(20 * Math.log10(am(0, 400) / am(0, 3000)), 20 * Math.log10(am(1, 3000) / am(1, 400)));
  console.log(`tuner ${width / 1e3} kHz, ${nt} taps, decim ${dc}; de-emphasis ${emph} us: separation ${sp.toFixed(1)} dB`);
}
w.stop();
