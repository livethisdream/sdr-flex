// The stereo decoder, drawn instead of invoked.
//
//   node --test web/test/drawn-stereo.test.mjs
//
// `core.stereo` is a node you cannot open. It is a good node — one key and a broadcast
// plays — but the argument this project keeps making is that you should be able to see
// inside a decode and argue with it (ADR-0024, 09-demods), and a node that does the whole
// job in one step is the shape that argument is against.
//
// So: the same decode, as boxes. A composite made complex, three tuners drawn on it by
// hand, the pilot squared to make a 38 kHz reference, and a conjugate product against it.
// Every intermediate result is a node with a spectrum you can look at.
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
  const mpx = mod.fmStereoMpx({ rate: FS, seconds: 0.6, theta: 0.7,
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
    selection: { f0: CENTER - FS / 2, f1: CENTER + FS / 2 }, at: 0.3 });
  const fm = await e.addNode({ parent: tu.id, op: 'core.fm_discriminator', at: 0.3 });
  return { e, fm };
}

/** Amplitude of one frequency in a real stream, by correlation. */
function amplitudeAt(x, fs, hz, pad = 4000) {
  let re = 0, im = 0, n = 0;
  for (let i = pad; i < x.length - pad; i++) {
    const a = (2 * Math.PI * hz * i) / fs;
    re += x[i] * Math.cos(a); im += x[i] * Math.sin(a); n++;
  }
  return (2 * Math.hypot(re, im)) / (n || 1);
}
const db = (a, b) => 20 * Math.log10((a || 1e-20) / (b || 1e-20));

// ── the two conversions ─────────────────────────────────────────────────────

test('a composite can be made complex, and the trip back is the identity', async () => {
  const { e, fm } = await station();
  const an = await e.addNode({ parent: fm.id, op: 'core.analytic', at: 0.3 });
  assert.equal(an.out.kind, 'iq');
  assert.equal(an.out.sampleRate, fm.out.sampleRate, 'nothing is resampled crossing over');
  assert.equal(an.out.centerHz, 0, 'its frequencies are baseband offsets, not RF');

  const back = await e.addNode({ parent: an.id, op: 'core.real', at: 0.3 });
  assert.equal(back.out.kind, 'real');

  const before = e._detect(e.node(fm.id), 0.35, 8192);
  const after = e._detect(e.node(back.id), 0.35, 8192);
  let worst = 0;
  for (let i = 0; i < 8192; i++) worst = Math.max(worst, Math.abs(before[i] - after[i]));
  assert.equal(worst, 0, 'real → iq → real returns exactly what went in');
});

test('crossing over adds no delay, so a chain of them stays lined up', async () => {
  const { delayOf } = await import('../src/delay.js');
  const { e, fm } = await station();
  const an = await e.addNode({ parent: fm.id, op: 'core.analytic', at: 0.3 });
  const back = await e.addNode({ parent: an.id, op: 'core.real', at: 0.3 });
  const at = (n) => delayOf(e.node(n.id), (id) => e.node(id)).seconds;
  assert.equal(at(an), at(fm));
  assert.equal(at(back), at(fm));
});

test('the pilot and the subcarrier are where the axis says they are', async () => {
  // The thing that makes hand-tuning a composite possible at all: once it is complex, a
  // box drawn at 19 kHz is a box at 19 kHz.
  const { e, fm } = await station();
  const an = await e.addNode({ parent: fm.id, op: 'core.analytic', at: 0.3 });
  const f = e.frame(an.id, { bins: 4096, window: 'Hann', at: 0.35 });
  assert.equal(f.kind, 'spectrum');
  const bin = (hz) => Math.round(f.data.length / 2 + (hz * f.data.length) / f.sampleRate);
  const floor = [...f.data].sort((a, b) => a - b)[f.data.length >> 1];
  for (const [hz, what] of [[19_000, 'the pilot'], [38_000, 'the L-R subcarrier']]) {
    assert.ok(f.data[bin(hz)] - floor > 15, `${what} stands up at +${hz / 1000} kHz`);
    assert.ok(f.data[bin(-hz)] - floor < 12, `and its image at -${hz / 1000} kHz does not`);
  }
});

// ── the whole thing, as boxes ───────────────────────────────────────────────

/**
 * Build the decoder out of nodes and return left and right.
 *
 * ```
 *   FM demod ──▶ To IQ ──┬─▶ Tune  0 kHz ─────────────────────▶ sum
 *                        ├─▶ Tune 19 kHz ─▶ Math a×b ──┐  (the pilot, squared)
 *                        └─▶ Tune 38 kHz ─▶ Math a×conj(b) ─▶ To real ─▶ diff
 * ```
 */
