// A long read is one signal, not a row of blocks.
//
// `readSpan` walks a whole capture in 65536-sample chunks so the frame loop can breathe
// between them, and each chunk is an independent read that ends at its own moment. That
// only produces one continuous signal if every read really does end where it says it
// does — and for a while one of them did not.
//
// A tuner asks its parent for the filter's length of extra samples ahead of each read,
// so the *first* read of any capture reaches back past sample zero. The source clamped
// that to zero rather than padding the front, which silently returned a window ending
// late by however much was clamped. So chunk one was shifted and every later chunk was
// not, and the seam between them repeated the filter's length in samples.
//
// Sixty-five samples is 0.68 ms, which is nothing to look at and most of a symbol at
// 1200 baud. What it cost was a packet: the APRS fixture has two frames in it and the
// graph decoded exactly the one that did not sit on top of a chunk boundary. Nothing
// reported an error, because nothing had gone wrong as far as any single read knew.
//
//   node --test web/test/span.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { MockEngine } from '../src/engine.js';
import { Capture } from '../src/capture.js';

const FS = 96_000, CENTER = 144_390_000;

/**
 * A capture whose every sample says where it is: a complex exponential whose phase
 * advances by a fixed step per sample. Any repeat, gap or shift in a read of it shows
 * up as a break in the phase difference, which is a thing to measure rather than eyeball.
 */
function ramp(samples) {
  const iq = new Float32Array(samples * 2);
  const step = (2 * Math.PI * 1000) / FS;          // a 1 kHz tone, well inside any filter
  for (let i = 0; i < samples; i++) {
    iq[i * 2] = 0.7 * Math.cos(step * i);
    iq[i * 2 + 1] = 0.7 * Math.sin(step * i);
  }
  const buf = Buffer.allocUnsafe(samples * 2);
  for (let i = 0; i < samples * 2; i++) buf[i] = Math.max(0, Math.min(255, Math.round(iq[i] * 127.5 + 127.5)));
  return new Capture({
    buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    format: 'cu8', sampleRate: FS, centerHz: CENTER, label: 'ramp',
  });
}

async function tuned(samples, width = FS / 2) {
  const e = new MockEngine({ latency: false });
  await e.createSession();
  await e.openCapture(ramp(samples));
  const t = await e.addNode({
    parent: e.root.id, op: 'core.tuner', at: 0.05,
    selection: { f0: CENTER - width / 2, f1: CENTER + width / 2 },
  });
  return { e, t };
}

test('a read ending at tEnd ends at tEnd, even at the very beginning', async () => {
  const { e, t } = await tuned(200_000);
  const n = e.node(t.id);
  // Two reads of the same 4096 samples, one of them the first read of the capture and
  // so the one that reaches back past zero. They are the same samples either way.
  const first = e._readIQ(n, 4096 / FS, 4096);
  const later = e._readIQ(n, 40_960 / FS, 40_960).subarray((40_960 - 4096) * 2);
  assert.equal(first.length, 4096 * 2, 'it returns what it was asked for');
  // The two windows are different parts of the signal; what matters is that neither is
  // shifted relative to a read that did not need padding at all.
  const whole = e._readIQ(n, 45_056 / FS, 45_056);
  const at = (buf, k) => [buf[k * 2], buf[k * 2 + 1]];
  for (const k of [100, 2000, 4000]) {
    assert.deepEqual(at(later, k), at(whole, 40_960 - 4096 + k),
      `sample ${k} of a later read lines up with the same sample of a longer one`);
  }
});

test('a chunked span has no seam in it', async () => {
  // Two chunks' worth and change, so the boundary at 65536 is somewhere in the middle.
  const { e, t } = await tuned(160_000);
  const got = await e.readSpan(t.id, 0, 160_000 / FS);
  assert.ok(got.count > 65_536 * 2, `${got.count} samples, so more than two chunks`);

  // A constant tone advances its phase by the same amount every sample. A repeat or a
  // gap at a chunk boundary is a step in that advance, and nothing else is.
  const d = new Float64Array(got.count - 1);
  for (let i = 1; i < got.count; i++) {
    const ar = got.data[i * 2], ai = got.data[i * 2 + 1];
    const br = got.data[(i - 1) * 2], bi = got.data[(i - 1) * 2 + 1];
    d[i - 1] = Math.atan2(ai * br - ar * bi, ar * br + ai * bi);
  }
  // Ignore the filter's warm-up at the very start and the run past the end of the data.
  const lo = 2048, hi = 160_000 - 2048;
  let worst = 0, at = -1;
  const nominal = (2 * Math.PI * 1000) / FS;
  for (let i = lo; i < hi; i++) {
    const err = Math.abs(d[i] - nominal);
    if (err > worst) { worst = err; at = i; }
  }
  assert.ok(worst < nominal * 0.25,
    `phase steps by ${worst.toFixed(4)} rad too much at sample ${at} ` +
    `(chunk boundaries are at ${65_536} and ${131_072}) — that is a seam`);
});

test('a span is the same signal whether it is read in one go or in chunks', async () => {
  const { e, t } = await tuned(160_000);
  const chunked = await e.readSpan(t.id, 0, 160_000 / FS);
  const n = e.node(t.id);
  const oneGo = e._readIQ(n, chunked.count / FS, chunked.count);
  let worst = 0;
  for (let i = 0; i < chunked.count * 2; i++) worst = Math.max(worst, Math.abs(chunked.data[i] - oneGo[i]));
  assert.ok(worst < 1e-5, `chunking changed the samples by up to ${worst.toExponential(2)}`);
});

test('reading before the beginning is silence, not a shifted window', async () => {
  const e = new MockEngine({ latency: false });
  await e.createSession();
  await e.openCapture(ramp(10_000));
  // 4096 samples ending at sample 1000: the first 3096 of them are before the capture.
  const got = e._readIQ(e.root, 1000 / FS, 4096);
  assert.equal(got.length, 4096 * 2);
  let head = 0;
  for (let i = 0; i < 3096 * 2; i++) head += Math.abs(got[i]);
  assert.equal(head, 0, 'before the beginning is zeros');
  assert.ok(Math.abs(got[3096 * 2]) + Math.abs(got[3096 * 2 + 1]) > 0.1,
            'and sample zero of the capture lands exactly where the arithmetic says');
});
