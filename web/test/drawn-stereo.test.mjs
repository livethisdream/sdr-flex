// The stereo decoder, drawn instead of invoked.
//
//   node --test web/test/drawn-stereo.test.mjs
//
// `core.stereo` is a node you cannot open. It is a good node — one key and a broadcast
// plays — but the argument this project keeps making is that you should be able to see
// inside a decode and argue with it (ADR-0024, 09-demods), and a node that does the whole
// job in one step is the shape that argument is against.
//
// So: the same decode, as boxes. Three tuners drawn by hand on the composite, the pilot
// squared to make a 38 kHz reference, and a conjugate product against it. Every
// intermediate result is a node with a spectrum you can look at.
//
// What this file asserts is that the drawn version *works* — that the machinery added for
// it (ADR-0037, ADR-0038) composes into the thing it was added for, and gets separation
// in the same range as the node it is spelling out. If it did not, the composition would
// be theater, which is the test ADR-0024 sets for itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MockEngine } from '../src/engine.js';
import { Capture } from '../src/capture.js';
import * as mod from './support/modulate.mjs';

const FS = 320_000, CENTER = 98_500_000, L_HZ = 400, R_HZ = 3_000;

/** A wideband FM station in stereo, as IQ, at a rate wide enough to hold the composite. */
async function station() {
  const mpx = mod.fmStereoMpx({ rate: FS, seconds: 1.2, theta: 0.7,
                                left: (t) => Math.sin(2 * Math.PI * L_HZ * t),
                                right: (t) => Math.sin(2 * Math.PI * R_HZ * t) });
  const count = mpx.length;
  const iq = new Float32Array(count * 2);
  let phase = 0;
  for (let i = 0; i < count; i++) {
    phase += (2 * Math.PI * 20_000 * mpx[i]) / FS;
    iq[i * 2] = Math.cos(phase);
    iq[i * 2 + 1] = Math.sin(phase);
  }
  const buf = Buffer.allocUnsafe(count * 2);
  for (let i = 0; i < count * 2; i++) buf[i] = Math.max(0, Math.min(255, Math.round(iq[i] * 127.5 + 127.5)));
  const e = new MockEngine({ latency: false });
  await e.createSession();
  await e.openCapture(new Capture({
    buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    format: 'cu8', sampleRate: FS, centerHz: CENTER, label: 'stereo',
  }));
  const tu = await e.addNode({ parent: e.root.id, op: 'core.tuner',
    selection: { f0: CENTER - FS / 2, f1: CENTER + FS / 2 }, at: 0.6 });
  const fm = await e.addNode({ parent: tu.id, op: 'core.fm_discriminator', at: 0.6 });
  return { e, fm };
}

/** Amplitude of one frequency in a real stream, by correlation. */
function amplitudeAt(x, fs, hz, pad = 500) {
  let re = 0, im = 0, n = 0;
  for (let i = pad; i < x.length - pad; i++) {
    const a = (2 * Math.PI * hz * i) / fs;
    re += x[i] * Math.cos(a); im += x[i] * Math.sin(a); n++;
  }
  return (2 * Math.hypot(re, im)) / (n || 1);
}
const db = (a, b) => 20 * Math.log10((a || 1e-20) / (b || 1e-20));

// ── tuning into a composite ─────────────────────────────────────────────────

test('a demodulated stream can be tuned into directly', async () => {
  // No conversion node in front of it. A mixer takes a real input — GNU Radio has had
  // `freq_xlating_fir_filter_fcf` for decades — and mixing by a complex phasor then
  // low-passing keeps the positive-frequency content and discards its image, which is
  // the analytic signal without a Hilbert transformer anywhere.
  const { e, fm } = await station();
  assert.equal(fm.out.kind, 'real');
  const ops = (await e.palette(fm.id)).map((o) => o.id);
  assert.ok(ops.includes('core.tuner'), 'and the palette offers it');

  const t = await e.addNode({ parent: fm.id, op: 'core.tuner',
    selection: { f0: 36_000, f1: 40_000 }, at: 0.6 });
  assert.equal(t.out.kind, 'iq');
  assert.equal(t.params.centerHz.value, 38_000, 'the selection was in baseband and stayed there');
});

