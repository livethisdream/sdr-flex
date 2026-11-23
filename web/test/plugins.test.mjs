// The decoders that come from a file, and the two places they were invisible.
//
//   node --test web/test/plugins.test.mjs
//
// `bbc.js` has shipped in `web/plugins/` since the plugin framework landed. A box scans
// that directory and hands the files to every tab. A static host cannot scan anything,
// so the hosted copy of the tool served the file to anyone who asked for it by name and
// never asked — and then `Identify`, which only ever planned adapters, would not have
// run it even if it had been loaded. Both are fixed here; these are the tests for them.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as plugins from '../src/plugins.js';
import { plan, runPlugins, MIN_DECODE_CHARS } from '../src/identify.js';
import * as bbc from '../plugins/bbc.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, '..', 'plugins');

/** Serve `web/plugins` off the disk, which is what a static host does. */
const siteFetch = (over = {}) => async (url) => {
  if (url in over) return over[url];
  const name = url.replace(/^plugins\//, '');
  const full = path.join(DIR, name);
  if (!fs.existsSync(full)) return { ok: false, status: 404 };
  const text = fs.readFileSync(full, 'utf8');
  return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
};

// ── the manifest ────────────────────────────────────────────────────────────

test('the manifest names every decoder in the directory, and nothing else', () => {
  // The drift this guards is silent in the worst way: a decoder added to the directory
  // works on a box, because the box scans, and is simply absent from the hosted copy.
  // Nothing fails, nothing is logged, and it is the same shape as the bug that made
  // `Identify` look removed.
  const onDisk = fs.readdirSync(DIR).filter((n) => /\.js$/i.test(n)).sort();
  const named = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8')).plugins;
  assert.deepEqual([...named].sort(), onDisk,
    'web/plugins/index.json and the files beside it disagree');
});

// ── loading them without a box ──────────────────────────────────────────────

test('a static host serves the decoders it ships, and they load', async () => {
  const got = await plugins.loadSite('plugins', siteFetch());
  assert.deepEqual(got.failed, []);
  assert.ok(got.loaded.length >= 2);
  assert.equal(plugins.get('ext.bbc').in, 'bytes');
  assert.equal(plugins.get('ext.dtmf').in, 'real', 'and not all of them read bytes');
});

test('loading twice does not load twice', async () => {
  const again = await plugins.loadSite('plugins', siteFetch());
  assert.deepEqual(again.loaded, [], 'already here');
  assert.deepEqual(again.failed, []);
});

test('no manifest is not an error — it is what a box looks like', async () => {
  const got = await plugins.loadSite('plugins', async () => ({ ok: false, status: 404 }));
  assert.deepEqual(got, { loaded: [], failed: [] });
  const threw = await plugins.loadSite('plugins', async () => { throw new Error('offline'); });
  assert.deepEqual(threw, { loaded: [], failed: [] });
});

test('a manifest naming something that is not a plugin filename is refused', async () => {
  const manifest = { ok: true, status: 200,
    json: async () => ({ plugins: ['../../etc/passwd', 'sub/dir.js', 'notjs.txt', 12] }) };
  const got = await plugins.loadSite('plugins', siteFetch({ 'plugins/index.json': manifest }));
  assert.equal(got.loaded.length, 0);
  assert.equal(got.failed.length, 4);
  for (const f of got.failed) assert.match(f.error, /not a plugin filename/);
});

test('a manifest naming a file that is not there loses one decoder, not the rest', async () => {
  const manifest = { ok: true, status: 200,
    json: async () => ({ plugins: ['gone.js', 'bbc.js'] }) };
  const got = await plugins.loadSite('plugins', siteFetch({ 'plugins/index.json': manifest }));
  assert.deepEqual(got.failed.map((f) => f.filename), ['gone.js']);
  assert.match(got.failed[0].error, /404/);
});

// ── what a manifest may declare ─────────────────────────────────────────────

const src = (m, body = 'export function decode(){ return []; }') =>
  `export const manifest = ${JSON.stringify(m)};\n${body}`;

test('a plugin may read samples or bytes', async () => {
  for (const kind of ['iq', 'real', 'bytes', '*']) {
    const p = await plugins.loadSource(
      src({ id: `t.in${kind === '*' ? 'any' : kind}`, name: kind, in: kind, out: 'events' }));
    assert.equal(p.in, kind);
  }
});

test('a manifest that declares a stream out is refused, with the reason', async () => {
  // Not caution. A plugin returns records; a node whose `out` is a stream is read
  // through `readSpan`, on demand and cached, and nothing routes a read through a JS
  // function. Such a node would build, appear in the menu, and produce nothing — which
  // is the exact failure this whole change is fixing, one level up.
  for (const out of ['real', 'iq', 'bytes', 'grid']) {
    await assert.rejects(
      () => plugins.loadSource(src({ id: 't.out', name: 'x', in: 'real', out })),
      /a plugin returns records/, out);
  }
});

test('a manifest that declares an input nobody can feed is refused', async () => {
  for (const kind of ['bits', 'symbols', 'audio', 'nonsense']) {
    await assert.rejects(
      () => plugins.loadSource(src({ id: 't.badin', name: 'x', in: kind, out: 'events' })),
      /a plugin reads one of/, kind);
  }
});

test('the decoders that ship satisfy their own contract', async () => {
  // They are loaded by the same validator, so this would be caught anyway — but a
  // shipped file failing its own rules is worth one line that names it.
  await plugins.loadSite('plugins', siteFetch());
  for (const id of ['ext.bbc', 'ext.dtmf']) {
    const p = plugins.get(id);
    assert.ok(p, id);
    assert.ok(plugins.PLUGIN_IN.includes(p.in), `${id} reads ${p.in}`);
    assert.ok(plugins.PLUGIN_OUT.includes(p.out), `${id} produces ${p.out}`);
  }
});

// ── and into Identify ───────────────────────────────────────────────────────

const stub = (id, kind) => ({ id, name: id, in: kind, out: 'events', params: [] });

/** What `Graph.pluginFeed` hands back for a byte stream. */
const bytesFeed = (n) => ({ data: new Uint8Array(n), info: { kind: 'bytes', count: n } });

test('a plugin is planned for the kind it takes', () => {
  const p = plan([], { kind: 'bytes', sampleRate: 48_000, plugins: [stub('ext.a', 'bytes')] });
  assert.deepEqual(p.tried.map((c) => c.id), ['ext.a']);
  assert.equal(p.tried[0].plugin, true, 'marked, because the tab runs it and the engine does not');
  assert.deepEqual(p.skipped, []);
});

test('a plugin that takes something else is skipped with a reason, not dropped', () => {
  // ADR-0031: "nothing decoded this" and "nothing that could decode this was tried" are
  // different answers, and a list cannot tell them apart on its own.
  const p = plan([], { kind: 'iq', sampleRate: 2_400_000, plugins: [stub('ext.a', 'bytes')] });
  assert.deepEqual(p.tried, []);
  assert.equal(p.skipped.length, 1);
  assert.match(p.skipped[0].why, /takes bytes, and this is iq/);
});

test('a plugin taking anything is planned for everything', () => {
  for (const kind of ['iq', 'real', 'bytes']) {
    const p = plan([], { kind, sampleRate: 48_000, plugins: [stub('ext.any', '*')] });
    assert.equal(p.tried.length, 1, kind);
  }
});

test('plugins and adapters land in one plan, told apart by who can run them', () => {
  const adapter = { id: 'ext.minimodem', name: 'minimodem', in: 'real', available: true,
                    command: 'minimodem', wants: { rate: 48_000 }, params: [] };
  const p = plan([adapter], { kind: 'real', sampleRate: 48_000,
                              plugins: [stub('ext.any', '*')] });
  assert.deepEqual(p.tried.filter((c) => c.plugin).map((c) => c.id), ['ext.any']);
  assert.deepEqual(p.tried.filter((c) => !c.plugin).map((c) => c.id), ['ext.minimodem']);
});

// ── running them ────────────────────────────────────────────────────────────

test('a plugin row looks like an adapter row, because they are sorted against each other', () => {
  const run = () => ({ records: [{ text: 'HELLO' }, { text: 'THERE' }], ms: 4 });
  const rows = runPlugins([{ id: 'ext.a', name: 'A', params: { x: 1 } }], bytesFeed(4), run);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.records, 2);
  assert.deepEqual(r.sample, ['HELLO', 'THERE']);
  assert.equal(r.thin, false);
  assert.equal(r.suspect, false);
  assert.equal(r.plugin, true);
  assert.deepEqual(r.params, { x: 1 });
});

