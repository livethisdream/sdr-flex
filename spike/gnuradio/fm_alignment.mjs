import { GrWorker } from '/app/server/gr/worker.js';
import * as dsp from '/app/web/src/dsp.js';
import { demodulate } from '/app/web/src/engine.js';
import { FileCapture } from '/app/server/filecapture.js';
const path = '/captures/ctf-sigid-sigid.sigmf-data', fs = 500_000;
const cap = new FileCapture({ path, format: 'cf32', sampleRate: fs, centerHz: 0, label: 'x' });
const w = new GrWorker();
const offset = -140_000, width = 200_000, decim = dsp.chooseDecimation(fs, width * 1.25), taps = dsp.lowPassTaps(65, width / 2, fs);
const fsOut = fs / decim, scale = 1 / 75_000, count = 4000, k0 = 500_000;
// JS: tuner outputs k0-1 .. k0+count-1, then the discriminator, scaled as DETECTORS does.
const need = (count + 1) * decim + taps.length, start = (k0 - 1) * decim - taps.length;
const iq = dsp.xlateFilterDecimate(cap.read(start, need), taps, offset, fs, decim, count + 1, (-2 * Math.PI * offset * start / fs) % (2 * Math.PI)).samples;
const f = dsp.fmDiscriminate(iq, count + 1, fsOut);
const js = Float32Array.from({ length: count }, (_, i) => f[i + 1] * scale);
const { bytes } = await w.request({ op: 'fm', path, format: 'cf32', rate: fs, k0, count, taps: Array.from(taps), decim, offset, scale });
const gr = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
let best = null;
for (let sh = -5; sh <= 5; sh++) { let e = 0, n = 0; for (let i = 20; i < count - 20; i++) { e += (gr[i + sh] - js[i]) ** 2; n++; } if (!best || e < best.e) best = { sh, e: Math.sqrt(e / n) }; }
const rms = Math.sqrt(js.reduce((s, v) => s + v * v, 0) / count), rmsg = Math.sqrt(gr.reduce((s, v) => s + v * v, 0) / count);
console.log(`JS rms ${rms.toFixed(4)}, GR rms ${rmsg.toFixed(4)}, best shift ${best.sh}, rms error there ${best.e.toExponential(2)}; first values js ${Array.from(js.slice(0, 4), (v) => v.toFixed(3))} gr ${Array.from(gr.slice(0, 4), (v) => v.toFixed(3))}`);
w.stop();