test('its numbers are baseband, and so are its children\'s', async () => {
  // The axis unit follows the signal down the chain: once anything has been demodulated,
  // 38 kHz means 38 kHz from DC rather than 38 kHz from wherever the radio was tuned.
  const { e, fm } = await station();
  assert.equal(e.isBaseband(e.root.id), false, 'the source is RF');
  assert.equal(e.isBaseband(fm.id), true);
  const t = await e.addNode({ parent: fm.id, op: 'core.tuner',
    selection: { f0: 36_000, f1: 40_000 }, at: 0.6 });
  assert.equal(e.isBaseband(t.id), true, 'and a tuner drawn on it is too');
  const r = await e.addNode({ parent: t.id, op: 'core.real', at: 0.6 });
  assert.equal(e.isBaseband(r.id), true);
});

test('a box at 38 kHz gets the subcarrier and not the pilot', async () => {
  // Which is the whole reason hand-tuning a composite is worth having: the thing you drew
  // the box around is the thing you get.
  const { e, fm } = await station();
  const tune = async (centerHz) => {
    const t = await e.addNode({ parent: fm.id, op: 'core.tuner',
      selection: { f0: centerHz - 2_000, f1: centerHz + 2_000 }, at: 0.6 });
    const iq = e._readIQ(e.node(t.id), 0.9, 4096);
    let p = 0;
    for (let i = 1000; i < 3000; i++) p += iq[i * 2] ** 2 + iq[i * 2 + 1] ** 2;
    return 10 * Math.log10(p / 2000 + 1e-20);
  };
  const pilot = await tune(19_000);
  const sub = await tune(38_000);
  const empty = await tune(48_000);
  assert.ok(pilot - empty > 20, `19 kHz stands ${(pilot - empty).toFixed(0)} dB over an empty part of the band`);
  assert.ok(sub - empty > 20, `38 kHz stands ${(sub - empty).toFixed(0)} dB over it`);
});

test('the way back out is a node, and adds no delay', async () => {
  const { delayOf } = await import('../src/delay.js');
  const { e, fm } = await station();
  const t = await e.addNode({ parent: fm.id, op: 'core.tuner',
    selection: { f0: -15_000, f1: 15_000 }, at: 0.6 });
  const r = await e.addNode({ parent: t.id, op: 'core.real', at: 0.6 });
  assert.equal(r.out.kind, 'real');
  assert.equal(r.out.sampleRate, t.out.sampleRate);
  const at = (n) => delayOf(e.node(n.id), (id) => e.node(id)).seconds;
  assert.equal(at(r), at(t), 'taking the real part is pointwise');
});

// ── the whole thing, as boxes ───────────────────────────────────────────────

/**
 * Build the decoder out of nodes and return left and right.
 *
 * ```
 *   FM demod ──┬─▶ Tune  0 kHz ──────────────────▶ To real ─▶ Gain ─▶ sum
 *              ├─▶ Tune 19 kHz ─▶ Math a×b ──┐  (the pilot, squared)
 *              └─▶ Tune 38 kHz ─▶ Math a÷b ──┘─▶ To real ─▶ Gain ─▶ diff
 * ```
 *
 * The division rather than a conjugate product is what makes the two branches
 * commensurable: `a × conj(b)` comes out scaled by the pilot's power, and `a ÷ b` does
 * not. Each branch then gets a Gain, which arrives already derived — it measures what is
 * there and brings it to the level the audio sink targets — so both are at the same size
 * and the matrix is a plain sum and difference with no number anybody had to find.
 */
