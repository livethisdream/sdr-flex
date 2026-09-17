// A node with two inputs (ADR-0038).
//
//   node --test web/test/merge.test.mjs
//
// The test that carries this file is **cancellation**. Feed one signal down two branches
// that differ only in their filter, subtract them, and the answer is silence — but only
// if the merge lined them up, and only if it lined them up in the right direction. Get
// the sign of the shift backwards and the difference is twice the signal rather than
// none of it, which is as loud a failure as a test can ask for and is invisible to any
// assertion about whether samples came out.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MockEngine } from '../src/engine.js';
import { Capture } from '../src/capture.js';
import { alignment } from '../src/delay.js';
import * as dsp from '../src/dsp.js';

const FS = 480_000, CENTER = 100_000_000, TONE = 20_000;

/** A steady tone, so anything left after a subtraction is the merge's own error. */
async function opened(seconds = 0.4) {
  const n = Math.round(FS * seconds);
  const buf = Buffer.allocUnsafe(n * 2);
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * TONE * i) / FS;
    buf[i * 2] = Math.round(Math.cos(a) * 110 + 127.5);
    buf[i * 2 + 1] = Math.round(Math.sin(a) * 110 + 127.5);
  }
  const e = new MockEngine({ latency: false });
  await e.createSession();
  await e.openCapture(new Capture({
    buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    format: 'cu8', sampleRate: FS, centerHz: CENTER, label: 'tone',
  }));
  return e;
}

/** A tuner with its filter length and decimation pinned, so two can differ on purpose. */
async function tuner(e, { taps, decim = 4, width = 120_000 }) {
  const n = await e.addNode({ parent: e.root.id, op: 'core.tuner',
    selection: { f0: CENTER - width / 2, f1: CENTER + width / 2 }, at: 0.1 });
  await e.setParam(n.id, 'decim', decim);
  await e.setParam(n.id, 'taps', taps);
  return e.node(n.id);
}

const powerOf = (d, stride) => {
  let s = 0, n = d.length / stride;
  const from = Math.round(n * 0.25), to = Math.round(n * 0.75);   // ignore the window edges
  for (let i = from; i < to; i++) for (let c = 0; c < stride; c++) s += d[i * stride + c] ** 2;
  return s / ((to - from) * stride);
};

// ── the graph can hold it ───────────────────────────────────────────────────

test('a second input is an edge, not a setting', async () => {
  const e = await opened();
  const a = await tuner(e, { taps: 65 });
  const b = await tuner(e, { taps: 255 });
  const m = await e.addNode({ parent: a.id, op: 'core.math', at: 0.1, withNode: b.id });
  assert.deepEqual(m.inputs, [a.id, b.id]);
  // navigation follows the primary and only the primary
  assert.deepEqual(e.children(a.id).map((n) => n.id), [m.id]);
  assert.deepEqual(e.children(b.id).map((n) => n.id), [], 'the second input is not a parent');
  // but both are read, which is the question removal and invalidation ask
  assert.deepEqual(e.consumers(b.id).map((n) => n.id), [m.id]);
  assert.deepEqual(e.consumers(a.id).map((n) => n.id), [m.id]);
});

test('a cycle is refused when it is chosen, not found when it is read', async () => {
  const e = await opened();
  const a = await tuner(e, { taps: 65 });
  const m = await e.addNode({ parent: a.id, op: 'core.math', at: 0.1 });
  const after = await e.addNode({ parent: m.id, op: 'core.fm_discriminator', at: 0.1 });

  assert.equal(e.canFeed(m.id, m.id), false, 'itself');
  assert.equal(e.canFeed(after.id, m.id), false, 'something that reads it');
  assert.equal(e.canFeed(a.id, m.id), true, 'something upstream of it is fine');

  await e.setParam(m.id, 'withNode', after.id);
  assert.deepEqual(e.node(m.id).inputs, [a.id], 'the edge is not made');
  assert.equal(e.node(m.id).params.withNode.value, '', 'and the parameter does not claim it was');
});

test('removal follows what reads a node, not what descends from it', async () => {
  const e = await opened();
  const a = await tuner(e, { taps: 65 });
  const b = await tuner(e, { taps: 255 });
  const m = await e.addNode({ parent: a.id, op: 'core.math', at: 0.1, withNode: b.id });
  // `m` is nowhere below `b` in the tree, and deleting `b` still has to take it
  assert.ok(!e.children(b.id).length);
  assert.deepEqual(e.allConsumers(b.id).map((n) => n.id), [m.id]);
});

