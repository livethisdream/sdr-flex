// Lining frames up and finding the bits that change (compare.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXED, VARIES, MISSING, groupByLength, columns, runs, field, hexOf, bitsOfBytes }
  from '../src/compare.js';

const row = (...bytes) => bitsOfBytes(Uint8Array.from(bytes));

test('frames group by length, the largest group first', () => {
  const frames = [row(1, 2), row(1, 2, 3), row(4, 5), row(6, 7)].map((bits) => ({ bits }));
  assert.deepEqual(groupByLength(frames), [
    { length: 16, members: [0, 2, 3] },
    { length: 24, members: [1] },
  ]);
});

test('a column is fixed, varies, or missing in some frame', () => {
  const rows = ['0101', '0111', '011'];
  assert.deepEqual([...columns(rows)], [FIXED, FIXED, VARIES, MISSING]);
});

test('one frame alone has nothing varying', () => {
  assert.deepEqual([...columns([row(0xa5)])], new Array(8).fill(FIXED));
});

test('a byte column varies if any bit in it does, and a part-byte is missing', () => {
  const rows = [row(0x2d, 0x00) + '1', row(0x2d, 0x01) + '1'];
  assert.deepEqual([...columns(rows, 8)], [FIXED, VARIES, MISSING]);
});

test('runs collapse a column state into spans', () => {
  assert.deepEqual(runs(Uint8Array.from([FIXED, FIXED, VARIES, MISSING, MISSING])), [
    { from: 0, to: 2, state: FIXED },
    { from: 2, to: 3, state: VARIES },
    { from: 3, to: 5, state: MISSING },
  ]);
});

test('a field is read out of every frame, and a counter says it is one', () => {
  const rows = [0xfe, 0xff, 0x00, 0x01].map((c) => row(0x2d, c));
  const f = field(rows, 8, 16);
  assert.deepEqual(f.values, [0xfen, 0xffn, 0n, 1n]);
  assert.equal(f.step, 1n, 'it wraps and still counts');
  assert.equal(hexOf(f.values[0], f.width), 'fe');
});

test('a field that wanders is not a counter, and a short frame has no value', () => {
  const f = field([row(5), row(9), row(6), '0101'], 0, 8);
  assert.equal(f.step, null);
  assert.equal(f.values[3], null);
});

test('two frames are not enough to call something a counter', () => {
  assert.equal(field([row(1), row(2)], 0, 8).step, null);
});

test('a field wider than a double still reads exactly', () => {
  const r = row(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
  assert.equal(hexOf(field([r], 0, 64).values[0], 64), 'ffffffffffffffff');
});
