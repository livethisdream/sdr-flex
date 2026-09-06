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

const power = (x, from = 0) => {
  let s = 0;
  for (let i = from; i < x.length; i++) s += x[i] * x[i];
  return 10 * Math.log10(s / Math.max(1, x.length - from) + 1e-20);
};

// ── FM ──────────────────────────────────────────────────────────────────────
{
  const t = tune(60_000, 16_000, 0.5);
  const d = dsp.estimateDeviation(t.iq, t.count, t.rate);
  // The scene's modulation depth warbles between 0.3 and 1.0 of ±3 kHz, so the
  // honest answer moves. What must hold is that it is in range and confident.
  ok(d.confident, `FM: estimator is confident on a modulated carrier (${d.value.toFixed(0)} Hz)`);
  ok(d.value > 800 && d.value < 3300, `FM: deviation ${d.value.toFixed(0)} Hz within the warble's 900–3000 Hz range`);
  const f = dsp.fmDiscriminate(t.iq, t.count, t.rate);
  ok(near(tone(f, t.rate), 600, 25), `FM: recovers the ${tone(f, t.rate).toFixed(0)} Hz modulating tone (want 600)`);
}

// ── SSB ─────────────────────────────────────────────────────────────────────
{
  const t = tune(-90_000, 6_000, 0.5);
  const sb = dsp.estimateSideband(t.iq, t.count);
  ok(sb.value === 'usb' && sb.confident, `SSB: picks usb, ${sb.ratioDb.toFixed(0)} dB asymmetry`);
  const usb = dsp.ssbDemod(t.iq, t.count, t.rate, 'usb');
  const lsb = dsp.ssbDemod(t.iq, t.count, t.rate, 'lsb');
  ok(power(usb, 200) > power(lsb, 200) + 20,
     `SSB: the chosen sideband is ${(power(usb, 200) - power(lsb, 200)).toFixed(0)} dB above the other`);
  const hz = tone(usb, t.rate);
  ok(near(hz, 700, 40) || near(hz, 1150, 40), `SSB: recovers an audio tone at ${hz.toFixed(0)} Hz (want 700 or 1150)`);
}

// ── CW ──────────────────────────────────────────────────────────────────────
{
  const t = tune(-180_500, 2_000, 0.3, 0.02);        // deliberately 500 Hz off center
  const off = dsp.estimateCarrierOffset(t.iq, t.count, t.rate);
  ok(off.confident && near(off.value, 500, 60), `CW: finds the carrier ${off.value.toFixed(0)} Hz off center (want 500)`);
  const a = dsp.cwBeat(t.iq, t.count, t.rate, off.value, 700);
  ok(near(Math.abs(tone(a, t.rate)), 700, 30), `CW: beats it down to ${Math.abs(tone(a, t.rate)).toFixed(0)} Hz (want 700)`);
}

// ── the estimators must decline, not guess, on empty spectrum ───────────────
{
  const t = tune(10_000, 16_000, 0.5);               // nothing is transmitting here
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
