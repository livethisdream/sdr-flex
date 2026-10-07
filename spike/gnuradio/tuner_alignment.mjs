// Measure how GNU Radio's tuner output lines up with the JS tuner's, on the same input.
import { GrWorker } from '/app/server/gr/worker.js';
import * as dsp from '/app/web/src/dsp.js';
import { FileCapture } from '/app/server/filecapture.js';
const path = '/captures/ctf-sigid-sigid.sigmf-data', fs = 500_000;
const cap = new FileCapture({ path, format: 'cf32', sampleRate: fs, centerHz: 0, label: 'x' });
const w = new GrWorker({ log: (m) => console.error(m) }); console.error("starting");
for (const [offset, width, nt] of [[-140_000, 200_000, 65], [-20_000, 5_000, 65], [-20_000, 5_000, 101], [37_123.5, 12_000, 33]]) {
  const decim = dsp.chooseDecimation(fs, width * 1.25);
  const taps = dsp.lowPassTaps(nt, width / 2, fs);
  const count = 4000;
  for (const k0 of [Math.floor(1_000_000 / decim), Math.floor(1_000_037 / decim) + 1, Math.floor(7_654_321 / decim)]) {
    const start = k0 * decim - taps.length;
    // JS: the window xlateFilterDecimate is handed, phase anchored to the capture's sample `start`.
    const need = count * decim + taps.length;
    const iq = cap.read(start, need);
    const startPhase = (-2 * Math.PI * offset * (start / fs)) % (2 * Math.PI);
    const js = dsp.xlateFilterDecimate(iq, taps, offset, fs, decim, count, startPhase).samples;
    console.error("req", offset, start); const { bytes } = await w.request({ op: 'tuner', path, format: 'cf32', rate: fs, k0, count, taps: Array.from(taps), decim, offset });
    const gr = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
    // Best shift and the constant phase between them, and what is left after both.
    let best = null;
    for (let sh = -40; sh <= 40; sh++) {
      let re = 0, im = 0, pj = 0, pg = 0;
      for (let i = 100; i < count - 100; i++) {
        const a = [js[i * 2], js[i * 2 + 1]], b = [gr[(i + sh) * 2], gr[(i + sh) * 2 + 1]];
        re += b[0] * a[0] + b[1] * a[1]; im += b[1] * a[0] - b[0] * a[1]; pj += a[0] ** 2 + a[1] ** 2; pg += b[0] ** 2 + b[1] ** 2;
      }
      const c = Math.hypot(re, im) / Math.sqrt(pj * pg);
      if (!best || c > best.c) best = { sh, c, theta: Math.atan2(im, re), gain: Math.sqrt(pg / pj) };
    }
    const expected = ((2 * Math.PI * offset * start / fs) % (2 * Math.PI));
    console.log(`offset ${offset} decim ${decim} taps ${nt} k0 ${k0}: shift ${best.sh}, correlation ${best.c.toFixed(6)}, gain ${best.gain.toFixed(4)}, phase ${best.theta.toFixed(5)} rad`);
  }
}
w.stop();
