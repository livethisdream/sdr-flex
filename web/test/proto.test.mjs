// The wire format: what goes in comes out, and samples never become text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode } from '../src/proto.js';

const round = (m) => decode(encode(m));

test('scalars and structure survive a round trip', () => {
  const m = { id: 7, t: 'ok', v: { s: 'hi', n: null, b: true, f: 1.5, deep: { a: [1, 2, 3] } } };
  assert.deepEqual(round(m), m);
});

test('a typed array comes back as the same type and contents', () => {
  const f = new Float32Array([1, -2, 3.5, 1e-9]);
  const out = round({ v: f }).v;
  assert.ok(out instanceof Float32Array);
  assert.deepEqual([...out], [...f]);
});

test('a subarray travels as its own array, not its backing buffer', () => {
  const big = new Float32Array(4096).map((_, i) => Math.sin(i));
  const out = round({ v: big.subarray(10, 1034) }).v;
  assert.equal(out.length, 1024);
  assert.equal(out[0], big[10]);
  assert.equal(out[1023], big[1033]);
});

test('arrays nested anywhere are found', () => {
  const m = { v: { rows: [{ bytes: new Uint8Array([1, 2, 255]) }, { x: new Int16Array([-1, 5]) }] } };
  const out = round(m).v;
  assert.ok(out.rows[0].bytes instanceof Uint8Array);
  assert.equal(out.rows[0].bytes[2], 255);
  assert.ok(out.rows[1].x instanceof Int16Array);
  assert.equal(out.rows[1].x[0], -1);
});

test('float views land aligned, so decoding costs no copy', () => {
  for (const pad of ['', 'x', 'xx', 'xxx', 'xxxxx']) {
    const out = decode(encode({ pad, v: new Float64Array([1, 2]) }));
    assert.equal(out.v.byteOffset % 8, 0);
    assert.deepEqual([...out.v], [1, 2]);
  }
});

test('overhead over the samples themselves stays small', () => {
  const buf = encode({ id: 1, t: 'ok', v: { kind: 'spectrum', data: new Float32Array(1024) } });
  assert.ok(buf.byteLength < 4096 + 256, `${buf.byteLength} bytes for 4 KB of samples`);
});

test('decodes from a Buffer that starts partway into its own memory', () => {
  // Node hands sockets exactly this, and getting it wrong reads the previous message
  const buf = encode({ v: new Float32Array([9, 8, 7]) });
  const holder = new Uint8Array(buf.byteLength + 3);
  holder.set(new Uint8Array(buf), 3);
  assert.deepEqual([...decode(holder.subarray(3)).v], [9, 8, 7]);
});

test('an empty message is legal', () => {
  assert.deepEqual(round({}), {});
});
