// What survives a reload.
//
//   node --test web/test/resume.test.mjs
//
// The bug was: clicking the browser's reload button lost the capture, the chain built on
// it, and every parameter turned by hand. There was nothing to lose it *from* — nothing
// in this tool is a document, so nothing had ever been written down.
//
// What is written down is a recipe, not a result (ADR-0032 already says a flowgraph is a
// program). The two claims worth testing are the ones that would make a restore worse
// than nothing: that a rebuilt graph is the same graph, and that a derived value is
// re-derived rather than pinned to whatever it measured last time.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as resume from '../src/resume.js';
import { MockEngine } from '../src/engine.js';
import { Capture } from '../src/capture.js';

const RATE = 240_000, CENTER = 98_500_000;

/** A capture with something on it: FM at the centre, a tone off to one side. */
async function engine() {
  const count = Math.round(RATE * 0.5);
  const buf = Buffer.allocUnsafe(count * 2);
  let phase = 0;
  for (let i = 0; i < count; i++) {
    phase += (2 * Math.PI * 8000 * Math.sin((2 * Math.PI * 1000 * i) / RATE)) / RATE;
    buf[i * 2] = Math.round(Math.cos(phase) * 110 + 127.5);
    buf[i * 2 + 1] = Math.round(Math.sin(phase) * 110 + 127.5);
  }
  const e = new MockEngine({ latency: false });
  await e.createSession();
  await e.openCapture(new Capture({
    buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    format: 'cu8', sampleRate: RATE, centerHz: CENTER, label: 'fm.sigmf-data',
  }));
  return e;
}

/** Tuner → FM demod → Listen, with one parameter turned by hand. */
async function chain(e) {
  const t = await e.addNode({ parent: e.root.id, op: 'core.tuner',
    selection: { f0: CENTER - 60_000, f1: CENTER + 60_000 }, at: 0.05 });
  const fm = await e.addNode({ parent: t.id, op: 'core.fm_discriminator', at: 0.05 });
  const a = await e.addNode({ parent: fm.id, op: 'core.audio', at: 0.05 });
  await e.setParam(a.id, 'volume', 0.42);
  await e.renameNode(t.id, 'the interesting one');
  return { t, fm, a };
}

const view = (e) => ({ source: { kind: 'library', id: 'cap-1', label: 'fm.sigmf-data' },
                       current: null, channel: null, tabs: new Map() });

// ── what gets written down ──────────────────────────────────────────────────

test('an empty graph is not worth remembering', async () => {
  const e = await engine();
  // Opening a capture and looking at its spectrum is what happens on load anyway, so
  // offering to restore it is an offer to do nothing, worded as a question.
  assert.equal(resume.recipe(e, view(e)), null);
});

test('a recipe is the chain, the decisions, and which capture', async () => {
  const e = await engine();
  const { t } = await chain(e);
  const r = resume.recipe(e, view(e));
  assert.equal(r.nodes.length, 3);
  assert.deepEqual(r.nodes.map((n) => n.op),
                   ['core.tuner', 'core.fm_discriminator', 'core.audio']);
  assert.equal(r.source.kind, 'library');
  assert.equal(r.source.id, 'cap-1');
  // The selection is reconstructed from the parameters it became, because `addNode` does
  // not keep it — after the first drag the parameters are the truth.
  const sel = r.nodes[0].selection;
  assert.ok(Math.abs(sel.f0 - (CENTER - 60_000)) < 1, `f0 ${sel.f0}`);
  assert.ok(Math.abs(sel.f1 - (CENTER + 60_000)) < 1, `f1 ${sel.f1}`);
  assert.equal(r.nodes[0].name, 'the interesting one');
  assert.equal(r.nodes[2].params.volume, 0.42);
});

test('a derived value is not written down', async () => {
  // The whole reason only `manual` travels: an auto value is a measurement of a signal,
  // and pinning last week's measurement to today's samples is how a parameter comes to
  // read one number and behave like another.
  const e = await engine();
  const { t, fm } = await chain(e);
  assert.equal(t.params.decim.mode, 'auto');
  assert.equal(fm.params.deviationHz.mode, 'auto');
  const r = resume.recipe(e, view(e));
  assert.ok(!r.nodes[0].params || !('decim' in r.nodes[0].params), 'decim is derived');
  assert.ok(!r.nodes[1].params || !('deviationHz' in r.nodes[1].params), 'deviation is derived');
});

test('a live radio is remembered as one that cannot come back', async () => {
  const e = await engine();
  await chain(e);
  e.capture.live = true;
  const r = resume.recipe(e, { source: null });
  assert.equal(r.source.kind, 'live');
  const can = resume.canReplay(r, {});
  assert.equal(can.ok, false);
  assert.match(can.why, /live radio/);
});

test('a dropped file says what it needs rather than failing halfway', async () => {
  const e = await engine();
  await chain(e);
  const r = resume.recipe(e, { source: { kind: 'file', label: 'mystery.cf32' } });
  assert.equal(r.source.kind, 'file');
  const can = resume.canReplay(r, { captures: [] });
  assert.equal(can.ok, false);
  assert.equal(can.awaitingFile, 'fm.sigmf-data');
});

test('a capture that is no longer on the box is said so, not attempted', async () => {
  const e = await engine();
  await chain(e);
  const r = resume.recipe(e, view(e));
  assert.equal(resume.canReplay(r, { captures: [] }).ok, false);
  assert.match(resume.canReplay(r, { captures: [] }).why, /no longer/);
  assert.equal(resume.canReplay(r, { captures: [{ id: 'cap-1', label: 'fm' }] }).ok, true);
});

