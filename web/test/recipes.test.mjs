// Recipes read from their .grc files, and the chain a chain recipe becomes (ADR-0043).
//
//   node --test web/test/recipes.test.mjs
//
// Reading a recipe needs GNU Radio's Python (for its YAML); skipped where it is not installed.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chainOf, settingsFor, STEPS } from '../src/recipes.js';
import { MockEngine } from '../src/engine.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', '..', 'server', 'gr', 'recipes.py');
const python = process.env.SDRFLEX_GR_PYTHON || 'python3';
const hasYaml = spawnSync(python, ['-c', 'import yaml'], { stdio: 'ignore' }).status === 0;
const skip = !hasYaml && 'no Python with YAML here';

const read = (dir) => JSON.parse(spawnSync(python, [SCRIPT, ...(dir ? [dir] : [])], { encoding: 'utf8' }).stdout);

test('the shipped recipes load, each from its own .grc and nothing else', { skip }, () => {
  const { recipes, errors } = read();
  assert.deepEqual(errors, []);
  const cw = recipes.find((r) => r.name === 'cw'), wbfm = recipes.find((r) => r.name === 'wbfm');
  assert.equal(cw.kind, 'node');
  assert.equal(cw.node, 'core.cw');
  assert.deepEqual(cw.derived, { offsetHz: 'strongest-carrier' });
  assert.equal(cw.history, 'history');
  assert.ok(cw.params.samp_rate.fromStream && cw.params.start_index.fromStream);
  assert.equal(wbfm.kind, 'chain');
  assert.equal(wbfm.title, 'WBFM broadcast');
  assert.equal(wbfm.output, 'stereo');
  assert.equal(wbfm.listen, true);
  assert.deepEqual(fs.readdirSync(path.join(here, '..', '..', 'recipes')).filter((f) => !f.endsWith('.grc')), [],
                   'no file beside a recipe');
});

test("WBFM becomes an FM demod and a stereo decode, given the recipe's settings by name", { skip }, async () => {
  const wbfm = read().recipes.find((r) => r.name === 'wbfm');
  assert.deepEqual(chainOf(wbfm), ['core.fm_discriminator', 'core.stereo']);
  // Against real nodes, so a renamed setting on either side shows up here.
  const e = new MockEngine({ latency: false });
  await e.createSession();
  const c = e.root.out.centerHz;
  const t = await e.addNode({ parent: e.root.id, op: 'core.tuner', selection: { f0: c - 40e3, f1: c + 40e3 } });
  const fm = e.node((await e.addNode({ parent: t.id, op: 'core.fm_discriminator' })).id);
  const st = e.node((await e.addNode({ parent: fm.id, op: 'core.stereo' })).id);
  assert.deepEqual(settingsFor(wbfm, fm), { deviationHz: 75000 });
  assert.deepEqual(settingsFor(wbfm, st), { deemphasisUs: 75 });
  assert.deepEqual(settingsFor(wbfm, e.node(t.id)), { widthHz: 240000 });
});

test('a recipe that is broken says what is wrong, and the others still load', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recipes-'));
  try {
    fs.copyFileSync(path.join(here, '..', '..', 'recipes', 'wbfm.grc'), path.join(dir, 'wbfm.grc'));
    const cw = fs.readFileSync(path.join(here, '..', '..', 'recipes', 'cw.grc'), 'utf8');
    fs.writeFileSync(path.join(dir, 'broken.grc'), cw.replace('derived: offsetHz=strongest-carrier', 'derived: nope=strongest-carrier'));
    const { recipes, errors } = read(dir);
    assert.deepEqual(recipes.map((r) => r.name), ['wbfm']);
    assert.match(errors[0], /broken: derives 'nope', which is not one of its parameters/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a chain with a block SDR Flex has no step for is refused, naming the block', () => {
  const r = { title: 'Odd', blocks: [{ id: 'blocks_vector_sink_f', name: 'b0', params: {} }],
              connections: [['pad_source_0', '0', 'b0', '0'], ['b0', '0', 'pad_sink_0', '0']], params: {} };
  assert.throws(() => chainOf(r), /no step for the GNU Radio block blocks_vector_sink_f/);
  assert.ok(STEPS.analog_wfm_rcv_pll);
});
