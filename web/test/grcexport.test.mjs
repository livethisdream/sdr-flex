// A chain written as GNU Radio Companion (server/grc.js), read back, and compiled by GRC.
//
//   node --test web/test/grcexport.test.mjs
//
// Needs GNU Radio and its grcc, which the image `Dockerfile.full` builds has; skipped elsewhere.
// GRC is the judge of whether a file is valid: each one written here is compiled by grcc.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MockEngine } from '../src/engine.js';
import { FileCapture } from '../../server/filecapture.js';
import { recipeGrc, programGrc } from '../../server/grc.js';
import { chainOf, settingsFor } from '../src/recipes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..', '..');
const python = process.env.SDRFLEX_GR_PYTHON || 'python3';
const hasGrcc = spawnSync('sh', ['-c', 'command -v grcc'], { encoding: 'utf8' }).stdout.trim() !== '';
const skip = !hasGrcc && 'grcc is not installed';

function work(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grcexport-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** grcc on a file, with SDR Flex's recipe block and any hier blocks in `extra` on its path. */
function compile(file, out, extra = []) {
  const r = spawnSync('grcc', ['-o', out, file], {
    encoding: 'utf8',
    env: { ...process.env, HOME: out, GRC_BLOCKS_PATH: [path.join(REPO, 'grc'), ...extra].join(path.delimiter) },
  });
  return { ok: r.status === 0, log: `${r.stdout}\n${r.stderr}` };
}

const describe = (dir) => JSON.parse(spawnSync(python, [path.join(REPO, 'server', 'gr', 'recipes.py'), dir], { encoding: 'utf8' }).stdout);

async function station(t, dir) {
  // A short cf32 capture; what is in it does not matter to the export.
  const file = path.join(dir, 'station.cf32');
  fs.writeFileSync(file, Buffer.alloc(500_000 * 8 / 10));
  const e = new MockEngine({ latency: false });
  await e.createSession();
  await e.openCapture(new FileCapture({ path: file, format: 'cf32', sampleRate: 500_000, centerHz: 100e6, label: 'station' }));
  return e;
}

test('a WBFM chain saved as a recipe opens in GRC and comes back as the same chain', { skip }, async (t) => {
  const dir = work(t);
  const e = await station(t, dir);
  const tu = await e.addNode({ parent: e.root.id, op: 'core.tuner', selection: { f0: 100e6 - 120e3, f1: 100e6 + 120e3 }, at: 0.05 });
  const fm = await e.addNode({ parent: tu.id, op: 'core.fm_discriminator', at: 0.05 });
  await e.setParam(fm.id, 'deviationHz', 75_000, 'manual');
  const st = await e.addNode({ parent: fm.id, op: 'core.stereo', at: 0.05 });
  await e.setParam(st.id, 'deemphasisUs', 50, 'manual');
  const ls = await e.addNode({ parent: st.id, op: 'core.audio', at: 0.05 });

  const r = recipeGrc(e, ls.id, 'My station');
  assert.deepEqual(r.notes, []);
  const recipes = path.join(dir, 'recipes');
  fs.mkdirSync(recipes);
  fs.writeFileSync(path.join(recipes, `${r.name}.grc`), r.text);
  const c = compile(path.join(recipes, `${r.name}.grc`), dir);
  assert.ok(c.ok, c.log);

  const { recipes: [back], errors } = describe(recipes);
  assert.deepEqual(errors, []);
  assert.equal(back.title, 'My station');
  assert.equal(back.kind, 'chain');
  assert.equal(back.output, 'stereo');
  assert.equal(back.listen, true);
  assert.deepEqual(chainOf(back), ['core.fm_discriminator', 'core.stereo']);
  // The settings as they were set, by name, on the nodes they belong to.
  const st2 = e.node(st.id);
  assert.deepEqual(settingsFor(back, e.node(fm.id)), { deviationHz: 75000 });
  assert.deepEqual(settingsFor(back, st2), { deemphasisUs: 50 });
  assert.equal(Number(back.params.widthHz.value), 240_000);
});

test('a setting SDR Flex derived is saved as derived, and measured again where it is used', { skip }, async (t) => {
  const dir = work(t);
  const e = await station(t, dir);
  const tu = await e.addNode({ parent: e.root.id, op: 'core.tuner', selection: { f0: 100e6 - 10e3, f1: 100e6 + 10e3 }, at: 0.05 });
  const fm = await e.addNode({ parent: tu.id, op: 'core.fm_discriminator', at: 0.05 });   // deviation left auto
  const r = recipeGrc(e, fm.id, 'narrow fm');
  const recipes = path.join(dir, 'recipes');
  fs.mkdirSync(recipes);
  fs.writeFileSync(path.join(recipes, `${r.name}.grc`), r.text);
  const { recipes: [back] } = describe(recipes);
  assert.deepEqual(back.derived, { deviationHz: 'auto' });
  assert.deepEqual(settingsFor(back, e.node(fm.id)), { gain: 1 }, 'the derived deviation is left to the node');
  assert.ok(compile(path.join(recipes, `${r.name}.grc`), dir).ok);
});

test('a CW chain uses the CW recipe as its block, and a decoder after it ends the chain with a note', { skip }, async (t) => {
  const dir = work(t);
  const e = await station(t, dir);
  e.adapters = [{ id: 'ext.multimon' }];
  const tu = await e.addNode({ parent: e.root.id, op: 'core.tuner', selection: { f0: 100e6 - 1e3, f1: 100e6 + 1e3 }, at: 0.05 });
  const cw = await e.addNode({ parent: tu.id, op: 'core.cw', at: 0.05 });
  const r = recipeGrc(e, cw.id, 'my cw');
  assert.deepEqual(r.needs, ['sdrflex_cw']);
  const recipes = path.join(dir, 'recipes');
  fs.mkdirSync(recipes);
  fs.writeFileSync(path.join(recipes, `${r.name}.grc`), r.text);
  // GRC knows the CW block once the CW recipe has been compiled, as it would on a desktop.
  const cwOut = path.join(dir, 'cw');
  fs.mkdirSync(cwOut);
  assert.ok(compile(path.join(REPO, 'recipes', 'cw.grc'), cwOut).ok);
  const c = compile(path.join(recipes, `${r.name}.grc`), dir, [cwOut]);
  assert.ok(c.ok, c.log);
  const { recipes: [back] } = describe(recipes);
  assert.deepEqual(chainOf(back), ['core.cw']);
  assert.deepEqual(back.derived, { offsetHz: 'auto' });
});

test('a step with no GNU Radio block ends the chain there, and the file says so', { skip }, async (t) => {
  const dir = work(t);
  const e = await station(t, dir);
  const tu = await e.addNode({ parent: e.root.id, op: 'core.tuner', selection: { f0: 100e6 - 5e3, f1: 100e6 + 5e3 }, at: 0.05 });
  const fm = await e.addNode({ parent: tu.id, op: 'core.fm_discriminator', at: 0.05 });
  const sl = await e.addNode({ parent: fm.id, op: 'core.pwm_slicer', at: 0.05 });
  const r = recipeGrc(e, sl.id, 'with a slicer');
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /stops before .*no block/);
  assert.match(r.text, /id: note/);
});

test('a chain exported as a program compiles as a GRC flowgraph that reads the capture', { skip }, async (t) => {
  const dir = work(t);
  const e = await station(t, dir);
  const tu = await e.addNode({ parent: e.root.id, op: 'core.tuner', selection: { f0: 100e6 - 120e3, f1: 100e6 + 120e3 }, at: 0.05 });
  const fm = await e.addNode({ parent: tu.id, op: 'core.fm_discriminator', at: 0.05 });
  const st = await e.addNode({ parent: fm.id, op: 'core.stereo', at: 0.05 });
  const r = programGrc(e, st.id, 'station program');
  const file = path.join(dir, `${r.name}.grc`);
  fs.writeFileSync(file, r.text);
  const c = compile(file, dir);
  assert.ok(c.ok, c.log);
  const py = fs.readFileSync(path.join(dir, `${r.name}.py`), 'utf8');
  assert.match(py, /file_source\(gr\.sizeof_gr_complex\*1, 'station\.cf32'/);
  assert.match(py, /wfm_rcv_pll/);
  assert.match(py, /audio\.sink/);
});