async function drawn(e, fm) {
  const an = await e.addNode({ parent: fm.id, op: 'core.analytic', at: 0.3 });
  const rate = an.out.sampleRate;
  // Every tuner at the same decimation, because a merge does not resample — which is what
  // makes setting this by hand a thing you do on purpose rather than a thing you forget.
  const DECIM = 8;
  const tune = async (centerHz, widthHz) => {
    const t = await e.addNode({ parent: an.id, op: 'core.tuner',
      selection: { f0: centerHz - widthHz / 2, f1: centerHz + widthHz / 2 }, at: 0.3 });
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

  // And the coherent demodulation: the difference band against that reference.
  const coh = await e.addNode({ parent: lr.id, op: 'core.math', at: 0.3, withNode: ref.id });
  await e.setParam(coh.id, 'op', 'a*conj(b)');

  const sumR = await e.addNode({ parent: sum.id, op: 'core.real', at: 0.3 });
  const diffR = await e.addNode({ parent: coh.id, op: 'core.real', at: 0.3 });
  return { sumR: e.node(sumR.id), diffR: e.node(diffR.id), rate: rate / DECIM, nodes: { an, sum, pilot, lr, ref, coh } };
}

test('the drawn chain recovers left and right, and keeps them apart', async () => {
  const { e, fm } = await station();
  const { sumR, diffR, rate } = await drawn(e, fm);

  const count = 1 << 15, at = 0.4;
  const S = e._detect(sumR, at, count);
  const D = e._detect(diffR, at, count);

  // The two branches carry wildly different scales — the difference rode a conjugate
  // product, so it is multiplied by the pilot's power. Matrixing needs them balanced, and
  // the tone that is in both channels is what balances them: L+R has it at full strength
  // and L-R has none of it, so the 400 Hz and 3 kHz amplitudes are what to match on.
  const sTone = amplitudeAt(S, rate, L_HZ) + amplitudeAt(S, rate, R_HZ);
  const dTone = amplitudeAt(D, rate, L_HZ) + amplitudeAt(D, rate, R_HZ);
  const g = sTone / dTone;

  const left = new Float32Array(count), right = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    left[i] = S[i] + D[i] * g;
    right[i] = S[i] - D[i] * g;
  }
  const sepL = db(amplitudeAt(left, rate, L_HZ), amplitudeAt(left, rate, R_HZ));
  const sepR = db(amplitudeAt(right, rate, R_HZ), amplitudeAt(right, rate, L_HZ));
  assert.ok(sepL > 20, `left keeps the right channel ${sepL.toFixed(1)} dB down`);
  assert.ok(sepR > 20, `right keeps the left channel ${sepR.toFixed(1)} dB down`);
  if (process.env.SDRFLEX_SHOW) console.log(`    drawn: ${sepL.toFixed(1)} / ${sepR.toFixed(1)} dB`);
});

test('every step of it is a node with something to look at', async () => {
  // The whole point. If the intermediate results were not inspectable this would be
  // `core.stereo` with extra ceremony.
  const { e, fm } = await station();
  const { nodes } = await drawn(e, fm);
  for (const [name, n] of Object.entries(nodes)) {
    const f = e.frame(n.id, { bins: 1024, window: 'Hann', at: 0.4 });
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
  const count = 1 << 14, at = 0.4;
  const p = e._readIQ(nodes.pilot, at, count);
  const r = e._readIQ(nodes.ref, at, count);
  let worst = 0;
  for (let i = 2000; i < count - 2000; i++) {
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
  const st = await e.addNode({ parent: fm.id, op: 'core.stereo', at: 0.3 });
  await e.setParam(st.id, 'deemphasisUs', 0);
  const count = 1 << 15, at = 0.4;
  const lr = e._detect(e.node(st.id), at, count);
  const rate = st.out.sampleRate;
  const pick = (c) => { const o = new Float32Array(count); for (let i = 0; i < count; i++) o[i] = lr[i * 2 + c]; return o; };
  const sep = Math.min(
    db(amplitudeAt(pick(0), rate, L_HZ), amplitudeAt(pick(0), rate, R_HZ)),
    db(amplitudeAt(pick(1), rate, R_HZ), amplitudeAt(pick(1), rate, L_HZ)));
  assert.ok(sep > 20, `the opaque node gets ${sep.toFixed(1)} dB, for comparison`);
  if (process.env.SDRFLEX_SHOW) console.log(`    node:  ${sep.toFixed(1)} dB`);
});
