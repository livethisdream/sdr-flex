// Wave 2 through the engine: a signal that was drawn by a transmitter, decoded by the
// chain a person would actually build, ending at a CRC that says whether they got it
// right. Everything derived says what it derived it from (ADR-0017).

import test from 'node:test';
import assert from 'node:assert/strict';
import { MockEngine, OPS } from '../src/engine.js';
import { Capture } from '../src/capture.js';
import { crc, crcById, bytesOfHex } from '../src/frames.js';

const RATE = 200_000, SYMBOL_US = 500, CENTER = 433_920_000;

/** A capture containing OOK-modulated Manchester frames, each with a CRC on the end. */
function transmit(payloads, { spec, sync = [0x2d, 0xd4], polarity = 'ieee', gap = 2000 } = {}) {
  const sps = SYMBOL_US * 1e-6 * RATE, half = sps / 2;
  const bits = [];
  const pushByte = (b) => { for (let k = 7; k >= 0; k--) bits.push((b >> k) & 1); };

  for (const p of payloads) {
    for (let i = 0; i < 16; i++) bits.push(i % 2);      // preamble
    for (const b of sync) pushByte(b);
    const body = Uint8Array.from(p);
    for (const b of body) pushByte(b);
    const v = crc(body, spec);
    for (let i = spec.width / 8 - 1; i >= 0; i--) pushByte((v >>> (i * 8)) & 0xff);
    for (let i = 0; i < gap / sps; i++) { bits.push(-1); }   // silence between frames
  }

  const samples = Math.round(bits.length * sps) + 4000;
  const iq = new Float32Array(samples * 2);
  bits.forEach((bit, i) => {
    const on = (v) => v ? 0.7 : 0.02;                  // OOK: amplitude, not phase
    let first, second;
    if (bit < 0) { first = second = 0; }
    else {
      const one = polarity === 'ieee' ? bit : 1 - bit;
      first = one ? 0 : 1; second = one ? 1 : 0;
    }
    for (let s = 0; s < half; s++) {
      const k = 2000 + Math.round(i * sps) + s;
      if (k < samples) iq[k * 2] = bit < 0 ? 0.02 : on(first);
    }
    for (let s = 0; s < half; s++) {
      const k = 2000 + Math.round(i * sps + half) + s;
      if (k < samples) iq[k * 2] = bit < 0 ? 0.02 : on(second);
    }
  });

  const buf = new ArrayBuffer(samples * 8);
  new Float32Array(buf).set(iq);
  return new Capture({ buffer: buf, format: 'cf32', sampleRate: RATE, centerHz: CENTER, label: 'tx' });
}

async function chain(cap, ops) {
  const e = new MockEngine({ latency: false });
  await e.createSession();
  await e.openCapture(cap);
  let parent = e.root.id;
  const made = [];
  for (const op of ops) {
    const n = await e.addNode({ parent, op, at: 0.05,
      selection: { f0: CENTER - 40_000, f1: CENTER + 40_000 } });
    made.push(n);
    parent = n.id;
  }
  return { e, made };
}

test('the new operations appear where their stream types fit', async () => {
  const e = new MockEngine({ latency: false });
  await e.createSession();
  assert.equal(OPS['core.manchester'].in, 'real');
  assert.equal(OPS['core.manchester'].out, 'bytes');
  assert.equal(OPS['core.differential'].in, 'bytes');
  assert.equal(OPS['core.framer'].in, 'bytes');
  assert.equal(OPS['core.framer'].out, 'events');
});

test('a Manchester packet decodes, and says how it found the symbol rate', async () => {
  const spec = crcById('crc16-ccitt-false');
  const cap = transmit([[0x41, 0x42, 0x43]], { spec });
  const { e, made } = await chain(cap, ['core.am_envelope', 'core.manchester']);
  const man = made[1];

  // The sync word is what gives the bytes a boundary: the capture starts with silence
  // whose length is nothing in particular, so packing from sample zero packs from the
  // middle of a byte. This is the slicer's own alignment, for a chain with no framer.
  await e.setParam(man.id, 'syncHex', '2dd4');
  const sliced = await e.sliceBytes(man.id, null, 0.05);
  assert.ok(sliced, 'it produced bytes');
  assert.ok(sliced.syncAt >= 0, 'the sync word should be in there');

  const sym = e.node(man.id).params.symbolUs;
  assert.equal(sym.mode, 'auto');
  assert.ok(Math.abs(sym.value - SYMBOL_US) < SYMBOL_US * 0.08,
    `derived ${sym.value} µs, drawn at ${SYMBOL_US}`);
  assert.match(sym.auto.from, /one or two half-symbols/);
  assert.ok(sym.auto.confident);

  // Violations are counted over the whole capture, and most of this capture is the
  // silence either side of the packet — which has no transitions and so violates by
  // definition. What matters is that the packet itself came out.
  const text = [...sliced.bytes].map((x) => x.toString(16).padStart(2, '0')).join(' ');
  assert.ok(text.startsWith('41 42 43'), `the payload should follow the sync: ${text.slice(0, 60)}`);
});

