// The detector block cache: views and the speaker share computed samples.
//
//   node --test web/test/cache.test.mjs
//
// What it must never do is change an answer. A cached read has to be the samples a direct
// read would have produced, reads that meet end to end have to join without a seam, and a
// changed parameter has to throw the old blocks away.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MockEngine } from '../src/engine.js';
import { Capture } from '../src/capture.js';
import * as mod from './support/modulate.mjs';

const FS = 250_000;

/** A capture from interleaved IQ in [-1, 1], as cu8. */
async function engineWith(iq, rate = FS) {
  const buf = Buffer.allocUnsafe(iq.length);
  for (let i = 0; i < iq.length; i++) buf[i] = Math.max(0, Math.min(255, Math.round(iq[i] * 127.5 + 127.5)));
  const e = new MockEngine({ latency: false });
  await e.createSession();
  await e.openCapture(new Capture({
    buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    format: 'cu8', sampleRate: rate, centerHz: 100_000_000, label: 'cache',
  }));
  return e;
}

/** A broadcast station: the stereo composite, FM-modulated. */
function fmStation(seconds = 1.2) {
  const mpx = mod.fmStereoMpx({ rate: FS, seconds });
  const iq = new Float32Array(mpx.length * 2);
  let phase = 0;
  for (let i = 0; i < mpx.length; i++) {
    phase += (2 * Math.PI * 60_000 * mpx[i]) / FS;
    iq[i * 2] = 0.9 * Math.cos(phase); iq[i * 2 + 1] = 0.9 * Math.sin(phase);
  }
  return iq;
}

/** A steady carrier `offsetHz` from center, which CW and SSB both turn into a tone. */
function carrier(offsetHz, seconds = 1.2) {
  const n = Math.round(FS * seconds), iq = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * offsetHz * i) / FS;
    iq[i * 2] = 0.8 * Math.cos(a); iq[i * 2 + 1] = 0.8 * Math.sin(a);
  }
  return iq;
}

function maxDiff(a, b, from = 0, to = a.length) {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

async function chain(e, ops, { f0 = -100_000, f1 = 100_000 } = {}) {
  const c = e.root.out.centerHz;
  let n = await e.addNode({ parent: e.root.id, op: 'core.tuner', selection: { f0: c + f0, f1: c + f1 }, at: 0.5 });
  for (const op of ops) n = await e.addNode({ parent: n.id, op, at: 0.5 });
  return n;
}

test('a cached read is what a direct read gives, away from the direct read\'s own edges', async () => {
  const e = await engineWith(fmStation());
  for (const ops of [['core.fm_discriminator'], ['core.fm_discriminator', 'core.stereo']]) {
    const n = await chain(e, ops);
    const fs = n.out.sampleRate, ch = n.out.channels || 1, count = Math.round(fs * 0.3);
    const cached = e._detect(n, 0.8, count);
    const direct = e._detectRaw(n, 0.8, count);
    // A short direct read clamps its filters at both ends; the cache never does. So the
    // comparison stays a few milliseconds clear of the ends.
    const edge = Math.round(fs * 0.005) * ch;
    const d = maxDiff(cached, direct, edge, count * ch - edge);
    assert.ok(d < 1e-4, `${ops.join(' > ')}: max difference ${d}`);
  }
});

test('reads that meet end to end are one read', async () => {
  const e = await engineWith(fmStation());
  const st = await chain(e, ['core.fm_discriminator', 'core.stereo']);
  const fs = st.out.sampleRate, n = 3000, t1 = 0.4 + n / fs, t2 = t1 + n / fs;
  const a = e._detect(st, t1, n), b = e._detect(st, t2, n), whole = e._detect(st, t2, 2 * n);
  assert.equal(maxDiff(a, whole.subarray(0, a.length)), 0);
  assert.equal(maxDiff(b, whole.subarray(a.length)), 0);
});

test('CW and SSB keep their oscillator phase across reads', async () => {
  // Their beat oscillator used to restart at every read, so two reads that met end to end
  // met in a phase jump — a click at every audio chunk. It is anchored to the capture now,
  // so even direct reads join.
  const e = await engineWith(carrier(1_500));
  for (const op of ['core.cw', 'core.ssb']) {
    const n = await chain(e, [op], { f0: -6_000, f1: 6_000 });
    const fs = n.out.sampleRate, k = Math.round(fs * 0.05), t = 0.6;
    const first = e._detectRaw(n, t, k), second = e._detectRaw(n, t + k / fs, k);
    const whole = e._detectRaw(n, t + k / fs, 2 * k);
    // The seam: the first sample of the second read against the same sample in one read.
    const edge = Math.round(fs * 0.015);
    const d = maxDiff(second, whole.subarray(k), edge, k - edge);
    assert.ok(d < 1e-3, `${op}: after the seam the reads differ by ${d}`);
    assert.ok(maxDiff(first, whole.subarray(0, k), edge, k - edge) < 1e-3, `${op}: before the seam`);
  }
});

test('changing a parameter throws the old blocks away', async () => {
  const e = await engineWith(fmStation());
  const fm = await chain(e, ['core.fm_discriminator']);
  const count = 2000, before = e._detect(fm, 0.7, count);
  await e.setParam(fm.id, 'gain', fm.params.gain.value * 2, 'manual');
  const after = e._detect(e.node(fm.id), 0.7, count);
  // Doubled gain, doubled output: if the blocks had survived, nothing would have moved.
  const ratio = after[1000] / before[1000];
  assert.ok(Math.abs(ratio - 2) < 1e-3, `ratio ${ratio}`);
});

test('a block that is not all here yet is not kept', async () => {
  const e = await engineWith(fmStation());
  const fm = await chain(e, ['core.fm_discriminator']);
  // Pretend this is a radio whose ring ends at 0.6 s.
  e.capture.live = true;
  e.span = () => [0, 0.6];
  e._detect(fm, 0.6, 4000);
  const B = Math.round(0.25 * fm.out.sampleRate);
  for (const j of fm._blocks.keys()) {
    assert.ok(((j + 1) * B) / fm.out.sampleRate <= 0.6, `block ${j} reaches past the live edge`);
  }
});
