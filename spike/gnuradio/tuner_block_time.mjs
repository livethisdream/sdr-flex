import { GrWorker } from '/app/server/gr/worker.js';
import * as dsp from '/app/web/src/dsp.js';
import { FileCapture } from '/app/server/filecapture.js';
const path = '/captures/ctf-sigid-sigid.sigmf-data', fs = 500_000;
const w = new GrWorker(); await w.start();
const decim = dsp.chooseDecimation(fs, 200_000 * 1.25), taps = dsp.lowPassTaps(65, 100_000, fs), B = Math.round(0.25 * fs / decim);
const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const grT = [];
for (let j = 40; j < 52; j++) { const t = performance.now(); await w.request({ op: 'tuner', path, format: 'cf32', rate: fs, k0: j * B, count: B, taps: Array.from(taps), decim, offset: -140_000 }); grT.push(performance.now() - t); }
const cap = new FileCapture({ path, format: 'cf32', sampleRate: fs, centerHz: 0, label: 'x' });
const jsT = [];
for (let j = 40; j < 52; j++) { const t = performance.now(); const start = j * B * decim - taps.length; const iq = cap.read(start, B * decim + taps.length);
  dsp.xlateFilterDecimate(iq, taps, -140_000, fs, decim, B, 0); jsT.push(performance.now() - t); }
console.log(`0.25 s WBFM tuner block (${B} samples out): GNU Radio ${med(grT).toFixed(1)} ms median (min ${Math.min(...grT).toFixed(1)}), JS ${med(jsT).toFixed(1)} ms median`);
w.stop();
