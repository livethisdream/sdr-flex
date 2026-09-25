// Work that outlives the tab.
//
//   node --test web/test/sessions.test.mjs
//
// `resume.test.mjs` next door tests the recipe: that a rebuilt graph is the same graph
// and that a derived value is re-derived. None of that is repeated here. What this tests
// is the part a named session adds — somewhere to put one, a way to find it again, and
// the two answers to "where" being the same shape so a session written by one store is
// readable by the other.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import * as sessions from '../src/sessions.js';
import * as resume from '../src/resume.js';
import { SessionStore } from '../../server/sessions.js';
import { createServer, CONFIG, sessionDirFor } from '../../server/main.js';
import { MockEngine } from '../src/engine.js';
import { RemoteEngine } from '../src/remote.js';
import { Capture } from '../src/capture.js';

const RATE = 240_000, CENTER = 98_500_000;

/** A capture with a chain on it, which is the thing worth saving. */
async function built() {
  const count = Math.round(RATE * 0.3);
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
  const t = await e.addNode({ parent: e.root.id, op: 'core.tuner',
    selection: { f0: CENTER - 60_000, f1: CENTER + 60_000 }, at: 0.05 });
  const fm = await e.addNode({ parent: t.id, op: 'core.fm_discriminator', at: 0.05 });
  await e.setParam(fm.id, 'deviationHz', 7500);
  return e;
}

const view = () => ({ source: { kind: 'library', id: 'fm.sigmf-data', label: 'fm' },
                      current: null, channel: null, tabs: new Map() });

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdrflex-sessions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** A localStorage that is a Map, so a test is not at the mercy of a global. */
const fakeStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null),
           setItem: (k, v) => m.set(k, String(v)),
           removeItem: (k) => m.delete(k), _m: m };
};

// ── the id ──────────────────────────────────────────────────────────────────

test('an id is safe to be a filename, because it becomes one', () => {
  // The server turns an id into a path. This is the only place a name somebody typed
  // gets to influence that, so what it strips is the whole of the defence.
  for (const nasty of ['../../etc/passwd', 'a/b/c', '..', '....//....', 'C:\\windows',
                       'nul\u0000byte', '   ', '<script>']) {
    const id = sessions.idFor(nasty);
    assert.match(id, sessions.ID_RE, `${JSON.stringify(nasty)} became ${id}`);
    assert.equal(path.basename(id), id, 'and it is one path component');
  }
});

test('two sessions with the same name are two sessions', () => {
  const a = sessions.idFor('fm'), b = sessions.idFor('fm');
  assert.notEqual(a, b, `${a} and ${b}`);
  assert.match(a, /^fm-/);
});

test('a name that is all punctuation still gets an id', () => {
  assert.match(sessions.idFor('!!!'), sessions.ID_RE);
  assert.match(sessions.idFor(''), /^session-/);
});

// ── what is worth saving ────────────────────────────────────────────────────

test('a radio is refused, and says why rather than saving something that cannot open', async () => {
  // The samples a radio was reading are gone. `resume.canReplay` already declines to
  // restore one; a list that offers to open something that can never open is worse.
  const r = { source: { kind: 'live', label: 'rtl-sdr' }, nodes: [{ id: 'a', op: 'core.tuner' }] };
  const can = sessions.canSave(r);
  assert.equal(can.ok, false);
  assert.match(can.why, /radio/);
});

test('an empty graph produces no recipe, so there is nothing to name', async () => {
  const e = new MockEngine({ latency: false });
  await e.createSession();
  assert.equal(sessions.fromEngine(e, view(), 'nothing'), null);
});

// ── the local store ─────────────────────────────────────────────────────────

test('a session saved in the browser comes back the same', async () => {
  const e = await built();
  const store = new sessions.LocalStore(fakeStorage());
  const rec = sessions.fromEngine(e, view(), 'the FM one');
  await store.save(rec);

  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'the FM one');
  assert.equal(listed[0].nodes, 2);
  // A listing carries what it takes to draw a line and not the recipe itself.
  assert.equal(listed[0].recipe, undefined);

  const back = await store.load(rec.id);
  assert.deepEqual(back.recipe, rec.recipe);
});