// ── the alignment, which is the point ───────────────────────────────────────

test('two branches of one signal cancel, which only happens if the shift is right', async () => {
  const e = await opened();
  const a = await tuner(e, { taps: 65 });
  const b = await tuner(e, { taps: 255 });
  assert.notEqual(a.params.taps.value, b.params.taps.value);

  const m = await e.addNode({ parent: a.id, op: 'core.math', at: 0.1, withNode: b.id });
  const count = 8192, at = 0.25;
  const diff = e._readIQ(e.node(m.id), at, count);
  const one = e._readIQ(a, at, count);

  const left = 10 * Math.log10(powerOf(diff, 2) / powerOf(one, 2));
  assert.ok(left < -25, `the difference is ${left.toFixed(1)} dB below one branch`);
});

test('and they do not cancel if the shift is thrown away', async () => {
  // The control. Without it the test above passes on a merge that aligns badly, because
  // two copies of a 20 kHz tone 200 µs apart still partly cancel by luck of phase.
  const e = await opened();
  const a = await tuner(e, { taps: 65 });
  const b = await tuner(e, { taps: 255 });
  const align = alignment(a, b, (id) => e.node(id));
  assert.ok(Math.abs(align.shiftSamples) > 1, `${align.shiftSamples.toFixed(2)} samples apart`);

  const count = 8192, at = 0.25;
  const A = e._readIQ(a, at, count);
  const B = e._readIQ(b, at, count);
  const naive = new Float32Array(count * 2);
  for (let i = 0; i < count * 2; i++) naive[i] = A[i] - B[i];

  const m = await e.addNode({ parent: a.id, op: 'core.math', at: 0.1, withNode: b.id });
  const aligned = e._readIQ(e.node(m.id), at, count);
  const gain = 10 * Math.log10(powerOf(naive, 2) / powerOf(aligned, 2));
  assert.ok(gain > 20, `aligning buys ${gain.toFixed(1)} dB over subtracting them where they sit`);
});

test('both inputs are read to the same moment, because flooring a time jitters', async () => {
  // The bug this guards against was invisible and cost a quarter of an output sample.
  // Reading the second input over a window ending at `tEnd + pad / rate` — the obvious
  // way to get margin — positions it with `Math.floor(tEnd * sampleRate)` on a different
  // number, and 0.2502 × 480000 is 120095.99999999999. One input sample at a decimation
  // of four is a quarter of an output sample of phase error, injected by the read
  // positioning of the very node whose job is to remove phase error.
  const e = await opened();
  const t = await tuner(e, { taps: 65 });
  const rate = t.out.sampleRate, count = 2048, pad = 24, at = 0.25;

  const same = e._readIQ(t, at, count);
  const wider = e._readIQ(t, at, count + 2 * pad);          // same end, more samples
  const moved = e._readIQ(t, at + pad / rate, count + 2 * pad);   // the tempting way

  let dSame = 0, dMoved = 0;
  for (let k = 200; k < count - 200; k++) {
    dSame += Math.abs(same[k * 2] - wider[(2 * pad + k) * 2]);
    dMoved += Math.abs(same[k * 2] - moved[(pad + k) * 2]);
  }
  assert.equal(dSame, 0, 'a wider window to the same end is the same samples, exactly');
  assert.ok(dMoved > 1, `and a moved end is not: ${dMoved.toExponential(1)} of drift`);
});

test('the fractional part survives, because it is most of the error at 38 kHz', async () => {
  // A half-sample shift is what separates two detectors on one tuner, and rounding it to
  // zero is a forty-degree phase error at the stereo subcarrier.
  const e = await opened();
  const t = await tuner(e, { taps: 129, decim: 3 });
  const fm = await e.addNode({ parent: t.id, op: 'core.fm_discriminator', at: 0.1 });
  const cw = await e.addNode({ parent: t.id, op: 'core.cw', at: 0.1 });
  const a = alignment(e.node(fm.id), e.node(cw.id), (id) => e.node(id));
  assert.ok(Math.abs(a.shiftSamples - 0.5) < 1e-9, `${a.shiftSamples}`);

  // and the interpolator that applies it is accurate where it has to be
  const n = 4096, fs = 160_000, hz = 38_000;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * hz * i) / fs);
  const y = dsp.shiftBy(x, 0.5);
  let err = 0, ref = 0;
  for (let i = 64; i < n - 64; i++) {
    const want = Math.sin((2 * Math.PI * hz * (i - 0.5)) / fs);
    err += (y[i] - want) ** 2; ref += want * want;
  }
  assert.ok(10 * Math.log10(err / ref) < -50,
            `a half-sample shift at 38 kHz is ${(10 * Math.log10(err / ref)).toFixed(0)} dB clean`);
});

