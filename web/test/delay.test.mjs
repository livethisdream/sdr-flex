// When are a node's samples actually from?
//
//   node --test web/test/delay.test.mjs
//
// Every read here is "give me `count` samples ending at `t`", and that is not exactly
// true — a channel filter has a group delay, so the samples are from slightly before the
// moment asked for. In a tree it has never mattered: one path, one source, everything on
// screen shifted by the same invisible amount. A merge is what makes it matter
// (ADR-0038), because two branches go through different filters.
//
// **These tests measure rather than restate.** A pulse goes in at a known moment and the
// test finds where each node puts it, then checks that against what `delay.js` claims. A
// test that re-derived the number from the same reasoning as the code would agree with it
// and prove nothing — and the reasoning is where this went wrong: the arithmetic looks
// like the tuner's delay should depend on its decimation, and measurement says it does
// not.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MockEngine } from '../src/engine.js';
import { Capture } from '../src/capture.js';
import { ownDelaySamples, delayOf, alignment } from '../src/delay.js';

const FS = 480_000, CENTER = 100_000_000, SECONDS = 0.4, PULSE_AT = 0.2;

/**
 * A capture that is empty except for one smooth pulse.
 *
 * Gaussian and four milliseconds wide, which matters: a rectangular burst is broadband,
 * a short filter rings on it, and the ringing walks the peak around by more than the
 * delay being measured. The first version of this measurement reported the delay of a
 * 65-tap tuner as eight times its real value for exactly that reason.
 */
function pulseCapture(offsetHz = 0, widthS = 0.004) {
  const n = Math.round(FS * SECONDS);
  const buf = Buffer.alloc(n * 2, 128);
  const mid = Math.round(PULSE_AT * FS), half = Math.round((widthS / 2) * FS);
  for (let i = mid - half; i <= mid + half; i++) {
    const g = Math.exp(-Math.pow((i - mid) / (half / 2.5), 2));
    const a = (2 * Math.PI * offsetHz * i) / FS;
    buf[i * 2] = Math.round(Math.cos(a) * 110 * g + 127.5);
    buf[i * 2 + 1] = Math.round(Math.sin(a) * 110 * g + 127.5);
  }
  return new Capture({ buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
                       format: 'cu8', sampleRate: FS, centerHz: CENTER, label: 'pulse' });
}

async function opened(offsetHz = 0) {
  const e = new MockEngine({ latency: false });
  await e.createSession();
  await e.openCapture(pulseCapture(offsetHz));
  return e;
}

/** The absolute moment this node's samples put the pulse at, by energy centroid. */
function seenAt(engine, node) {
  const fs = node.out.sampleRate;
  const tEnd = PULSE_AT + 0.05;
  const count = Math.round(fs * 0.1);
  const iq = node.out.kind === 'iq';
  const data = iq ? engine._readIQ(node, tEnd, count) : engine._detect(node, tEnd, count);
  const p = new Float64Array(count);
  for (let i = 0; i < count; i++) p[i] = iq ? data[i * 2] ** 2 + data[i * 2 + 1] ** 2 : data[i] ** 2;
  // a detector sits on a pedestal, so the floor comes off before the centroid is taken
  const floor = [...p].sort((x, y) => x - y)[count >> 1];
  let num = 0, den = 0;
  for (let i = 0; i < count; i++) { const v = Math.max(0, p[i] - floor); num += v * i; den += v; }
  return (tEnd - count / fs) + (den > 0 ? num / den : 0) / fs;
}

/** How late this node's samples are, measured. */
const measured = (e, node) => seenAt(e, node) - PULSE_AT;
const claimed = (e, node) => delayOf(node, (id) => e.node(id)).seconds;

async function tuner(e, { taps = null, decim = null, width = 100_000 } = {}) {
  const n = await e.addNode({ parent: e.root.id, op: 'core.tuner',
    selection: { f0: CENTER - width / 2, f1: CENTER + width / 2 }, at: 0.1 });
  if (decim != null) await e.setParam(n.id, 'decim', decim);
  if (taps != null) await e.setParam(n.id, 'taps', taps);
  return e.node(n.id);
}

// ── the source is the origin ────────────────────────────────────────────────