test('the thin and suspect rules are the engine’s, not a second copy of them', () => {
  const thin = runPlugins([{ id: 'a', name: 'A' }], bytesFeed(1),
    () => ({ records: [{ text: 'E' }] }))[0];
  assert.equal(thin.thin, true, `under ${MIN_DECODE_CHARS} characters is not a decode`);
  const suspect = runPlugins([{ id: 'a', name: 'A' }], bytesFeed(1),
    () => ({ records: [{ text: 'LONG ENOUGH', suspect: true }] }))[0];
  assert.equal(suspect.suspect, true);
  assert.equal(suspect.thin, false);
});

test('a decoder that throws is a row with an error, not a lost report', () => {
  const rows = runPlugins([{ id: 'a', name: 'A' }], bytesFeed(1),
    () => ({ records: [], error: 'A: bad length' }));
  assert.equal(rows[0].records, 0);
  assert.match(rows[0].error, /bad length/);
});

test('results arrive one at a time, the way the panel fills in', () => {
  const seen = [];
  runPlugins([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], bytesFeed(1),
    () => ({ records: [] }), (r) => seen.push(r.id));
  assert.deepEqual(seen, ['a', 'b']);
});

// ── the whole way, with the decoder that actually ships ─────────────────────

test('the shipped decoder is planned and read off a byte stream, with no box anywhere', async () => {
  // This is the hosted case end to end: the client loads its own decoder off the site,
  // plans it against a bytes node, and runs it in the tab. Nothing here is a process.
  await plugins.loadSite('plugins', siteFetch());
  const P = { msgBytes: 16, codBytes: 8192, checkBits: 32 };
  const message = 'SDR FLEX  v1    ';
  const codeword = bbc.encode(Uint8Array.from([...message].map((c) => c.charCodeAt(0))), P);

  const p = plan([], { kind: 'bytes', sampleRate: 0, plugins: plugins.loaded() });
  const mine = p.tried.filter((c) => c.plugin && c.id === 'ext.bbc');
  assert.equal(mine.length, 1, 'the shipped decoder is in the plan');

  // Its planned settings are the manifest's defaults, which are not this fixture's, so
  // the row is run the way the panel would run it after the settings are the ones that
  // answered — here, given directly.
  const rows = runPlugins([{ ...mine[0], params: P }],
                          { data: codeword, info: { kind: 'bytes', count: codeword.length } },
                          plugins.run);
  assert.equal(rows[0].error, undefined);
  assert.deepEqual(rows[0].sample, [message]);
  assert.equal(rows[0].thin, false);
});

