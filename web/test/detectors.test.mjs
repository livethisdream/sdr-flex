// The first piece of ADR-0025's gate, at the size M0 can carry it: the synthetic
// scene stands in for the golden capture, and every detector has to reach the right
// answer from it *with its estimator*, not with parameters handed over by the test.
//
//   node web/test/detectors.test.mjs
//
// No browser and no dependencies — this is the check that should be cheap enough to
// run on every commit. The browser-driven UI checks are a separate, slower thing.

import * as scene from '../src/scene.js';
import * as dsp from '../src/dsp.js';
import * as dtmf from '../plugins/dtmf.js';

const FS = scene.SOURCE.sampleRate;
let failed = 0;
const ok = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed++; };
const near = (v, want, tol) => Math.abs(v - want) <= tol;

/** Tune a channel the way the app does: translate, filter, decimate. */
function tune(offsetHz, widthHz, seconds, tStart = 0.5) {
  const decim = dsp.chooseDecimation(FS, widthHz * 1.25);
  const rate = FS / decim;
  const taps = dsp.lowPassTaps(65, widthHz / 2, FS);
  const count = Math.floor(rate * seconds);
  const src = scene.read(Math.floor(tStart * FS), count * decim + taps.length);
  return { iq: dsp.xlateFilterDecimate(src, taps, offsetHz, FS, decim, count).samples, rate, count };
}

/** Dominant positive frequency of a real-valued signal. */
function tone(x, fs) {
  const n = 4096, buf = new Float32Array(n * 2);
  for (let i = 0; i < n && i < x.length; i++) buf[i * 2] = x[i];
  const sp = dsp.spectrum(buf, n, 'Hann');
  let best = -Infinity, at = n / 2;
  for (let i = n / 2 + 3; i < n; i++) if (sp[i] > best) { best = sp[i]; at = i; }
  return (at - n / 2) * (fs / n);
}

/** Amplitude of one known frequency in a real signal, by direct correlation. */
function amplitudeAt(x, fs, f) {
  let re = 0, im = 0;
  const n = x.length;
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * f * i) / fs;
    re += x[i] * Math.cos(a);
    im += x[i] * Math.sin(a);
  }
  return (2 * Math.hypot(re, im)) / n;
}

/** Mean power of a real signal between two frequencies, over Hann-windowed frames. */
function bandPower(x, fs, f0, f1) {
  const n = 8192, buf = new Float32Array(n * 2);
  let sum = 0;
  for (let at = 0; at + n <= x.length; at += n) {
    for (let i = 0; i < n; i++) buf[i * 2] = x[at + i];
    const sp = dsp.spectrum(buf, n, 'Hann');
    for (let k = Math.ceil(f0 * n / fs); k <= f1 * n / fs; k++) sum += Math.pow(10, sp[n / 2 + k] / 10);
  }
  return sum;
}

const power = (x, from = 0) => {
  let s = 0;
  for (let i = from; i < x.length; i++) s += x[i] * x[i];
  return 10 * Math.log10(s / Math.max(1, x.length - from) + 1e-20);
};

// ── NBFM: the touch-tones the scene sends, read back by the DTMF decoder ─────
{
  // One whole repeat, so every digit is in it whatever the phase.
  const t = tune(-140_000, 16_000, 2.6, 0);
  const d = dsp.estimateDeviation(t.iq, t.count, t.rate);
  ok(d.confident, `FM: estimator is confident on a modulated carrier (${d.value.toFixed(0)} Hz)`);
  ok(d.value > 1500 && d.value < 3300, `FM: deviation ${d.value.toFixed(0)} Hz, near the ±3 kHz the digits use`);
  const f = dsp.fmDiscriminate(t.iq, t.count, t.rate);
  const read = dtmf.decode(f, {}, { sampleRate: t.rate, count: t.count }).map((r) => r.text).join('');
  ok(read.includes(scene.DIGITS), `FM: the DTMF decoder reads ${scene.DIGITS} (got "${read}")`);
}

