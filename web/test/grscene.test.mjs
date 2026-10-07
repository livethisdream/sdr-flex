// The synthetic scene, read by GNU Radio from its recording (server/gr/scene.js).
//
//   node --test web/test/grscene.test.mjs
//
// Skipped where GNU Radio is not installed; it runs in the image `Dockerfile.full` builds.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MockEngine } from '../src/engine.js';
import { GrEngine } from '../../server/gr/engine.js';
import { GrWorker } from '../../server/gr/worker.js';
import { sceneRecording } from '../../server/gr/scene.js';
import * as scene from '../src/scene.js';

const python = process.env.SDRFLEX_GR_PYTHON || 'python3';
const hasGr = spawnSync(python, ['-c', 'import gnuradio.gr'], { stdio: 'ignore' }).status === 0;
const skip = !hasGr && 'GNU Radio is not installed';

async function recorded(t, seconds) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grscene-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rec = sceneRecording(dir, { seconds });
  for (let i = 0; i < 600 && !rec.ready; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(rec.ready, 'recorded within 30 s');
  return rec;
}

test('the recording is the scene, sample for sample', async (t) => {
  const rec = await recorded(t, 1);
  const buf = fs.readFileSync(rec.path);
  const file = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  assert.equal(file.length, scene.SOURCE.sampleRate * 2);
  const k = 300_000, n = 1000;
  const want = scene.read(k, n);
  let worst = 0;
  for (let i = 0; i < n * 2; i++) worst = Math.max(worst, Math.abs(file[k * 2 + i] - want[i]));
  assert.ok(worst < 1e-4, `differs by ${worst}`);
});

test('with nothing open, a tuner is GNU Radio\'s and gives the JS tuner\'s samples', { skip }, async (t) => {
  const rec = await recorded(t, 2);
  const w = new GrWorker();
  t.after(() => w.stop());
  const gr = new GrEngine({ latency: false }, w, { scene: rec });
  const js = new MockEngine({ latency: false });
  for (const e of [gr, js]) await e.createSession();
  const c = scene.SOURCE.centerHz, sel = { f0: c + 40e3, f1: c + 220e3 };
  const tg = gr.node((await gr.addNode({ parent: gr.root.id, op: 'core.tuner', selection: sel, at: 0.5 })).id);
  const tj = js.node((await js.addNode({ parent: js.root.id, op: 'core.tuner', selection: sel, at: 0.5 })).id);
  assert.equal(gr._grKind(tg), 'tuner');
  const fs = tg.out.sampleRate, count = Math.round(fs * 0.4), at = 1.3;
  await gr.prepare(tg.id, at, count / fs);
  const a = gr._readIQ(tg, at, count), b = js._readIQ(tj, at, count);
  assert.equal(gr.grStats.misses, 0, 'read entirely from GNU Radio blocks');
  let worst = 0, peak = 0;
  for (let i = 0; i < a.length; i++) { worst = Math.max(worst, Math.abs(a[i] - b[i])); peak = Math.max(peak, Math.abs(b[i])); }
  t.diagnostic(`largest difference ${worst.toExponential(2)} on a peak of ${peak.toFixed(3)}`);
  assert.ok(worst < 2e-3 * peak, `differs by ${worst}`);
  // Past the end of the recording the JS scene answers, and that is not a miss.
  const past = gr._readIQ(tg, 2.5, 1000);
  assert.deepEqual(Array.from(past), Array.from(js._readIQ(tj, 2.5, 1000)));
  assert.equal(gr.grStats.misses, 0);
});