// ── your own folder, beside the shipped one ─────────────────────────────────

test('a box reads the shipped folder and then yours, and marks yours', async () => {
  const os = await import('node:os');
  const { PluginDir } = await import('../../server/plugindir.js');
  const { pluginRoots } = await import('../../server/main.js');
  const mine = fs.mkdtempSync(path.join(os.tmpdir(), 'sdrflex-mine-'));
  fs.writeFileSync(path.join(mine, 'pulses.js'), src({ id: 't.mine', name: 'mine', in: 'real', out: 'events' }));
  const roots = pluginRoots(DIR, [mine, path.join(mine, 'not-there')]);
  assert.deepEqual(roots.map((r) => !!r.local), [false, true], 'a folder that is not there is skipped');
  const list = new PluginDir(roots).list();
  const shipped = list.filter((f) => !f.local).map((f) => f.filename);
  assert.ok(shipped.includes('dtmf.js'), 'adding yours does not cost the shipped ones');
  const last = list[list.length - 1];
  assert.equal(last.filename, 'pulses.js', 'yours come last, so on a shared id yours wins');
  const got = await plugins.loadAll([last]);
  assert.match(got.loaded[0].local, /plugin folder/);
});

// ── "slice as" a plugin, handed the grid ────────────────────────────────────

/** A made-up pulse-width decoder: it knows nothing of the burst but what the grid says. */
const PULSES = src({ id: 't.pulses', name: 'pulse widths', in: 'real', out: 'events' }, `
export function decode(x, params, info) {
  const g = info.grid; if (!g) return [{ text: 'no grid' }];
  const P = g.period * info.sampleRate;
  let lo = Infinity, hi = -Infinity;
  for (const v of x) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const thr = (lo + hi) / 2, out = [];
  let bits = [], run = 0, high = false;
  const end = () => { if (bits.length >= 16) out.push(bits); bits = []; };
  for (let i = 0; i <= x.length; i++) {
    const h = i < x.length && x[i] > thr;
    if (h === high) { run++; continue; }
    const n = run / P;
    if (high) bits.push(n > 1.5 ? 1 : 0); else if (n > 4.5) end();
    high = h; run = 1;
  }
  end();
  return out.map((b) => {
    const bytes = [];
    for (let i = 0; i + 8 <= b.length; i += 8) bytes.push(parseInt(b.slice(i, i + 8).join(''), 2));
    return { text: String.fromCharCode(...bytes.slice(2)), bits: b.length };
  });
}`);

