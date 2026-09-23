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
  if (opts.speed != null) g.speed = opts.speed;
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

// ── playback speed ──────────────────────────────────────────────────────────

// `at()` sets `_last` and `tick()` reads the clock again, so the delta is the asked-for
// milliseconds plus however long that took. A wall clock is not exact and pretending it
// is makes a test that fails on a busy machine; a millisecond of slack is far tighter
// than the factors of two being checked.
const SLACK = 0.002;

test('full speed is a second of capture per second of wall clock', () => {
  assert.equal(new Graph().speed, 1);
  const g = at(0.1, 50);
  assert.ok(Math.abs((g.t - 0.1) - 0.050) < SLACK, `advanced ${((g.t - 0.1) * 1000).toFixed(2)} ms`);
});

test('half speed advances the clock at half the rate', () => {
  // Slowing a recording down is the oldest trick in listening to radio, and it belongs
  // on the clock rather than on the speaker: the waterfall, the playhead and the
  // decoders reading blocks as it plays all follow the clock, so audio that slowed down
  // by itself would drift away from the picture of it.
  for (const [speed, want] of [[1, 0.050], [0.5, 0.025], [0.25, 0.0125]]) {
    const g = at(0.1, 50, { speed });
    const got = g.t - 0.1;
    assert.ok(Math.abs(got - want) < SLACK,
              `${speed}x advanced ${(got * 1000).toFixed(2)} ms, wanted ${want * 1000}`);
    // And the ratio, which no amount of timer jitter can move: each step is half the one
    // before it, which is what makes the cycle an octave at a time by ear.
    assert.ok(Math.abs(got / speed - 0.050) < SLACK / speed,
              `${speed}x does not scale: ${(got / speed * 1000).toFixed(2)} ms at full speed`);
  }
});

test('a speed of nothing is full speed rather than a stopped clock', () => {
  // `speed` is read on the hot path and an engine restored from an older stored session,
  // or a Graph somebody built by hand, will not have one. Zero would look exactly like
  // a hang, which is the worst way for a missing field to present.
  for (const bad of [undefined, null, 0, NaN]) {
    const g = new Graph();
    g.capture = { durationS: 0.68 };
    g.playing = true;
    g.speed = bad;
    g.t = 0.1;
    g._last = performance.now() - 50;
    g.tick();
    assert.ok(g.t > 0.1, `speed ${String(bad)} stopped the clock at ${g.t}`);
  }
});

test('slowing down does not let a background tab fast-forward', () => {
  // The clamp is against the wall, not the capture: a tab that was hidden for a minute
  // steps 0.1 s whatever speed it is playing at, and at a quarter speed that is 25 ms.
  const g = at(0.1, 60_000, { speed: 0.25 });
  assert.ok(Math.abs((g.t - 0.1) - 0.025) < SLACK, `advanced ${((g.t - 0.1) * 1000).toFixed(1)} ms`);
});
