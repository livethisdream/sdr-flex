// CRCs, framing, and the derivation that makes them worth having: a check that says
// "yes, this is the packet" rather than one more field to squint at.

import test from 'node:test';
import assert from 'node:assert/strict';
import { crc, CRCS, detectCrc, checkFrame, findFrames, bytesOfHex, crcById } from '../src/frames.js';

const CHECK = new TextEncoder().encode('123456789');
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');

test('every CRC in the catalog matches its published check value', () => {
  // The catalog's own check value for "123456789" — the standard way each of these is
  // verified rather than trusted. A transposed constant fails here and nowhere else.
  for (const c of CRCS) {
    assert.equal(crc(CHECK, c), c.check, `${c.name} over "123456789"`);
  }
});

test('a CRC changes when any byte does', () => {
  for (const c of CRCS) {
    const a = crc(CHECK, c);
    const bumped = Uint8Array.from(CHECK);
    bumped[4] ^= 0x01;
    assert.notEqual(crc(bumped, c), a, `${c.name} did not notice a flipped bit`);
  }
});

/** Append `spec`'s CRC to a payload, the way a transmitter would. */
function withCrc(payload, spec, littleEndian = false) {
  const n = spec.width / 8;
  const out = new Uint8Array(payload.length + n);
  out.set(payload);
  const v = crc(payload, spec);
  for (let i = 0; i < n; i++) {
    const shift = littleEndian ? i * 8 : (n - 1 - i) * 8;
    out[payload.length + i] = (v >>> shift) & 0xff;
  }
  return out;
}

test('the CRC that validates a set of frames is found, not configured', () => {
  const spec = crcById('crc16-ccitt-false');
  const frames = [
    withCrc(Uint8Array.from([1, 2, 3, 4]), spec),
    withCrc(Uint8Array.from([9, 9, 9, 9, 9]), spec),
    withCrc(Uint8Array.from([0xde, 0xad, 0xbe, 0xef]), spec),
  ];
  const got = detectCrc(frames);
  assert.ok(got, 'nothing detected');
  assert.equal(got.id, 'crc16-ccitt-false');
  assert.equal(got.littleEndian, false);
  assert.equal(got.frames, 3);
  assert.match(got.from, /all 3 frames check out under CRC-16\/CCITT-FALSE, big-endian/);
  assert.ok(got.confident, 'three frames agreeing is not a coincidence');
});

test('byte order is part of the answer', () => {
  const spec = crcById('crc16-arc');
  const frames = [
    withCrc(Uint8Array.from([1, 2, 3, 4, 5]), spec, true),
    withCrc(Uint8Array.from([6, 7, 8, 9, 10]), spec, true),
  ];
  const got = detectCrc(frames);
  assert.ok(got);
  assert.equal(got.littleEndian, true);
  assert.match(got.from, /little-endian/);
});

test('a 1-Wire CRC-8 is found too, which is half the cheap sensors on the band', () => {
  const spec = crcById('crc8-maxim');
  const frames = [1, 2, 3, 4, 5].map((n) =>
    withCrc(Uint8Array.from([n, n + 1, n + 2, n + 3, n + 4, n + 5]), spec));
  const got = detectCrc(frames);
  assert.ok(got);
  assert.equal(got.id, 'crc8-maxim');
  assert.equal(got.frames, 5);
});

test('a frame followed by dead air is still found, at its real length', () => {
  // Frames in a real capture are separated by silence, so what the framer cuts is the
  // frame plus whatever came after it until the next sync.
  const spec = crcById('crc16-ccitt-false');
  const withTail = (payload, tail) => {
    const core = withCrc(Uint8Array.from(payload), spec);
    const out = new Uint8Array(core.length + tail.length);
    out.set(core); out.set(tail, core.length);
    return out;
  };
  const frames = [
    withTail([0x41, 0x42, 0x43], [0, 0, 0x05, 0x55]),
    withTail([0x44, 0x45], [0, 0, 0x05, 0x55]),
    withTail([0x46, 0x47, 0x48, 0x49], [0, 0, 0, 0]),
  ];
  const got = detectCrc(frames);
  assert.ok(got, 'should find it despite the tails');
  assert.equal(got.id, 'crc16-ccitt-false');
  assert.ok(got.trimmed, 'and should say it had to work out where the frames end');
  // Most of these CRCs check out as zero once the remainder is appended, so a frame
  // trailed by null bytes validates at its true length and at every pair beyond it.
  // Only the shortest is the frame.
  assert.deepEqual(got.lengths, [5, 4, 6]);
  assert.match(got.from, /with dead air after it/);
});

test('the length search is not offered to short CRCs, where it would find noise', () => {
  // Forty length trials against an eight-bit CRC is forty chances in 256 per frame.
  // That finds a CRC in almost anything, which is worse than finding none.
  const junk = [
    Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
    Uint8Array.from([13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]),
    Uint8Array.from([25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36]),
  ];
  const got = detectCrc(junk);
  assert.ok(!got || got.width >= 16, `an 8-bit CRC should never be found by searching lengths: ${got && got.name}`);
});

