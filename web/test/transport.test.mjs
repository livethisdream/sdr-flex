// The clock. Short captures are the normal case here — a fixture is two thirds of a
// second, a burst is forty milliseconds — so what happens at the end of one is not an
// edge case, it is most of what you see.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/graph.js';

/** A graph holding a capture, with the clock at `t` and `ms` of real time elapsed. */
function at(t, ms, opts = {}) {
  const g = new Graph();
  g.capture = { durationS: 0.68, ...opts.capture };
  g.playing = true;
  if (opts.loop != null) g.loop = opts.loop;
  g.t = t;
  g._last = performance.now() - ms;
  g.tick();
  return g;
}

test('looping is on by default, because a pinned clip always looped', () => {
  // The inconsistency this fixes: a time-boxed clip has looped since ADR-0023, which
  // is what makes a 40 ms burst watchable. A whole capture stopping dead was the odd
  // one out, and on a short one it is the only behavior you ever see.
  assert.equal(new Graph().loop, true);
});

test('inside the capture the clock just advances', () => {
  const g = at(0.6, 50);
  assert.ok(g.t > 0.6 && g.t < 0.68, `t=${g.t}`);
  assert.equal(g.ended, false);
  assert.equal(g.playing, true);
});

test('past the end it wraps and keeps playing', () => {
  // `tick` clamps a step to 100 ms however long the frame took, so this advances to
  // 0.70 rather than 0.80 and wraps to 0.02. The clamp is why a slow frame cannot
  // teleport the playhead, and it is doing most of the work in the next test too.
  const g = at(0.6, 200);
  assert.ok(g.t >= 0 && g.t < 0.68, `wrapped to ${g.t}`);
  assert.ok(Math.abs(g.t - 0.02) < 0.005, `should keep the remainder, got ${g.t}`);
  assert.equal(g.ended, false, 'a loop never ends');
  assert.equal(g.playing, true);
  assert.equal(g.wrapped, 1, 'and it counts the wrap, so a view can notice the seam');
});

test('a stalled frame cannot throw the playhead out of the capture', () => {
  // A hundred seconds of wall clock between frames — a tab that was backgrounded.
  // The step clamp catches this before the wrap does, and both would.
  const g = at(0.1, 100_000);
  assert.ok(g.t >= 0 && g.t < 0.68, `t=${g.t}`);
  assert.equal(g.playing, true);
});

test('with looping off it stops at the end and says so', () => {
  const g = at(0.67, 200, { loop: false });
  assert.equal(g.t, 0.68);
  assert.equal(g.ended, true);
  assert.equal(g.playing, false);
});

test('a radio has no end to wrap at', () => {
  // A live source is still being written; its clock rides the head rather than
  // looping back to the beginning of a recording that is still growing (ADR-0030).
  const g = at(4.9, 400, { capture: { durationS: 5, live: true, windowS: [1, 5] } });
  assert.equal(g.ended, false);
  assert.ok(g.t <= 5 && g.t >= 1, `t=${g.t}`);
  assert.equal(g.wrapped, undefined, 'and it did not wrap');
});

test('the synthetic scene does not end either', () => {
  const g = new Graph();                 // no capture at all
  g.playing = true;
  g.t = 5;
  g._last = performance.now() - 100;
  g.tick();
  assert.ok(g.t > 5, 'it just keeps going');
  assert.equal(g.ended, false);
});

test('a pinned clip still loops within its own box', () => {
  const g = new Graph();
  g.capture = { durationS: 100 };
  g.playing = true;
  g.t = 1;
  const clip = { id: 'n2', parent: null, params: {
    timeMode: { value: 'pinned' }, t0: { value: 2.0 }, t1: { value: 2.1 },
    rate: { value: 1, mode: 'manual' },
  } };
  g.nodes.set('n2', clip);
  clip._t = 2.09;
  g._last = performance.now() - 50;
  g.tick();
  assert.ok(clip._t >= 2.0 && clip._t <= 2.1, `clip wrapped inside its box: ${clip._t}`);
});