// ── putting it back ─────────────────────────────────────────────────────────

test('a rebuilt graph is the same graph', async () => {
  const before = await engine();
  const made = await chain(before);
  const r = resume.recipe(before, view(before));

  const after = await engine();
  const done = await resume.replay(after, r);
  assert.equal(done.skipped.length, 0, JSON.stringify(done.skipped));
  assert.equal(done.made.length, 3);

  // Same shape, same rates, same decisions — and the derived values agree because they
  // were derived again from the same capture rather than copied.
  for (const was of [made.t, made.fm, made.a]) {
    const is = after.node(done.map.get(was.id));
    assert.ok(is, `${was.op} did not come back`);
    assert.equal(is.op, was.op);
    assert.equal(is.out.kind, was.out.kind);
    assert.equal(is.out.sampleRate, was.out.sampleRate);
    for (const [k, p] of Object.entries(was.params)) {
      if (p.mode === 'action') continue;
      assert.equal(is.params[k].mode, p.mode, `${was.op}.${k} mode`);
      if (typeof p.value === 'number') {
        assert.ok(Math.abs(is.params[k].value - p.value) < 1e-6,
                  `${was.op}.${k}: ${is.params[k].value} against ${p.value}`);
      } else {
        assert.equal(is.params[k].value, p.value, `${was.op}.${k}`);
      }
    }
  }
  assert.equal(after.node(done.map.get(made.t.id)).name, 'the interesting one');
  // And the tree is the tree, not three orphans off the root.
  assert.equal(after.node(done.map.get(made.fm.id)).parent, done.map.get(made.t.id));
  assert.equal(after.node(done.map.get(made.a.id)).parent, done.map.get(made.fm.id));
});

test('a second input comes back pointing at the node it pointed at', async () => {
  // The reason `replay` is two passes: a Math node names another node by id, and on the
  // first pass that node may not exist yet. Get this wrong and the restore is silently a
  // graph with one input where there were two (ADR-0038).
  const before = await engine();
  const a = await before.addNode({ parent: before.root.id, op: 'core.tuner',
    selection: { f0: CENTER - 40_000, f1: CENTER + 40_000 }, at: 0.05 });
  const b = await before.addNode({ parent: before.root.id, op: 'core.tuner',
    selection: { f0: CENTER + 10_000, f1: CENTER + 50_000 }, at: 0.05 });
  const m = await before.addNode({ parent: a.id, op: 'core.math', at: 0.05, withNode: b.id });
  await before.setParam(m.id, 'op', 'a*conj(b)');
  assert.equal(before.node(m.id).params.withNode.value, b.id, 'the fixture itself is wired');

  const r = resume.recipe(before, view(before));
  const after = await engine();
  const done = await resume.replay(after, r);
  const got = after.node(done.map.get(m.id));
  assert.equal(got.params.withNode.value, done.map.get(b.id), 'the second input followed the rename');
  assert.equal(got.params.op.value, 'a*conj(b)');
  assert.deepEqual(got.inputs, [done.map.get(a.id), done.map.get(b.id)]);
});

test('an operation that is gone costs one node, not the chain', async () => {
  // A plugin that was not dropped back in, or a decoder uninstalled since. The rest of
  // the graph is still worth having, and what did not come back is named rather than
  // quietly missing.
  const e = await engine();
  await chain(e);
  const r = resume.recipe(e, view(e));
  r.nodes.splice(1, 0, { id: 'gone', op: 'ext.nothing_like_this', parent: r.nodes[0].id });

  const after = await engine();
  const done = await resume.replay(after, r);
  assert.equal(done.made.length, 3);
  assert.equal(done.skipped.length, 1);
  assert.equal(done.skipped[0].op, 'ext.nothing_like_this');
  // Its child is not lost with it — it lands on the root, which is visible and
  // recoverable, rather than being dropped.
  assert.ok(after.node(done.map.get(r.nodes[2].id)), 'the node below it still came back');
});

// ── the store ───────────────────────────────────────────────────────────────

test('the store is a store, and a stale recipe is not offered', async () => {
  // `localStorage` is not in node, so this is the shape of one. The module reads it
  // through a guarded accessor precisely because a browser can refuse — private mode,
  // cleared site data, a quota — and a tool that throws on load because it could not
  // remember something is worse than one that forgets.
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
  try {
    const e = await engine();
    await chain(e);
    assert.equal(resume.saved(), null, 'nothing has been written yet');
    resume.remember(e, view(e));
    const back = resume.saved();
    assert.equal(back.nodes.length, 3);

    // Eight days old: not what anybody meant by "what I had open", and reading it drops it.
    const stale = JSON.parse(mem.get('sdrflex.session.v1'));
    stale.at = Date.now() - 8 * 24 * 3600 * 1000;
    mem.set('sdrflex.session.v1', JSON.stringify(stale));
    assert.equal(resume.saved(), null);
    assert.equal(mem.has('sdrflex.session.v1'), false, 'and is thrown away rather than re-read');

    resume.remember(e, view(e));
    resume.forget();
    assert.equal(resume.saved(), null);
  } finally {
    delete globalThis.localStorage;
  }
});

test('a browser that refuses to remember is a browser that does not resume', async () => {
  // Private mode throws on the accessor itself, not on the call.
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('the operation is insecure'); },
  });
  try {
    const e = await engine();
    await chain(e);
    assert.doesNotThrow(() => resume.remember(e, view(e)));
    assert.equal(resume.saved(), null);
    assert.doesNotThrow(() => resume.forget());
  } finally {
    delete globalThis.localStorage;
  }
});