async function drawn(e, fm) {
  const rate = fm.out.sampleRate;
  // Every tuner at the same decimation, because a merge does not resample — which is what
  // makes setting this by hand a thing you do on purpose rather than a thing you forget.
  const DECIM = 8;
  const tune = async (centerHz, widthHz) => {
    const t = await e.addNode({ parent: fm.id, op: 'core.tuner',
      selection: { f0: centerHz - widthHz / 2, f1: centerHz + widthHz / 2 }, at: 0.6 });
    await e.setParam(t.id, 'decim', DECIM);
    await e.setParam(t.id, 'taps', 129);
    return e.node(t.id);
  };
  const sum = await tune(0, 30_000);
  const pilot = await tune(19_000, 4_000);
  const lr = await tune(38_000, 30_000);

  // The pilot against itself: squaring doubles its phase, which is what "the subcarrier
  // is the pilot's second harmonic, in phase" actually means (ADR-0037).
  const ref = await e.addNode({ parent: pilot.id, op: 'core.math', at: 0.3, withNode: pilot.id });
  await e.setParam(ref.id, 'op', 'a*b');

  // And the coherent demodulation: the difference band divided by that reference.
  const coh = await e.addNode({ parent: lr.id, op: 'core.math', at: 0.3, withNode: ref.id });
  await e.setParam(coh.id, 'op', 'a/b');

  const level = async (parent) => {
    const r = await e.addNode({ parent: parent.id, op: 'core.real', at: 0.6 });
    const g = await e.addNode({ parent: r.id, op: 'core.gain', at: 0.6 });
    return e.node(g.id);
  };
  const sumR = await level(sum);
  const diffR = await level(e.node(coh.id));
  return { sumR, diffR, rate: rate / DECIM, nodes: { sum, pilot, lr, ref, coh } };
}

test('the drawn chain recovers left and right, and keeps them apart', async () => {
  const { e, fm } = await station();
  const { sumR, diffR, rate } = await drawn(e, fm);

  const count = 1 << 13, at = 0.9;
  const S = e._detect(sumR, at, count);
  const D = e._detect(diffR, at, count);

  // No number supplied here. Both branches came through a Gain that derived itself, so
  // the matrix is what a matrix should be — a sum and a difference and nothing else.
  const left = new Float32Array(count), right = new Float32Array(count);
  for (let i = 0; i < count; i++) { left[i] = S[i] + D[i]; right[i] = S[i] - D[i]; }

  const sepL = db(amplitudeAt(left, rate, L_HZ), amplitudeAt(left, rate, R_HZ));
  const sepR = db(amplitudeAt(right, rate, R_HZ), amplitudeAt(right, rate, L_HZ));
  assert.ok(sepL > 20, `left keeps the right channel ${sepL.toFixed(1)} dB down`);
  assert.ok(sepR > 20, `right keeps the left channel ${sepR.toFixed(1)} dB down`);
  if (process.env.SDRFLEX_SHOW) console.log(`    drawn: ${sepL.toFixed(1)} / ${sepR.toFixed(1)} dB`);
});

test('the gain derives itself, and says what off it', async () => {
  const { e, fm } = await station();
  const { diffR } = await drawn(e, fm);
  assert.equal(diffR.op, 'core.gain');
  assert.equal(diffR.params.gainDb.mode, 'auto');
  assert.equal(diffR.params.gainDb.auto.confident, true);
  assert.match(diffR.params.gainDb.auto.from, /its level is .* brings it to 0\.25/,
               diffR.params.gainDb.auto.from);
  const out = e._detect(diffR, 0.9, 1 << 13);
  let s2 = 0;
  for (let i = 500; i < out.length - 500; i++) s2 += out[i] * out[i];
  const rms = Math.sqrt(s2 / (out.length - 1000));
  assert.ok(Math.abs(rms - 0.25) < 0.1, `and lands near it: ${rms.toFixed(3)}`);
});

