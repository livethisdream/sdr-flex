// Decoders the operator added (ADR-0026).
//
// The design was written down long ago and deliberately deferred until enough real
// adapters existed to generalize from — the point being that a pack format invented
// before the fact is invented from imagination. Six adapters later, every mechanism this
// needs was forced by one of them: a program under several names, a module inside an
// interpreter, a container in front of the samples, a config file written per run, a
// sample rate that follows a parameter, and four ways of reading a program's output.
//
// What is actually being protected here is twofold. A manifest that is wrong should fail
// loudly at startup with the reason, because the alternative is a decoder that silently
// is not there. And a local adapter must never shadow one that ships with the tool.
//
//   node --test web/test/adapterdir.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AdapterDir, compile, compileArgs } from '../../server/adapterdir.js';
import * as adapters from '../../server/adapters.js';
import * as mod from './support/modulate.mjs';

/** A manifest with everything required and nothing more. */
const MINIMAL = {
  id: 'ext.mine', name: 'Mine', in: 'real', out: 'events',
  command: ['true'], wants: { format: 's16', rate: 48_000 }, args: [],
};

const pack = (manifest, extra = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdrflex-pack-'));
  fs.mkdirSync(path.join(dir, 'one'));
  fs.writeFileSync(path.join(dir, 'one', 'adapter.json'), JSON.stringify(manifest, null, 2));
  for (const [name, body] of Object.entries(extra)) fs.writeFileSync(path.join(dir, 'one', name), body);
  return dir;
};

// ── the manifest, checked without touching the disk ─────────────────────────

test('a manifest compiles to the shape the table runs', () => {
  const { id, spec } = compile(MINIMAL, '/nowhere', 'one');
  assert.equal(id, 'ext.mine');
  assert.equal(spec.name, 'Mine');
  assert.equal(spec.group, 'Decode', 'a group it did not give');
  assert.deepEqual(spec.command, ['true']);
  assert.equal(typeof spec.args, 'function');
  assert.equal(spec.local.pack, 'one', 'and it remembers it is yours');
});

test('a manifest missing something required says which', () => {
  for (const key of ['name', 'in', 'out', 'command']) {
    const bad = { ...MINIMAL };
    delete bad[key];
    assert.throws(() => compile(bad, '/nowhere', 'one'), new RegExp(`no "${key}"`),
                  `dropping ${key} should be refused by name`);
  }
});

test('a manifest naming a stream type that does not exist is refused', () => {
  assert.throws(() => compile({ ...MINIMAL, in: 'video' }, '/nowhere', 'one'), /"in" is video/);
  assert.throws(() => compile({ ...MINIMAL, out: 'pictures' }, '/nowhere', 'one'), /"out" is pictures/);
  assert.throws(() => compile({ ...MINIMAL, wants: { format: 'cs4', rate: 1 } }, '/nowhere', 'one'),
                /wants\.format is cs4/);
  assert.throws(() => compile({ ...MINIMAL, parse: 'yaml' }, '/nowhere', 'one'), /"parse" is yaml/);
});

test('an id has to be in the external namespace', () => {
  assert.throws(() => compile({ ...MINIMAL, id: 'core.mine' }, '/nowhere', 'one'), /starts with "ext\."/);
  // and one that gives no id at all is named after its directory
  const { id } = compile({ ...MINIMAL, id: undefined }, '/nowhere', 'my-decoder');
  assert.equal(id, 'ext.my-decoder');
});

