// Decoding as it plays.
//
//   node --test web/test/stream.test.mjs
//
// A decoder used to answer once, for the whole capture, when it was done. On a ninety
// second file that is a long wait for a packet that happened at eleven seconds, and the
// expectation it disappoints is an ordinary one: as the bursts arrive, show what they
// said.
//
// The unit is a *block* of capture time rather than a sliding window, and that choice is
// what this pins. Blocks are disjoint, so a record is never counted twice and nothing has
// to be de-duplicated; they are fixed, so the same seconds always decode as the same
// seconds; and the symbol sync in front of an M17 decoder now fits its grid per block
// too, so a decoding block never needs a grid that is not already measured.
//
// No decoder is installed for this on purpose. What is being checked is the contract
// between the application and the engine — which seconds get asked for, what comes back,
// and what is left alone — and a real subprocess would only make that slower to check.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MockEngine } from '../src/engine.js';
import { Capture } from '../src/capture.js';

const RATE = 96_000, CENTER = 144_800_000;

/** A capture of plain noise: nothing here cares what the samples are. */
async function engine() {
  const seconds = 30, n = RATE * seconds;
  const buf = Buffer.allocUnsafe(n * 2);
  let rng = 5;
  for (let i = 0; i < n * 2; i++) {
    rng = (rng * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = (rng >> 7) & 0xff;
  }
  const e = new MockEngine({ latency: false });
  await e.createSession();
  await e.openCapture(new Capture({
    buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    format: 'cu8', sampleRate: RATE, centerHz: CENTER, label: 'noise',
  }));
  const t = await e.addNode({ parent: e.root.id, op: 'core.tuner',
    selection: { f0: CENTER - 12_000, f1: CENTER + 12_000 }, at: 1 });
  const fm = await e.addNode({ parent: t.id, op: 'core.fm_discriminator', at: 1 });

  // An adapter that does nothing but say which seconds it was handed.
  const asked = [];
  e.adapters = [{ id: 'ext.fake', name: 'Fake', in: 'real', out: 'events',
                  available: true, command: 'fake', wants: { format: 'f32', rate: 48_000 },
                  params: [] }];
  e.adapter = (id) => (id === 'ext.fake'
    ? { id, name: 'Fake', in: 'real', out: 'events', params: [] } : null);
  e.runAdapter = async (node, at, span) => {
    asked.push(span ? { t0: span.t0, t1: span.t1 } : { whole: true });
    return { records: [{ text: span ? `${span.t0}-${span.t1}` : 'whole' }], ms: 1, note: 'fake' };
  };
  const dec = await e.addNode({ parent: fm.id, op: 'ext.fake', at: 1 });
  return { e, dec, asked };
}

test('a span run asks for exactly the seconds it was given', async () => {
  const { e, dec, asked } = await engine();
  const out = await e.runRecordsSpan(dec.id, 5, 10);
  assert.deepEqual(asked, [{ t0: 5, t1: 10 }]);
  assert.equal(out.t0, 5);
  assert.equal(out.t1, 10);
  assert.deepEqual(out.records.map((r) => r.text), ['5-10']);
});

test('a span run leaves what the node already holds alone', async () => {
  // The application is accumulating across blocks, so the node is not the accumulator.
  // Writing to it here would mean the last block silently replaced every one before it.
  const { e, dec } = await engine();
  await e.runRecords(dec.id, 30);
  const whole = e.node(dec.id)._records;
  assert.deepEqual(whole.records.map((r) => r.text), ['whole']);
  await e.runRecordsSpan(dec.id, 0, 5);
  assert.equal(e.node(dec.id)._records, whole, 'the span run overwrote the node’s records');
});

test('a whole-capture run still reads the whole capture', async () => {
  const { e, dec, asked } = await engine();
  await e.runRecords(dec.id, 12);
  assert.deepEqual(asked, [{ whole: true }]);
});

test('blocks are disjoint, so nothing is decoded twice', async () => {
  // The property that makes de-duplication unnecessary rather than merely unlikely.
  const { e, dec, asked } = await engine();
  const B = 5;
  for (let b = 0; b < 6; b++) await e.runRecordsSpan(dec.id, b * B, (b + 1) * B);
  for (let i = 1; i < asked.length; i++) {
    assert.ok(asked[i].t0 >= asked[i - 1].t1,
              `block ${i} starts at ${asked[i].t0}, inside the one ending at ${asked[i - 1].t1}`);
  }
  assert.equal(new Set(asked.map((a) => a.t0)).size, asked.length, 'a block was asked for twice');
});

test('a span that is not a span is refused rather than guessed at', async () => {
  const { e, dec, asked } = await engine();
  assert.equal(await e.runRecordsSpan(dec.id, 5, 5), null);
  assert.equal(await e.runRecordsSpan(dec.id, 10, 2), null);
  assert.equal(asked.length, 0, 'an empty or backwards span reached the decoder');
});