test('a source is not late, because it is where the moments come from', async () => {
  const e = await opened();
  assert.equal(claimed(e, e.root), 0);
  assert.ok(Math.abs(measured(e, e.root)) < 1 / FS, 'and it measures as zero too');
});

// ── the tuner, which is where nearly all of it comes from ───────────────────

test('a tuner is late by half its filter, and says so to within a sample', async () => {
  for (const taps of [65, 129, 255]) {
    const e = await opened();
    const t = await tuner(e, { taps, decim: 4 });
    const got = measured(e, t), said = claimed(e, t);
    assert.ok(Math.abs(got - said) < 1 / t.out.sampleRate,
      `${taps} taps: measured ${(got * 1e6).toFixed(1)} µs, claimed ${(said * 1e6).toFixed(1)} µs`);
  }
});

test('and the delay does not depend on the decimation, which the arithmetic hides', async () => {
  // `xlateFilterDecimate` reads `count * decim + taps` input samples for `count` outputs,
  // so the extra window and the filter's own centre cancel down to a term in `taps`
  // alone. Reading the code and halving the tap count gets a `decim` term that is not
  // really there, and on a heavily decimated channel that is wrong by a lot.
  const e1 = await opened(); const a = await tuner(e1, { taps: 255, decim: 4 });
  const e2 = await opened(); const b = await tuner(e2, { taps: 255, decim: 16 });
  const da = measured(e1, a), db = measured(e2, b);
  assert.ok(Math.abs(da - db) < 2 / FS,
    `decim 4 is ${(da * 1e6).toFixed(1)} µs and decim 16 is ${(db * 1e6).toFixed(1)} µs`);
  assert.ok(Math.abs(claimed(e1, a) - claimed(e2, b)) < 1e-9, 'and the claim does not either');
});

test('two channels off one source are late by different amounts', async () => {
  // The whole reason this file exists. A wide channel needs a short filter and a narrow
  // one needs a long filter, because the tuner derives its tap count from what folds
  // (ADR-0017) — so two branches of one signal arrive skewed, by design.
  const e = await opened();
  const wide = await tuner(e, { width: 200_000 });
  const narrow = await tuner(e, { width: 8_000 });
  assert.notEqual(wide.params.taps.value, narrow.params.taps.value, 'derived differently');
  const skew = Math.abs(claimed(e, wide) - claimed(e, narrow));
  assert.ok(skew > 50e-6, `${(skew * 1e6).toFixed(0)} µs apart`);
  // and that skew is a phase error wherever it lands: at 38 kHz, a cycle is 26 µs
  assert.ok(skew * 38_000 > 1, 'which is more than a whole cycle at the stereo subcarrier');
});

// ── the detectors ───────────────────────────────────────────────────────────

test('each detector adds what it claims to add, and no more', async () => {
  const want = {
    'core.am_envelope': 'a magnitude is pointwise; its smoother undoes its own delay',
    'core.fm_discriminator': 'the phase between two samples belongs between them',
    'core.ssb': 'the Hilbert transformer is 65 taps and the I path waits for it',
    'core.cw': 'a pointwise mix',
  };
  for (const op of Object.keys(want)) {
    const e = await opened(15_000);
    const t = await tuner(e);
    const d = await e.addNode({ parent: t.id, op, at: 0.1 });
    const own = measured(e, e.node(d.id)) - measured(e, t);
    const said = ownDelaySamples(e.node(d.id), t.out) / d.out.sampleRate;
    assert.ok(Math.abs(own - said) < 1.2 / d.out.sampleRate,
      `${op}: measured ${(own * d.out.sampleRate).toFixed(2)} samples, claims ` +
      `${(said * d.out.sampleRate).toFixed(2)} — ${want[op]}`);
  }
});

test('the SSB demodulator is the one that adds a real delay of its own', async () => {
  const e = await opened(15_000);
  const t = await tuner(e);
  const d = await e.addNode({ parent: t.id, op: 'core.ssb', at: 0.1 });
  assert.equal(ownDelaySamples(e.node(d.id), t.out), 32, 'half of a 65-tap Hilbert');
  // and the total is the tuner's plus its own, not one or the other
  const total = claimed(e, e.node(d.id));
  assert.ok(Math.abs(total - (claimed(e, t) + 32 / d.out.sampleRate)) < 1e-12);
});

