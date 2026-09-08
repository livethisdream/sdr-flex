// The ring recording. Its whole job is to make "live" indistinguishable from "file"
// downstream (ADR-0005), and the places that can go wrong are the wrap point, the two
// edges of the window, and a writer that hands over half a sample.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ring } from '../../server/ring.js';

const RATE = 1000;
let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdrflex-ring-')); });
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** cu8 bytes whose value encodes the sample index, so a read can be checked exactly. */
const bytesFor = (from, n) => {
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) { b[i * 2] = (from + i) & 0xff; b[i * 2 + 1] = ((from + i) >> 8) & 0xff; }
  return b;
};
const iOf = (f32, k) => Math.round(f32[k * 2] * 127.5 + 127.5);
const qOf = (f32, k) => Math.round(f32[k * 2 + 1] * 127.5 + 127.5);

const ring = (seconds = 1) => new Ring({
  path: path.join(dir, `r${Math.random().toString(36).slice(2)}.bin`),
  format: 'cu8', sampleRate: RATE, centerHz: 100e6, seconds,
});

test('an empty ring holds nothing and has no duration', () => {
  const r = ring();
  assert.deepEqual(r.window(), [0, 0]);
  assert.equal(r.durationS, 0);
  r.close();
});

test('what goes in comes back out at the same absolute index', () => {
  const r = ring();
  r.write(bytesFor(0, 500));
  assert.deepEqual(r.window(), [0, 500]);
  assert.equal(r.durationS, 0.5);
  const got = r.read(100, 50);
  for (let k = 0; k < 50; k++) assert.equal(iOf(got, k), (100 + k) & 0xff, `sample ${100 + k}`);
  r.close();
});

test('reads that straddle the wrap point are still contiguous', () => {
  const r = ring();                       // 1000 samples
  r.write(bytesFor(0, 1600));             // wrapped once; 600..1600 survive
  assert.deepEqual(r.window(), [600, 1600]);
  // 950..1050 crosses the physical seam at slot 0
  const got = r.read(950, 100);
  for (let k = 0; k < 100; k++) {
    assert.equal(iOf(got, k), (950 + k) & 0xff, `sample ${950 + k} across the seam`);
    assert.equal(qOf(got, k), ((950 + k) >> 8) & 0xff, `high byte of ${950 + k}`);
  }
  r.close();
});

test('a write larger than the ring itself leaves the newest samples', () => {
  const r = ring();
  r.write(bytesFor(0, 2500));
  assert.deepEqual(r.window(), [1500, 2500]);
  const got = r.read(2400, 100);
  for (let k = 0; k < 100; k++) assert.equal(iOf(got, k), (2400 + k) & 0xff);
  r.close();
});

test('the future reads as zeros, the way the end of a file does', () => {
  const r = ring();
  r.write(bytesFor(0, 100));
  const got = r.read(50, 100);            // 50 real samples, then 50 not yet recorded
  assert.equal(iOf(got, 10), 60);
  for (let k = 50; k < 100; k++) {
    assert.equal(got[k * 2], 0, `sample ${50 + k} has not happened yet`);
  }
  r.close();
});

test('the expired past throws rather than lying about it', () => {
  const r = ring();
  r.write(bytesFor(0, 1600));             // 0..600 are gone
  assert.throws(() => r.read(100, 10), /scrolled out of the ring/);
  assert.doesNotThrow(() => r.read(600, 10), 'the oldest surviving sample is readable');
  r.close();
});

test('a sample split across two writes is not torn', () => {
  const r = ring();
  const whole = bytesFor(0, 10);
  r.write(whole.subarray(0, 7));          // three and a half samples
  assert.equal(r.head, 3, 'the half sample is held back, not counted');
  r.write(whole.subarray(7));
  assert.equal(r.head, 10);
  const got = r.read(0, 10);
  for (let k = 0; k < 10; k++) assert.equal(iOf(got, k), k, `sample ${k} after a split write`);
  r.close();
});

test('history moving under a cached read is noticed', () => {
  const r = ring();
  r.write(bytesFor(0, 500));
  const first = [...r.read(400, 50).slice(0, 4)];
  r.write(bytesFor(500, 100));            // 400..450 is unchanged, but the cache is stale
  const again = [...r.read(400, 50).slice(0, 4)];
  assert.deepEqual(again, first, 'the same samples still read the same');
  const fresh = r.read(520, 20);
  assert.equal(iOf(fresh, 0), 520 & 0xff, 'and the new samples are visible immediately');
  r.close();
});

test('the file on disk is the size it said it would be, and no larger', () => {
  const r = ring(2);
  r.write(bytesFor(0, 50_000));           // far more than the ring holds
  const st = fs.statSync(r.path);
  assert.equal(st.size, 2 * RATE * 2, 'two seconds of cu8, regardless of how much went through');
  r.close();
});

test('closing it takes the recording with it', () => {
  const r = ring();
  const p = r.path;
  r.write(bytesFor(0, 10));
  assert.ok(fs.existsSync(p));
  r.close();
  assert.ok(!fs.existsSync(p), 'a ring is scratch space, not a capture you meant to keep');
});