// ── what it refuses ─────────────────────────────────────────────────────────

test('with nothing chosen it passes the first input through and says so', async () => {
  const e = await opened();
  const a = await tuner(e, { taps: 65 });
  const m = await e.addNode({ parent: a.id, op: 'core.math', at: 0.1 });
  const got = e._readMerged(e.node(m.id), 0.25, 1024);
  assert.match(got.note, /choose a second input/);
  const one = e._readIQ(a, 0.25, 1024);
  assert.equal(got.data[100], one[100], 'and what comes out is the first input, untouched');
});

test('it will not merge two different rates, and names both', async () => {
  const e = await opened();
  const a = await tuner(e, { taps: 65, decim: 4 });
  const b = await tuner(e, { taps: 65, decim: 8 });
  const m = await e.addNode({ parent: a.id, op: 'core.math', at: 0.1, withNode: b.id });
  const got = e._readMerged(e.node(m.id), 0.25, 1024);
  assert.match(got.note, /120\.0 kS\/s/);
  assert.match(got.note, /60\.0 kS\/s/);
  assert.match(got.note, /same decimation/);
});

test('it will not merge against a branch that cannot say when its samples are from', async () => {
  const e = await opened();
  const a = await tuner(e, { taps: 65 });
  const b = await tuner(e, { taps: 65 });
  const dh = await e.addNode({ parent: b.id, op: 'core.dehop', at: 0.1 });
  const m = await e.addNode({ parent: a.id, op: 'core.math', at: 0.1, withNode: dh.id });
  const got = e._readMerged(e.node(m.id), 0.25, 1024);
  assert.match(got.note, /core\.dehop/);
});

// ── the operations ──────────────────────────────────────────────────────────

test('a conjugate product against itself is a real constant, which is the DF primitive', async () => {
  // x × conj(x) is |x|², so the imaginary part goes to zero. It is also the shape of
  // every phase comparison — two antennas, or a subcarrier against its reference.
  const e = await opened();
  const a = await tuner(e, { taps: 65 });
  const b = await tuner(e, { taps: 65 });         // identical, so no shift to apply
  const m = await e.addNode({ parent: a.id, op: 'core.math', at: 0.1, withNode: b.id });
  await e.setParam(m.id, 'op', 'a*conj(b)');
  const d = e._readIQ(e.node(m.id), 0.25, 4096);
  let re = 0, im = 0;
  for (let i = 1000; i < 3000; i++) { re += Math.abs(d[i * 2]); im += Math.abs(d[i * 2 + 1]); }
  assert.ok(im < re * 1e-3, `imaginary part is ${(im / re).toExponential(1)} of the real part`);
});

test('a sum of a stream with itself is that stream doubled', async () => {
  const e = await opened();
  const a = await tuner(e, { taps: 65 });
  const b = await tuner(e, { taps: 65 });
  const m = await e.addNode({ parent: a.id, op: 'core.math', at: 0.1, withNode: b.id });
  await e.setParam(m.id, 'op', 'a+b');
  const sum = e._readIQ(e.node(m.id), 0.25, 4096);
  const one = e._readIQ(a, 0.25, 4096);
  const ratio = Math.sqrt(powerOf(sum, 2) / powerOf(one, 2));
  assert.ok(Math.abs(ratio - 2) < 0.02, `${ratio.toFixed(3)}× rather than 2×`);
});

test('a merge carries its primary input\'s delay, because it moved the other one', async () => {
  const e = await opened();
  const a = await tuner(e, { taps: 65 });
  const b = await tuner(e, { taps: 255 });
  const m = await e.addNode({ parent: a.id, op: 'core.math', at: 0.1, withNode: b.id });
  const lookup = (id) => e.node(id);
  const { delayOf } = await import('../src/delay.js');
  assert.equal(delayOf(e.node(m.id), lookup).seconds, delayOf(a, lookup).seconds);
});