// ── WBFM, and the de-emphasis Listen does ──────────────────────────────────
//
// The scene's station speaks, and a broadcast transmitter pre-emphasizes, so off the demod
// the voice has more treble than it was spoken with. Listen's de-emphasis gives back the
// voice's own balance of treble to bass, measured against the voice as spoken.
{
  const t = tune(scene.WFM_INFO.offsetHz, 200_000, 1.0, 0.6);
  const d = dsp.estimateDeviation(t.iq, t.count, t.rate);
  ok(d.confident && d.value > 30_000,
     `WBFM: deviation ${(d.value / 1000).toFixed(1)} kHz, confident (want tens of kHz, not units)`);
  // Wideband is not a label here, it is a measurement: this has to be an order of
  // magnitude past the narrowband one or the scene has two of the same signal.
  const narrow = tune(-140_000, 16_000, 0.4);
  const dn = dsp.estimateDeviation(narrow.iq, narrow.count, narrow.rate);
  ok(d.value > dn.value * 10,
     `WBFM: ${(d.value / 1000).toFixed(0)} kHz against NBFM's ${(dn.value / 1000).toFixed(1)} kHz`);

  const audio = dsp.fmDiscriminate(t.iq, t.count, t.rate);
  const spoken = Float32Array.from({ length: t.count }, (_, i) => scene.broadcastAudio(0.6 + i / t.rate));
  const tilt = (x) => 10 * Math.log10(bandPower(x, t.rate, 2_500, 4_500) / bandPower(x, t.rate, 200, 1_000));
  const pilot = amplitudeAt(audio, t.rate, scene.WFM_INFO.pilotHz);
  ok(pilot > 0.03, `WBFM: the ${scene.WFM_INFO.pilotHz / 1000} kHz pilot is there (${pilot.toFixed(3)})`);
  // Off the demod the composite is still pre-emphasized, as it must be for the stereo
  // decoder and RDS behind it; Listen undoes it at the ear.
  const sent = tilt(audio) - tilt(spoken);
  ok(sent > 4, `WBFM: off the demod, the voice's treble is ${sent.toFixed(1)} dB up on how it was spoken, as sent`);
  const heard = tilt(dsp.deemphasis(audio, t.rate, scene.WFM_INFO.deemphasisUs * 1e-6)) - tilt(spoken);
  ok(near(heard, 0, 1), `WBFM: de-emphasized at 75 µs, the voice's balance comes back (${heard.toFixed(2)} dB)`);
}

// ── the estimators must decline, not guess, on empty spectrum ───────────────
{
  // Nothing transmits here, and the window stops before the OOK burst at 0.9 s, whose
  // splatter reaches this far now that it carries a word.
  const t = tune(10_000, 16_000, 0.35);
  ok(!dsp.estimateDeviation(t.iq, t.count, t.rate).confident, 'noise: FM deviation is not claimed as confident');
  ok(!dsp.estimateSideband(t.iq, t.count).confident, 'noise: sideband is not claimed as confident');
  ok(!dsp.estimateCarrierOffset(t.iq, t.count, t.rate).confident, 'noise: carrier offset is not claimed as confident');
}

// ── AM → PWM, end to end, from the estimators alone ────────────────────────
{
  const t = tune(-25_000, 50_000, 1.05, 0.4);
  const env = dsp.smooth(dsp.amEnvelope(t.iq, t.count), dsp.envelopeWindow(t.rate));
  const th = dsp.otsuThreshold(env);
  const sym = dsp.estimateSymbolPeriod(env, th.value, t.rate);
  ok(sym.confident && near(sym.value, scene.SYMBOL_US, 30), `OOK: symbol period ${sym.value.toFixed(0)} µs (want ${scene.SYMBOL_US})`);
  const want = scene.PAYLOAD.map((b) => b.toString(16).padStart(2, '0')).join(' ');
  const got = dsp.pwmSlice(env, th.value, t.rate, sym.value).map((g) =>
    Array.from({ length: Math.floor(g.bits.length / 8) }, (_, k) =>
      g.bits.slice(k * 8, k * 8 + 8).reduce((a, b) => (a << 1) | b, 0).toString(16).padStart(2, '0')).join(' '));
  ok(got.includes(want), `OOK: recovers ${want} from the estimators alone (got ${JSON.stringify(got)})`);
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
