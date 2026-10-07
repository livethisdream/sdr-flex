import fs from 'node:fs';
import * as dsp from '/app/web/src/dsp.js';
const FS = 250_000;
const amp = (x, fs, hz, stride, off, pad) => { let re = 0, im = 0, n = 0; for (let i = pad; i < x.length / stride - pad; i++) { const a = 2 * Math.PI * hz * i / fs; re += x[i * stride + off] * Math.cos(a); im += x[i * stride + off] * Math.sin(a); n++; } return 2 * Math.hypot(re, im) / n; };
for (const conv of ['standard', 'sigid']) {
  const m = new Float32Array(fs.readFileSync(`/tmp/spike/mpx_${conv}.f32`).buffer.slice(0));
  const r = dsp.stereoDecode(m, m.length, FS, { deemphasisUs: 75, stereo: true, decimate: 5 });
  const fsOut = r.sampleRate, pad = Math.round(fsOut * 0.1);
  const s = Math.min(20 * Math.log10(amp(r.data, fsOut, 400, 2, 0, pad) / amp(r.data, fsOut, 3000, 2, 0, pad)),
                     20 * Math.log10(amp(r.data, fsOut, 3000, 2, 1, pad) / amp(r.data, fsOut, 400, 2, 1, pad)));
  console.log(`${conv.padEnd(9)} JS engine separation ${s.toFixed(1)} dB`);
}