test('slice as a plugin: it is handed the grid, and reads the burst with it', async () => {
  const { MockEngine } = await import('../src/engine.js');
  const G = await import('../src/symgrid.js');
  const { MESSAGE } = await import('../src/scene.js');
  await plugins.loadSource(PULSES, 'pulses.js', 'from your plugin folder');
  const e = new MockEngine({ latency: false });
  await e.createSession();
  const c = e.root.out.centerHz;
  e.t = 1.0;
  const tu = await e.addNode({ parent: e.root.id, op: 'core.tuner', at: 1.0, selection: { f0: c - 50_000, f1: c } });
  const f = e.frame(tu.id, { spanS: 0.05, trigger: 'auto', quantity: 'amplitude' });
  const g = G.fitGrid(f.data, f.sampleRate, f.t0, 0, f.data.length);
  const am = await e.addNode({ parent: tu.id, op: 'core.am_envelope' });
  const pl = await e.addNode({ parent: am.id, op: 't.pulses' });
  assert.equal(pl.plugin, 't.pulses');
  assert.equal((await e.runPlugin(pl.id)).records[0].text, 'no grid', 'nothing is handed over unasked');
  e.setGrid(pl.id, g);
  assert.ok(Math.abs(e.gridFor(pl.id).period - g.period) < 1e-12);
  e.t = 2.0;
  const out = await e.runPlugin(pl.id);
  assert.ok(!out.error, out.error);
  assert.ok(out.records.some((r) => r.text === MESSAGE), `read ${JSON.stringify(out.records.map((r) => r.text))}`);
});

test('a plugin node on a box survives the next snapshot, while what it reads does', async () => {
  // It lives only in the tab, so no snapshot carries it; adopting one used to drop it.
  const { Graph } = await import('../src/graph.js');
  const g = new Graph();
  const root = { id: 'n1', parent: null, op: 'core.source', out: { kind: 'iq' } };
  const am = { id: 'n2', parent: 'n1', op: 'core.am_envelope', out: { kind: 'real' } };
  g._adopt({ root: 'n1', nodes: [root, am] });
  g.nodes.set('p1', { id: 'p1', parent: 'n2', plugin: 't.pulses', local: true, out: { kind: 'events' } });
  g.nodes.set('p2', { id: 'p2', parent: 'p1', plugin: 't.pulses', local: true, out: { kind: 'events' } });
  g._adopt({ root: 'n1', nodes: [{ ...root }, { ...am }] });
  assert.ok(g.node('p1') && g.node('p2'), 'kept, and so is one built on it');
  g._adopt({ root: 'n1', nodes: [{ ...root }] });
  assert.equal(g.node('p1'), undefined, 'gone with its parent');
});