test('saving under the same id replaces rather than accumulates', async () => {
  const e = await built();
  const store = new sessions.LocalStore(fakeStorage());
  const first = sessions.fromEngine(e, view(), 'work');
  await store.save(first);
  await e.addNode({ parent: e.root.id, op: 'core.tuner',
    selection: { f0: CENTER, f1: CENTER + 20_000 }, at: 0.05 });
  const second = sessions.make('work', resume.recipe(e, view()), { id: first.id });
  await store.save(second);

  const listed = await store.list();
  assert.equal(listed.length, 1, 'one session, not two');
  assert.equal(listed[0].nodes, 3, 'and it is the newer one');
});

test('forgetting one leaves the others', async () => {
  const e = await built();
  const store = new sessions.LocalStore(fakeStorage());
  const a = sessions.fromEngine(e, view(), 'a');
  const b = sessions.fromEngine(e, view(), 'b');
  await store.save(a);
  await store.save(b);
  await store.remove(a.id);
  const left = await store.list();
  assert.deepEqual(left.map((r) => r.name), ['b']);
});

test('a browser that will not store says so rather than pretending', async () => {
  const e = await built();
  const store = new sessions.LocalStore({
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceededError'); },
    removeItem: () => {},
  });
  await assert.rejects(() => store.save(sessions.fromEngine(e, view(), 'x')), /storage is full/);
});

// ── the store on the box ────────────────────────────────────────────────────

test('a session saved on the box comes back the same', async (t) => {
  const e = await built();
  const store = new SessionStore(path.join(tmp(t), '.sessions'));
  const rec = sessions.fromEngine(e, view(), 'on the box');
  store.write(rec.id, rec);

  const listed = store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'on the box');
  assert.equal(listed[0].recipe, undefined);
  assert.deepEqual(store.read(rec.id).recipe, rec.recipe);
});

test('the directory is made on the first write, not at startup', (t) => {
  const root = path.join(tmp(t), '.sessions');
  const store = new SessionStore(root);
  assert.equal(fs.existsSync(root), false, 'nothing yet');
  assert.deepEqual(store.list(), [], 'and listing it is not an error');
  store.write('x-0001', { v: 1, name: 'x', at: 1, recipe: { nodes: [] } });
  assert.equal(fs.existsSync(root), true);
});

test('an id that is not an id never becomes a path', (t) => {
  const root = path.join(tmp(t), '.sessions');
  const store = new SessionStore(root);
  for (const bad of ['../escape', 'a/b', '..', 'UPPER', 'with space', '', '.hidden']) {
    assert.throws(() => store.write(bad, { v: 1, recipe: { nodes: [] } }), /not a session id/, bad);
    assert.throws(() => store._path(bad), /not a session id/);
  }
  // And nothing was created anywhere on the way to finding that out.
  assert.equal(fs.existsSync(root), false);
});

test('a file somebody edited by hand does not take the listing with it', (t) => {
  const root = path.join(tmp(t), '.sessions');
  const store = new SessionStore(root);
  store.write('good-0001', { v: 1, name: 'good', at: 2, recipe: { nodes: [] } });
  fs.writeFileSync(path.join(root, 'broken-0002.json'), '{ not json');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'hello');
  const listed = store.list();
  assert.deepEqual(listed.map((r) => r.name), ['good']);
});

test('something that is not a session is refused', (t) => {
  const store = new SessionStore(path.join(tmp(t), '.sessions'));
  for (const bad of [null, {}, { v: 2, recipe: { nodes: [] } }, { v: 1 }, { v: 1, recipe: {} }]) {
    assert.throws(() => store.write('x-0001', bad), /not a session/);
  }
});

test('a write goes through a rename and leaves no scratch behind', (t) => {
  // Through a temporary file and a rename: the failure otherwise is a full disk leaving
  // a truncated session where a good one was, still listed.
  const root = path.join(tmp(t), '.sessions');
  const store = new SessionStore(root);
  store.write('x-0001', { v: 1, name: 'x', at: 1, recipe: { nodes: [{ id: 'a', op: 'core.tuner' }] } });
  const before = fs.readFileSync(path.join(root, 'x-0001.json'), 'utf8');
  const big = { v: 1, name: 'x', at: 2, recipe: { nodes: [] }, blob: 'x'.repeat(10) };
  store.write('x-0001', big);
  assert.notEqual(fs.readFileSync(path.join(root, 'x-0001.json'), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.includes('tmp')), [], 'and no scratch left behind');
});

// ── over the wire ───────────────────────────────────────────────────────────