test('frames that do not check out under anything report nothing', () => {
  const frames = [
    Uint8Array.from([1, 2, 3, 4, 5, 6]),
    Uint8Array.from([7, 8, 9, 10, 11, 12]),
    Uint8Array.from([13, 14, 15, 16, 17, 18]),
  ];
  assert.equal(detectCrc(frames), null, 'random bytes must not find a CRC that fits');
});

test('one frame agreeing is reported without confidence', () => {
  // A single short frame matching an 8-bit CRC is a 1-in-256 coincidence and will
  // happen constantly. Reporting it is fine; calling it confident is not.
  const spec = crcById('crc8');
  const got = detectCrc([withCrc(Uint8Array.from([1, 2, 3]), spec)]);
  assert.ok(got);
  assert.equal(got.frames, 1);
  assert.equal(got.confident, false);
});

test('checkFrame says which frame is the bad one', () => {
  const spec = { ...crcById('crc16-ccitt-false'), littleEndian: false };
  const good = withCrc(Uint8Array.from([1, 2, 3, 4]), spec);
  const bad = Uint8Array.from(good);
  bad[1] ^= 0x20;
  assert.equal(checkFrame(good, spec).ok, true);
  assert.equal(checkFrame(bad, spec).ok, false);
  assert.equal(checkFrame(Uint8Array.from([1]), spec).checked, false, 'too short to check');
});

test('a sync word that is not byte-aligned is still found', () => {
  // Nothing makes a second packet start a whole number of bytes after the first, so a
  // byte-aligned search finds one frame in a capture full of them.
  const payload = [0xaa, 0x55, 0x11, 0x22, 0x33];
  const bits = [];
  for (let i = 0; i < 5; i++) bits.push(1);            // five bits of nothing in front
  for (const b of payload) for (let k = 7; k >= 0; k--) bits.push((b >> k) & 1);
  const packed = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((v, i) => { if (v) packed[i >> 3] |= 1 << (7 - (i & 7)); });

  const frames = findFrames(packed, { syncBytes: bytesOfHex('aa55') });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].bit, 5, 'found at a bit offset no byte search would reach');
  assert.equal(hex(frames[0].bytes), '11 22 33');
});

test('a sync word splits a stream into frames', () => {
  const sync = bytesOfHex('aa 55');
  const stream = Uint8Array.from([
    0x00, 0x13,                      // junk before the first frame
    0xaa, 0x55, 1, 2, 3,
    0xaa, 0x55, 4, 5, 6, 7,
    0xaa, 0x55, 8,
  ]);
  const frames = findFrames(stream, { syncBytes: sync });
  assert.equal(frames.length, 3);
  assert.equal(hex(frames[0].bytes), '01 02 03');
  assert.equal(hex(frames[1].bytes), '04 05 06 07');
  assert.equal(hex(frames[2].bytes), '08');
  assert.equal(frames[0].at, 2, 'and says where in the stream it was');
  assert.equal(frames[0].bit, 16, 'to the bit, since nothing makes a frame start on a byte');
});

test('a fixed frame length is honored when given', () => {
  const stream = Uint8Array.from([0xaa, 0x55, 1, 2, 3, 4, 5, 6, 0xaa, 0x55, 7, 8, 9, 10]);
  const frames = findFrames(stream, { syncBytes: bytesOfHex('aa55'), frameBytes: 3 });
  assert.equal(hex(frames[0].bytes), '01 02 03');
  assert.equal(hex(frames[1].bytes), '07 08 09');
});

test('with no sync word the whole stream is one frame', () => {
  const frames = findFrames(Uint8Array.from([1, 2, 3]), {});
  assert.equal(frames.length, 1);
  assert.equal(hex(frames[0].bytes), '01 02 03');
  assert.equal(findFrames(new Uint8Array(0), {}).length, 0);
});

test('hex is read the way it is written down', () => {
  assert.equal(hex(bytesOfHex('aa55')), 'aa 55');
  assert.equal(hex(bytesOfHex('0xAA 0x55')), 'aa 55');
  assert.equal(hex(bytesOfHex('AA-55-3C')), 'aa 55 3c');
  assert.equal(bytesOfHex('').length, 0);
  assert.equal(hex(bytesOfHex('aaa')), 'aa', 'an odd nibble is dropped, not guessed at');
});

test('sync, split and check together, as a chain would', () => {
  const spec = crcById('crc16-xmodem');
  const sync = bytesOfHex('2dd4');
  const payloads = [[0x41, 0x42], [0x43, 0x44, 0x45], [0x46]];
  const parts = [Uint8Array.from([0xff, 0x00])];
  for (const p of payloads) { parts.push(sync, withCrc(Uint8Array.from(p), spec)); }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const stream = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { stream.set(p, off); off += p.length; }

  const frames = findFrames(stream, { syncBytes: sync });
  assert.equal(frames.length, 3);
  const got = detectCrc(frames.map((f) => f.bytes));
  assert.ok(got, 'the CRC should fall out of three good frames');
  assert.equal(got.id, 'crc16-xmodem');
  for (const f of frames) assert.equal(checkFrame(f.bytes, got).ok, true);
});