test('a sync word settles the convention the signal cannot', async () => {
  const spec = crcById('crc16-ccitt-false');
  for (const polarity of ['ieee', 'thomas']) {
    const cap = transmit([[0x41, 0x42, 0x43]], { spec, polarity });
    const { e, made } = await chain(cap, ['core.am_envelope', 'core.manchester']);
    const man = made[1];
    const found = [];
    for (const p of ['ieee', 'thomas']) {
      await e.setParam(man.id, 'polarity', p);
      await e.setParam(man.id, 'syncHex', '2dd4');
      const r = await e.sliceBytes(man.id, null, 0.05);
      if (r && r.syncAt >= 0) found.push(p);
    }
    assert.deepEqual(found, [polarity],
      `only the convention it was drawn with should find the sync (drawn ${polarity})`);
  }
});

test('the framer finds the frames and derives the CRC that proves them', async () => {
  const spec = crcById('crc16-ccitt-false');
  const payloads = [[0x41, 0x42, 0x43], [0x44, 0x45], [0x46, 0x47, 0x48, 0x49]];
  const cap = transmit(payloads, { spec });
  const { e, made } = await chain(cap, ['core.am_envelope', 'core.manchester', 'core.framer']);
  const [, man, framer] = made;

  // Only the framer is told the sync word. The slicer would consume the first one
  // aligning to it, and the framer searches bit by bit so it needs no help.
  await e.setParam(framer.id, 'syncHex', '2dd4');
  const out = await e.runRecords(framer.id, 0.05);

  assert.equal(out.records.length, payloads.length,
    `expected ${payloads.length} frames, got ${out.records.length}`);

  const derived = e.node(framer.id).params.crc;
  assert.equal(derived.mode, 'auto');
  assert.ok(derived.auto.confident, `CRC not confidently derived: ${derived.auto.from}`);
  assert.match(derived.auto.from, /CRC-16\/CCITT-FALSE/);
  // frames are separated by dead air here, so the framer had to find where each ends
  assert.match(derived.auto.from, /ends in a valid|check out under/);
  assert.match(out.note, /pass CRC-16\/CCITT-FALSE/);

  // and the payloads are actually the payloads
  const texts = out.records.map((r) => r.text);
  assert.deepEqual(texts, ['41 42 43', '44 45', '46 47 48 49'],
    'the payloads, with the CRC and the dead air taken off');
  for (const r of out.records) assert.match(r.crc, /^ok/, `a frame failed its own CRC: ${r.text}`);
});

test('a CRC that validates nothing is reported as validating nothing', async () => {
  const spec = crcById('crc16-ccitt-false');
  const cap = transmit([[0x41, 0x42, 0x43], [0x44, 0x45]], { spec });
  const { e, made } = await chain(cap, ['core.am_envelope', 'core.manchester', 'core.framer']);
  const [, man, framer] = made;
  await e.setParam(man.id, 'syncHex', '2dd4');
  // frame on something that is not the frame boundary, so the trailing bytes are not a CRC
  await e.setParam(framer.id, 'syncHex', '41');
  const out = await e.runRecords(framer.id, 0.05);
  const derived = e.node(framer.id).params.crc;
  if (out.records.length) {
    assert.ok(!derived.auto.confident || /nothing in the catalog/.test(derived.auto.from),
      `should not claim a CRC for arbitrary boundaries: ${derived.auto.from}`);
  }
});

test('differential sits on bytes and hands bytes on', async () => {
  const spec = crcById('crc8');
  const cap = transmit([[0x41, 0x42, 0x43]], { spec });
  const { e, made } = await chain(cap,
    ['core.am_envelope', 'core.manchester', 'core.differential']);
  const diff = made[2];
  assert.equal(diff.out.kind, 'bytes');
  const r = await e.sliceBytes(diff.id, null, 0.05);
  assert.ok(r && r.bytes.length > 0, 'it produced bytes');

  // changing its mode changes its output, and the cache notices
  const first = [...r.bytes];
  await e.setParam(diff.id, 'mode', 'nrz-s');
  const again = await e.sliceBytes(diff.id, null, 0.05);
  assert.notDeepEqual([...again.bytes], first, 'nrz-s is not nrz-m');
});

test('a framer with no bytes above it says so rather than throwing', async () => {
  const spec = crcById('crc8');
  const cap = transmit([[0x41]], { spec });
  const { e, made } = await chain(cap, ['core.am_envelope', 'core.manchester', 'core.framer']);
  await e.setParam(made[2].id, 'syncHex', 'ffffffff');
  const out = await e.runRecords(made[2].id, 0.05);
  assert.equal(out.records.length, 0);
  assert.match(out.error, /does not appear/);
});

test('hex a person would type is read the way they meant it', () => {
  assert.deepEqual([...bytesOfHex('2d d4')], [0x2d, 0xd4]);
  assert.deepEqual([...bytesOfHex('0x2DD4')], [0x2d, 0xd4]);
});
