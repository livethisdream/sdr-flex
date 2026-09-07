// The export path, checked where it can be checked without a browser: the resampler
// and the WAV writer. These are the two places an error is silent — a decoder fed a
// subtly wrong file reports "no packets", which reads as a bad signal rather than a
// bad export, and that is a debugging afternoon.
//
//   node web/test/export.test.mjs

import * as dsp from '../src/dsp.js';
import { resample, normalize, wav, sigmfMeta, AUDIO_RATES } from '../src/export.js';

let failed = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) failed++; };

const tone = (hz, rate, n) => {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / rate);
  return x;
};
const peak = (x, rate) => {
  const n = 8192, buf = new Float32Array(n * 2);
  for (let i = 0; i < n && i < x.length; i++) buf[i * 2] = x[i];
  const sp = dsp.spectrum(buf, n, 'Hann');
  let best = -Infinity, at = 0;
  for (let i = n / 2 + 2; i < n; i++) if (sp[i] > best) { best = sp[i]; at = i; }
  return { hz: (at - n / 2) * (rate / n), db: best };
};

// ── the resampler keeps the frequency and leaves no images ──────────────────
for (const [from, to] of [[20000, 22050], [48000, 22050], [8000, 48000], [15625, 22050], [22050, 22050]]) {
  const x = tone(1200, from, from);                 // one second of a 1200 Hz mark tone
  const y = resample(x, from, to);
  const p = peak(y, to);
  ok(Math.abs(y.length - x.length * (to / from)) <= 1, `${from}→${to}: ${y.length} samples out`);
  ok(Math.abs(p.hz - 1200) < to / 8192 * 2, `${from}→${to}: the 1200 Hz tone comes out at ${p.hz.toFixed(0)} Hz`);
  // an image from bad interpolation would show up as a second peak well above the floor
  const n = 8192, buf = new Float32Array(n * 2);
  for (let i = 0; i < n && i < y.length; i++) buf[i * 2] = y[i];
  const sp = dsp.spectrum(buf, n, 'Hann');
  let second = -Infinity;
  for (let i = n / 2 + 2; i < n; i++) {
    const hz = (i - n / 2) * (to / n);
    if (Math.abs(hz - 1200) < 80) continue;
    if (sp[i] > second) second = sp[i];
  }
  ok(p.db - second > 35, `${from}→${to}: nothing else within ${(p.db - second).toFixed(0)} dB of the tone`);
}

// ── decimation actually band-limits, rather than folding ────────────────────
{
  // 9 kHz at 48 kS/s must not come back as an alias when resampled to 8 kHz
  const x = tone(9000, 48000, 48000);
  const y = resample(x, 48000, 8000);
  let e = 0;
  for (let i = 200; i < y.length; i++) e += y[i] * y[i];
  const rms = Math.sqrt(e / (y.length - 200));
  ok(rms < 0.02, `content above the new Nyquist is filtered, not folded (residual rms ${rms.toFixed(4)})`);
}

// ── normalize ───────────────────────────────────────────────────────────────
{
  const x = new Float32Array([0.4, 0.6, 0.5, 0.45]);        // sits on a pedestal
  const y = normalize(x);
  let mx = 0, sum = 0;
  for (const v of y) { mx = Math.max(mx, Math.abs(v)); sum += v; }
  ok(Math.abs(mx - 0.89) < 1e-5, `peak lands at ${mx.toFixed(3)}, under full scale`);
  ok(Math.abs(sum / y.length) < 1e-6, 'and the DC pedestal is gone');
}

// ── the WAV header is one a decoder will actually accept ────────────────────
{
  const blob = wav(tone(1000, 22050, 2205), 22050);
  const v = new DataView(await blob.arrayBuffer());
  const str = (o, n) => String.fromCharCode(...Array.from({ length: n }, (_, i) => v.getUint8(o + i)));
  ok(str(0, 4) === 'RIFF' && str(8, 4) === 'WAVE' && str(12, 4) === 'fmt ' && str(36, 4) === 'data',
     'RIFF/WAVE/fmt/data chunks in the right places');
  ok(v.getUint16(20, true) === 1 && v.getUint16(22, true) === 1 && v.getUint16(34, true) === 16,
     'PCM, mono, 16-bit');
  ok(v.getUint32(24, true) === 22050 && v.getUint32(28, true) === 44100 && v.getUint16(32, true) === 2,
     'rate 22050, byte rate 44100, block align 2 — the fields sox checks');
  ok(v.getUint32(4, true) === 36 + 2205 * 2 && v.getUint32(40, true) === 2205 * 2,
     'and the two length fields agree with the payload');
}

// ── the sidecar says where the samples came from ────────────────────────────
{
  const m = JSON.parse(await sigmfMeta({ sampleRate: 22050, centerHz: 433.92e6, label: 'A · Tuner',
                                         from: 'sigid', chain: 'sigid > Tuner', startS: 1.5 }).text());
  ok(m.global['core:datatype'] === 'cf32_le' && m.global['core:sample_rate'] === 22050,
     'SigMF global carries datatype and rate');
  ok(m.captures[0]['core:frequency'] === 433.92e6 && m.captures[0]['core:datetime_offset_s'] === 1.5,
     'the capture block carries the center and where in the parent it started');
  ok(m.global['sdrflex:source'] === 'sigid' && /Tuner/.test(m.global['sdrflex:chain']),
     'and the provenance says which capture and which chain produced it');
}

ok(AUDIO_RATES.includes(22050) && AUDIO_RATES.includes(48000),
   `offered rates ${AUDIO_RATES.join(', ')} cover multimon-ng and direwolf`);

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