/** The real server, on a loopback port, so the routes are tested rather than described. */
async function serving(t) {
  const dir = tmp(t);
  // No `sessionDir`: the point is that a box with a capture directory keeps sessions
  // inside it without being told to, because that is the directory somebody mounted.
  const { server } = createServer({
    webDir: path.join(process.cwd(), 'web'), captureDir: dir, quiet: true,
    ringDir: dir, pluginDir: null,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  // `close` waits for every connection, and a websocket does not end by itself — so a
  // test that opens one would hang here rather than fail, which is the worst shape a
  // test failure has. Dropping them first is what makes the close finish.
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('the box serves what it keeps, and a tab reads it through the same store', async (t) => {
  const base = await serving(t);
  const e = await built();
  const store = new sessions.HttpStore(base);
  const rec = sessions.fromEngine(e, view(), 'over the wire');

  assert.deepEqual(await store.list(), [], 'nothing yet');
  await store.save(rec);
  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'over the wire');
  assert.deepEqual((await store.load(rec.id)).recipe, rec.recipe);

  await store.remove(rec.id);
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.load(rec.id), null, 'and asking for it again is not an error');
});

test('the config the server actually starts with keeps sessions', async (t) => {
  // This is the one that was wrong, and every other test here passed while it was. The
  // tests built their server by naming a few options; `start` hands over `CONFIG` whole,
  // and `CONFIG` carried an explicit `sessionDir: null` — which is a different thing from
  // leaving it out, and meant the shipped server quietly kept nothing. Curl found it.
  const dir = tmp(t);
  const { sessions: store } = createServer({ ...CONFIG, webDir: dir, captureDir: dir, quiet: true });
  assert.ok(store, 'a box with a capture directory keeps sessions');
  assert.equal(sessionDirFor(dir), path.join(dir, '.sessions'));
  assert.equal(sessionDirFor(null), null, 'and one with nowhere to put them keeps none');
});

test('the box says whether it keeps sessions, rather than being probed for it', async (t) => {
  // A probe would have to tell "no session directory" apart from "not a box at all", and
  // on a static host `GET /sessions` answers with a 404 *page*, which parses as neither.
  // So `hello` carries it, and the client picks its store from that.
  const base = await serving(t);
  const e = new RemoteEngine(`${base.replace('http://', 'ws://')}/ws`);
  const hello = await e.connect();
  assert.equal(hello.sessions, true);
  assert.equal(sessions.storeFor({ sessions: hello.sessions }).where, 'the box');
  assert.equal(sessions.storeFor({ sessions: false }).where, 'this browser');
  e._sock.close();
});

test('a body too large to be a session is refused unread', async (t) => {
  const base = await serving(t);
  const body = JSON.stringify({ v: 1, name: 'big', at: 1,
                                recipe: { nodes: [], pad: 'x'.repeat(2 << 20) } });
  const res = await fetch(`${base}/sessions/big-0001`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /too large/);
});

test('a path that is not a session id is refused by the server too', async (t) => {
  const base = await serving(t);
  const res = await fetch(`${base}/sessions/${encodeURIComponent('../escape')}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, recipe: { nodes: [] } }) });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not a session id/);
});

test('a box with no session directory says so rather than 404ing like a missing page', async (t) => {
  const dir = tmp(t);
  const { server } = createServer({ webDir: path.join(process.cwd(), 'web'), captureDir: dir,
                                    quiet: true, ringDir: dir, pluginDir: null, sessionDir: null });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/sessions`);
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /keeps no sessions/);
});

// ── and back onto a graph ───────────────────────────────────────────────────

test('a saved session rebuilds the graph it was saved from', async (t) => {
  const e = await built();
  const store = new SessionStore(path.join(tmp(t), '.sessions'));
  const rec = sessions.fromEngine(e, view(), 'round trip');
  store.write(rec.id, rec);

  // A fresh engine on the same capture, which is what opening one amounts to.
  const e2 = await built();
  for (const n of [...e2.nodes.values()]) if (n.id !== e2.root.id) await e2.removeNode(n.id);
  const done = await resume.replay(e2, store.read(rec.id).recipe);
  assert.equal(done.skipped.length, 0);
  assert.equal(done.made.length, 2);

  const ops = [...e2.nodes.values()].filter((n) => n.id !== e2.root.id).map((n) => n.op).sort();
  assert.deepEqual(ops, ['core.fm_discriminator', 'core.tuner']);
  // The parameter somebody turned came back; nothing derived was stored to come back.
  const fm = [...e2.nodes.values()].find((n) => n.op === 'core.fm_discriminator');
  assert.equal(fm.params.deviationHz.value, 7500);
  assert.equal(fm.params.deviationHz.mode, 'manual');
});