test('the stereo decoder adds nothing, which is why its filters are centred', async () => {
  const e = await opened(15_000);
  const t = await tuner(e, { width: 200_000 });
  const fm = await e.addNode({ parent: t.id, op: 'core.fm_discriminator', at: 0.1 });
  const st = await e.addNode({ parent: fm.id, op: 'core.stereo', at: 0.1 });
  assert.equal(ownDelaySamples(e.node(st.id), fm.out), 0);
});

// ── what cannot be answered ─────────────────────────────────────────────────

test('a de-hopper does not pretend to know when its samples are from', async () => {
  const e = await opened();
  const t = await tuner(e);
  const dh = await e.addNode({ parent: t.id, op: 'core.dehop', at: 0.1 });
  assert.equal(ownDelaySamples(e.node(dh.id), t.out), null, 'it restitches time (ADR-0033)');
  const d = delayOf(e.node(dh.id), (id) => e.node(id));
  assert.equal(d.known, false);
  assert.equal(d.op, 'core.dehop', 'and names which hop could not answer');
});

test('an unknown hop poisons everything downstream of it, which is the point', async () => {
  const e = await opened();
  const t = await tuner(e);
  const dh = await e.addNode({ parent: t.id, op: 'core.dehop', at: 0.1 });
  const fm = await e.addNode({ parent: dh.id, op: 'core.fm_discriminator', at: 0.1 });
  assert.equal(delayOf(e.node(fm.id), (id) => e.node(id)).known, false,
    'a known delay on top of an unknown one is still unknown');
});

// ── lining two of them up ───────────────────────────────────────────────────

test('two branches report the shift that would put one on top of the other', async () => {
  const e = await opened();
  const wide = await tuner(e, { width: 200_000 });
  const narrow = await tuner(e, { width: 8_000 });
  const a = alignment(wide, narrow, (id) => e.node(id));
  assert.equal(a.ok, true);
  assert.equal(a.rate, Math.max(wide.out.sampleRate, narrow.out.sampleRate));
  // the narrow branch has the longer filter, so it is the later one and the shift is
  // negative — "move it earlier to sit on the wide one"
  assert.ok(a.shiftSamples < 0, `shift ${a.shiftSamples.toFixed(2)} samples`);
  assert.ok(Math.abs(a.shiftSamples) > 0.5, 'and it is not a rounding error');
});

test('the shift is fractional, because rounding it away is the bug', async () => {
  // Half a sample at 160 kS/s is three microseconds, which is forty degrees at 38 kHz.
  // An integer shift would line two branches up and still lose a coherent decode.
  //
  // Two detectors on one tuner is the cleanest case there is: same rate, same filter
  // ahead of them, and the only difference is that a discriminator's sample belongs
  // between two inputs and a beat note's belongs on one.
  const e = await opened(15_000);
  const t = await tuner(e, { width: 200_000 });
  const fm = await e.addNode({ parent: t.id, op: 'core.fm_discriminator', at: 0.1 });
  const cw = await e.addNode({ parent: t.id, op: 'core.cw', at: 0.1 });
  const a = alignment(e.node(fm.id), e.node(cw.id), (id) => e.node(id));
  assert.ok(a.ok, a.why);
  // Compared with a tolerance rather than exactly: the shift is a difference of two
  // sums of ratios, so it arrives as 0.499999999999997 and asserting equality here would
  // be asserting something about floating point rather than about the signal.
  assert.ok(Math.abs(a.shiftSamples - 0.5) < 1e-9,
            `half a sample apart, and it survives to the caller: got ${a.shiftSamples}`);
});

test('it refuses rather than guesses when a branch cannot say', async () => {
  const e = await opened();
  const t = await tuner(e);
  const dh = await e.addNode({ parent: t.id, op: 'core.dehop', at: 0.1 });
  const a = alignment(t, e.node(dh.id), (id) => e.node(id));
  assert.equal(a.ok, false);
  assert.match(a.why, /core\.dehop/);
});

test('and refuses two streams that are not the same kind of thing', async () => {
  const e = await opened(15_000);
  const t = await tuner(e);
  const fm = await e.addNode({ parent: t.id, op: 'core.fm_discriminator', at: 0.1 });
  const a = alignment(t, e.node(fm.id), (id) => e.node(id));
  assert.equal(a.ok, false);
  assert.match(a.why, /iq/);
  assert.match(a.why, /real/);
});