test('dividing by the reference is what makes the branches commensurable', async () => {
  // `a × conj(b)` is the same phase comparison with the reference's power left in, so its
  // output scales with the pilot's strength and the other branch's does not. On a signal
  // whose pilot is at 10% injection that is two orders of magnitude of mismatch, and it
  // is the number the test used to have to supply by hand.
  const { e, fm } = await station();
  const { nodes } = await drawn(e, fm);
  const quot = e._readIQ(e.node(nodes.coh.id), 0.9, 1 << 12);
  await e.setParam(nodes.coh.id, 'op', 'a*conj(b)');
  const prod = e._readIQ(e.node(nodes.coh.id), 0.9, 1 << 12);
  const power = (d) => { let s2 = 0; for (let i = 300; i < d.length / 2 - 300; i++) s2 += d[i * 2] ** 2 + d[i * 2 + 1] ** 2; return s2; };
  const apart = 10 * Math.log10(power(quot) / power(prod));
  assert.ok(apart > 20, `the quotient and the product are ${apart.toFixed(0)} dB apart in scale`);
});

test('every step of it is a node with something to look at', async () => {
  // The whole point. If the intermediate results were not inspectable this would be
  // `core.stereo` with extra ceremony.
  const { e, fm } = await station();
  const { nodes } = await drawn(e, fm);
  for (const [name, n] of Object.entries(nodes)) {
    const f = e.frame(n.id, { bins: 1024, window: 'Hann', at: 0.6 });
    assert.equal(f.kind, 'spectrum', `${name} draws a spectrum`);
    const spread = Math.max(...f.data) - Math.min(...f.data);
    assert.ok(spread > 3, `${name} has something in it, not a flat line`);
  }
});

test('the reference really is the pilot doubled, not the pilot', async () => {
  // The step the whole decode turns on, checked on its own: squaring a tone at 19 kHz
  // puts it at 38 kHz. Tuned to baseband the pilot is near DC, and its square is too —
  // so what is checked is that the *phase* went round twice, which is what a conjugate
  // product against it will undo.
  const { e, fm } = await station();
  const { nodes } = await drawn(e, fm);
  const count = 1 << 13, at = 0.9;
  const p = e._readIQ(nodes.pilot, at, count);
  const r = e._readIQ(nodes.ref, at, count);
  let worst = 0;
  for (let i = 500; i < count - 500; i++) {
    const wr = p[i * 2] * p[i * 2] - p[i * 2 + 1] * p[i * 2 + 1];
    const wi = 2 * p[i * 2] * p[i * 2 + 1];
    worst = Math.max(worst, Math.hypot(r[i * 2] - wr, r[i * 2 + 1] - wi));
  }
  assert.ok(worst < 1e-5, `the reference is p² to within ${worst.toExponential(1)}`);
});

test('and the node it spells out gets a similar answer', async () => {
  // Not identical — `core.stereo` normalizes its reference by the pilot's amplitude and
  // the drawn chain does not, so their gains differ — but the separation should be in the
  // same range, because it is the same decode.
  const { e, fm } = await station();
  const st = await e.addNode({ parent: fm.id, op: 'core.stereo', at: 0.6 });
  await e.setParam(st.id, 'deemphasisUs', 0);
  const count = 1 << 13, at = 0.9;
  const lr = e._detect(e.node(st.id), at, count);
  const rate = st.out.sampleRate;
  const pick = (c) => { const o = new Float32Array(count); for (let i = 0; i < count; i++) o[i] = lr[i * 2 + c]; return o; };
  const sep = Math.min(
    db(amplitudeAt(pick(0), rate, L_HZ), amplitudeAt(pick(0), rate, R_HZ)),
    db(amplitudeAt(pick(1), rate, R_HZ), amplitudeAt(pick(1), rate, L_HZ)));
  assert.ok(sep > 20, `the opaque node gets ${sep.toFixed(1)} dB, for comparison`);
  if (process.env.SDRFLEX_SHOW) console.log(`    node:  ${sep.toFixed(1)} dB`);
});
