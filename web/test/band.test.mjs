// Dragging a channel's band on its parent's spectrum (web/src/band.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { dragBand } from '../src/band.js';

const base = { c0: 100_000, w0: 20_000, lo: 0, hi: 500_000, minW: 1_000, maxW: 50_000 };

test('the middle moves the band and keeps its width', () => {
  assert.deepEqual(dragBand({ ...base, edge: 'move', d: 30_000 }), { c: 130_000, w: 20_000 });
});

test('an edge resizes the band and the other edge stays put', () => {
  const r = dragBand({ ...base, edge: 'r', d: 10_000 });
  assert.deepEqual(r, { c: 105_000, w: 30_000 });
  assert.equal(r.c - r.w / 2, 90_000, 'left edge unchanged');
  const l = dragBand({ ...base, edge: 'l', d: -6_000 });
  assert.equal(l.c + l.w / 2, 110_000, 'right edge unchanged');
  assert.equal(l.w, 26_000);
});

test('the width stops at the tuner\'s rate and at its floor', () => {
  assert.equal(dragBand({ ...base, edge: 'r', d: 400_000 }).w, 50_000);
  assert.equal(dragBand({ ...base, edge: 'r', d: -19_900 }).w, 1_000);
  // dragged past the other edge, it stops at its narrowest against that edge
  assert.deepEqual(dragBand({ ...base, edge: 'r', d: -60_000 }), { c: 90_500, w: 1_000 });
  assert.deepEqual(dragBand({ ...base, edge: 'l', d: 60_000 }), { c: 109_500, w: 1_000 });
});

test('the band stays inside its parent\'s', () => {
  assert.deepEqual(dragBand({ ...base, edge: 'move', d: -500_000 }), { c: 10_000, w: 20_000 });
  assert.deepEqual(dragBand({ ...base, edge: 'move', d: 900_000 }), { c: 490_000, w: 20_000 });
});