test('a flowgraph has to actually be in the pack', () => {
  const dir = pack({ ...MINIMAL, flowgraph: 'missing.py' });
  assert.throws(() => compile({ ...MINIMAL, flowgraph: 'missing.py' }, path.join(dir, 'one'), 'one'),
                /flowgraph missing\.py is not in the pack/);
  fs.writeFileSync(path.join(dir, 'one', 'here.py'), '# hi\n');
  const { spec } = compile({ ...MINIMAL, flowgraph: 'here.py' }, path.join(dir, 'one'), 'one');
  assert.equal(spec.flowgraphPath, path.join(dir, 'one', 'here.py'),
               'and it is absolute, because a pack lives wherever you put it');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── the command line ────────────────────────────────────────────────────────

test('args substitute the things the engine knows', () => {
  const build = compileArgs(['-s', '{rate}', '-f', '{centerHz}', '-c', '{dir}/x.conf', '{param:mode}'], 'ext.x');
  assert.deepEqual(build({ rate: 250_000.4, centerHz: 433_920_000, dir: '/tmp/a', params: { mode: 'fast' } }),
                   ['-s', '250000', '-f', '433920000', '-c', '/tmp/a/x.conf', 'fast']);
});

test('a flag whose value is empty is left out entirely, with its flag', () => {
  // "restrict to one protocol" and "restrict to no protocol" are different command
  // lines, and `-R ''` is neither of them.
  const build = compileArgs(['-r', 'cu8:-', { if: 'protocol', then: ['-R', '{param:protocol}'] }], 'ext.x');
  assert.deepEqual(build({ rate: 1, params: { protocol: '' } }), ['-r', 'cu8:-']);
  assert.deepEqual(build({ rate: 1, params: { protocol: '40' } }), ['-r', 'cu8:-', '-R', '40']);
  assert.deepEqual(build({ rate: 1, params: {} }), ['-r', 'cu8:-'], 'and a parameter that is not there at all');
});

test('an args entry that is neither a string nor a condition is refused', () => {
  assert.throws(() => compileArgs([42], 'ext.x'), /neither a string nor an "if"/);
  assert.throws(() => compileArgs('--all-of-it', 'ext.x'), /"args" is not a list/);
});

// ── what it wants on stdin ──────────────────────────────────────────────────

test('a rate that follows a parameter can be said without writing a function', () => {
  const { spec } = compile({ ...MINIMAL,
    params: [{ id: 'bw', default: '125000' }],
    wants: { format: 'cf32', ratePerParam: { param: 'bw', times: 2, default: 125_000 } },
  }, '/nowhere', 'one');
  assert.equal(adapters.wants(spec, { bw: '125000' }).rate, 250_000);
  assert.equal(adapters.wants(spec, { bw: '250000' }).rate, 500_000);
  assert.equal(adapters.wants(spec, {}).rate, 250_000, 'and it falls back');
});

test('the container travels with the format', () => {
  // minimodem reads through libsndfile and will not take headerless samples on a pipe.
  // A manifest that could name the format but not the wrapper could describe minimodem
  // and not drive it — which is exactly what happened the first time this was written.
  const { spec } = compile({ ...MINIMAL, wants: { format: 's16', rate: 48_000, container: 'wav' } },
                           '/nowhere', 'one');
  assert.equal(adapters.wants(spec, {}).container, 'wav');
});

// ── the directory ───────────────────────────────────────────────────────────

test('a pack with no manifest in it is reported, not skipped in silence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdrflex-pack-'));
  fs.mkdirSync(path.join(dir, 'empty'));
  const { adapters: found, problems } = await new AdapterDir(dir).load();
  assert.equal(found.length, 0);
  assert.match(problems[0].why, /no adapter\.json or adapter\.mjs/);
  assert.equal(problems[0].pack, 'empty');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('one bad pack does not take the good ones with it', async () => {
  const dir = pack(MINIMAL);
  fs.mkdirSync(path.join(dir, 'broken'));
  fs.writeFileSync(path.join(dir, 'broken', 'adapter.json'), '{ not json');
  const { adapters: found, problems } = await new AdapterDir(dir).load();
  assert.equal(found.length, 1, 'the good one still loads');
  assert.equal(problems.length, 1);
  assert.equal(problems[0].pack, 'broken');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a world-writable directory is refused, because an adapter is a command line', async () => {
  const dir = pack(MINIMAL);
  fs.chmodSync(dir, 0o777);
  const { adapters: found, problems } = await new AdapterDir(dir).load();
  assert.equal(found.length, 0, 'nothing loads');
  assert.match(problems[0].why, /world-writable/);
  assert.match(problems[0].why, /chmod o-w/, 'and it says what to do about it');
  fs.chmodSync(dir, 0o755);
  assert.equal((await new AdapterDir(dir).load()).adapters.length, 1, 'and then it does');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a manifest may be a module, when it needs to compute', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdrflex-pack-'));
  fs.mkdirSync(path.join(dir, 'computed'));
  fs.writeFileSync(path.join(dir, 'computed', 'adapter.mjs'), `
    export default {
      id: 'ext.computed', name: 'Computed', in: 'real', out: 'events',
      command: ['true'], wants: { format: 's16', rate: 8000 },
      args: ({ params }) => Object.keys(params).flatMap((k) => ['-x', k]),
      parse: (stdout) => stdout.split('!').filter(Boolean).map((t) => ({ text: t })),
    };
  `);
  const { adapters: found, problems } = await new AdapterDir(dir).load();
  assert.deepEqual(problems, []);
  const { spec } = found[0];
  assert.deepEqual(spec.args({ rate: 1, params: { a: 1, b: 2 } }), ['-x', 'a', '-x', 'b']);
  assert.deepEqual(spec.parse('one!two!'), [{ text: 'one' }, { text: 'two' }]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── and into the table ──────────────────────────────────────────────────────

test('a local adapter cannot shadow one that ships with the tool', () => {
  assert.throws(() => adapters.register('ext.rtl433', compile(MINIMAL, '/nowhere', 'one').spec),
                /already a decoder that ships with the tool/);
});

test('a registered adapter is in the table, and says it is yours', (t) => {
  const { id, spec } = compile(MINIMAL, '/nowhere', 'one');
  adapters.register(id, spec);
  t.after(() => adapters.forget(id));
  const row = adapters.list().find((r) => r.id === id);
  assert.ok(row, 'it is in the list');
  assert.equal(row.local, 'one', 'marked with the pack it came from');
  assert.ok(adapters.list().find((r) => r.id === 'ext.rtl433') && !adapters.list().find((r) => r.id === 'ext.rtl433').local,
            'and a shipped one is not marked');
  assert.equal(adapters.spec(id).name, 'Mine');
});

test('a local adapter decodes, end to end', async (t) => {
  if (!adapters.available('ext.minimodem')) { t.diagnostic('skipped: minimodem is not installed'); return; }
  // The pack an operator would actually write: minimodem pinned to Baudot RTTY, with the
  // tone pair as a knob and the flags left out when it is empty.
  const dir = pack({
    id: 'ext.rtty', name: 'RTTY 45.45', in: 'real', out: 'events',
    command: ['minimodem'],
    wants: { format: 's16', rate: 48_000, container: 'wav' },
    params: [{ id: 'mark', default: '' }, { id: 'space', default: '' }],
    args: ['--rx', '-f', '-',
           { if: 'mark', then: ['-M', '{param:mark}'] },
           { if: 'space', then: ['-S', '{param:space}'] },
           'rtty'],
    parse: 'lines', title: ['text'],
  });
  const { adapters: found, problems } = await new AdapterDir(dir).load();
  assert.deepEqual(problems, []);
  adapters.register(found[0].id, found[0].spec);
  t.after(() => { adapters.forget(found[0].id); fs.rmSync(dir, { recursive: true, force: true }); });

  const out = await adapters.run('ext.rtty', {
    data: mod.baudot('HELLO', { rate: 48_000 }), kind: 'real', sampleRate: 48_000,
    params: { mark: '2125', space: '2295' }, timeoutMs: 30_000,
  });
  assert.equal(out.error, undefined, out.error);
  assert.match(out.records.map((r) => r.text).join(''), /HELLO/);
  assert.match(out.note, /WAV wrapper/, 'and the container the manifest asked for was applied');
});
