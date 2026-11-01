// The whole-capture map: a row is a peak hold over its slice of time (engine `_holdSpectrum`).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockEngine, HOLD_FFTS } from '../src/engine.js';
import { Capture } from '../src/capture.js';
import { GrEngine } from '../../server/gr/engine.js';
import { sceneRecording } from '../../server/gr/scene.js';
import * as scene from '../src/scene.js';
import { spectrum } from '../src/dsp.js';

const FS = 100_000, CENTER = 433_920_000, SECONDS = 10;
const BURST_AT = 4.31, BURST_S = 0.02, BURST_HZ = 20_000;

/** Noise, and one 20 ms tone burst 20 kHz up at 4.31 s. */
async function burstEngine() {
  const n = FS * SECONDS, buf = new Uint8Array(n * 2);
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32 - 0.5) * 6;
  for (let i = 0; i < n; i++) {
    const t = i / FS, on = t >= BURST_AT && t < BURST_AT + BURST_S;
    const a = 2 * Math.PI * BURST_HZ * t;
    buf[i * 2] = Math.round(127.5 + rnd() + (on ? 80 * Math.cos(a) : 0));
    buf[i * 2 + 1] = Math.round(127.5 + rnd() + (on ? 80 * Math.sin(a) : 0));
  }
  const e = new MockEngine({ latency: false });
  await e.createSession();
  await e.openCapture(new Capture({ buffer: buf.buffer, format: 'cu8', sampleRate: FS, centerHz: CENTER, label: 'burst' }));
  return e;
}

/** dB at the burst's bin over the median bin. */
function lift(data) {
  const bin = Math.round(data.length / 2 + (BURST_HZ / FS) * data.length);
  const sorted = Array.from(data).sort((a, b) => a - b);
  return data[bin] - sorted[sorted.length >> 1];
}

test('a row holds a burst that one FFT at its moment would miss', async () => {
  const e = await burstEngine();
  const at = 4.5, holdS = 0.25;
  const one = e.frame(e.root.id, { bins: 1024, at });
  const row = e.frame(e.root.id, { bins: 1024, at, holdS });
  assert.ok(lift(one.data) < 6, `one FFT at ${at} s already shows it: ${lift(one.data).toFixed(1)} dB`);
  assert.ok(lift(row.data) > 30, `the row shows the burst ${lift(row.data).toFixed(1)} dB up`);
  // 25 000 samples, so 25 FFTs of 1024 read all of it.
  assert.equal(row.hold.ffts, 25);
  assert.equal(row.hold.coverage, 1);
  // and a row from before the burst does not
  assert.ok(lift(e.frame(e.root.id, { bins: 1024, at: 4.25, holdS }).data) < 6);
});

test('a long row reads a capped number of FFTs, and says how much of it that is', async () => {
  const e = await burstEngine();
  const r = e.frame(e.root.id, { bins: 1024, at: 9, holdS: 5 });
  assert.equal(r.hold.ffts, HOLD_FFTS);
  assert.ok(Math.abs(r.hold.coverage - (HOLD_FFTS * 1024) / (5 * FS)) < 1e-9);
});

test('a tuner\'s row holds the burst too, at the tuner\'s own offset', async () => {
  const e = await burstEngine();
  const t = await e.addNode({ parent: e.root.id, op: 'core.tuner', at: 4.4,
    selection: { f0: CENTER + 10_000, f1: CENTER + 30_000 } });
  const n = e.node(t.id);
  const row = e.frame(t.id, { bins: 256, at: 4.5, holdS: 0.25 });
  const mid = row.data.length / 2;
  const sorted = Array.from(row.data).sort((a, b) => a - b);
  assert.equal(n.out.centerHz, CENTER + BURST_HZ);
  assert.ok(row.data[mid] - sorted[sorted.length >> 1] > 30, 'the burst sits at the tuner\'s center');
});

test('on the server, a row of the scene reads its recording and agrees with the JS scene', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whole-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rec = sceneRecording(dir, { seconds: 2 });
  for (let i = 0; i < 600 && !rec.ready; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(rec.ready, 'recorded within 30 s');
  const gr = new GrEngine({ latency: false }, null, { scene: rec });
  const js = new MockEngine({ latency: false });
  for (const e of [gr, js]) await e.createSession();
  t.after(() => gr.close());
  const opts = { bins: 1024, at: 1.6, holdS: 0.5 };
  const a = gr.frame(gr.root.id, opts);
  const b = js.frame(js.root.id, opts);
  assert.equal(a.hold.ffts, HOLD_FFTS, 'the recording is read at the full count');
  assert.ok(gr._sceneFd != null, 'from the file');
  // The JS scene reads fewer windows in the tab, so compare the GNU Radio engine's row with
  // the same windows read from the scene directly.
  const want = new Float32Array(1024).fill(-200);
  const fs0 = scene.SOURCE.sampleRate;
  for (let i = 0; i < HOLD_FFTS; i++) {
    const tEnd = opts.at - opts.holdS + ((i + 1) * opts.holdS) / HOLD_FFTS;
    const iq = scene.read(Math.floor(tEnd * fs0) - 1024, 1024, false);
    const s = spectrum(iq, 1024, 'Hann');
    for (let j = 0; j < 1024; j++) want[j] = Math.max(want[j], s[j]);
  }
  let worst = 0;
  for (let j = 0; j < 1024; j++) worst = Math.max(worst, Math.abs(a.data[j] - want[j]));
  assert.ok(worst < 0.01, `differs by ${worst} dB`);
  assert.equal(b.hold.ffts, 8, 'the tab computes the scene, so it reads fewer windows');
});
