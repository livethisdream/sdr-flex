// The tuner, computed by GNU Radio (ADR-0044, migration step 1).
//
//   node --test web/test/grtuner.test.mjs
//
// Skipped where GNU Radio is not installed; it runs in the image `Dockerfile.full` builds.
// The known answer is a tone written into a capture at a known frequency and level, not the
// JS tuner's output: agreeing with the JS engine is checked too, but separately, because two
// implementations agreeing proves only that they agree (the stereo decoder and its test
// modulator agreed, and both were 90° wrong).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MockEngine } from '../src/engine.js';
import { GrEngine } from '../../server/gr/engine.js';
import { GrWorker } from '../../server/gr/worker.js';
import { FileCapture } from '../../server/filecapture.js';

const python = process.env.SDRFLEX_GR_PYTHON || 'python3';
const hasGr = spawnSync(python, ['-c', 'import gnuradio.gr'], { stdio: 'ignore' }).status === 0;
const skip = !hasGr && 'GNU Radio is not installed';

const FS = 500_000, TONE_HZ = 30_000, AMP = 0.5, CENTER = 100_000_000, SECONDS = 2;

/** A cf32 capture holding one tone at TONE_HZ from center, amplitude AMP, plus a little noise. */
function toneFile() {
  const n = FS * SECONDS, buf = Buffer.alloc(n * 8);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32 - 0.5) * 1e-3;
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * TONE_HZ * i) / FS;
    buf.writeFloatLE(AMP * Math.cos(a) + rnd(), i * 8);
    buf.writeFloatLE(AMP * Math.sin(a) + rnd(), i * 8 + 4);
  }
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'grtuner-')), 'tone.cf32');
  fs.writeFileSync(file, buf);
  return file;
}

async function engines(t) {
  const file = toneFile();
  const open = () => new FileCapture({ path: file, format: 'cf32', sampleRate: FS, centerHz: CENTER, label: 'tone' });
  const w = new GrWorker();
  t.after(() => { w.stop(); fs.rmSync(path.dirname(file), { recursive: true, force: true }); });
  const gr = new GrEngine({ latency: false }, w);
  const js = new MockEngine({ latency: false });
  for (const e of [gr, js]) { await e.createSession(); await e.openCapture(open()); }
  // A 20 kHz channel centered 25 kHz up: the tone lands 5 kHz above the channel's center.
  const sel = { f0: CENTER + 15_000, f1: CENTER + 35_000 };
  const tg = await gr.addNode({ parent: gr.root.id, op: 'core.tuner', selection: sel, at: 0.5 });
  const tj = await js.addNode({ parent: js.root.id, op: 'core.tuner', selection: sel, at: 0.5 });
  return { gr, js, tg: gr.node(tg.id), tj: js.node(tj.id) };
}

test('a known tone comes out at the right frequency and level', { skip }, async (t) => {
  const { gr, tg } = await engines(t);
  const fs = tg.out.sampleRate, count = 4096, at = 1.0;
  await gr.prepare(tg.id, at, count / fs);
  const iq = gr._readIQ(tg, at, count);
  assert.equal(gr.grStats.misses, 0, 'read entirely from GNU Radio blocks');
  let turn = 0, mag = 0;
  for (let i = 1; i < count; i++) {
    const re = iq[i * 2] * iq[(i - 1) * 2] + iq[i * 2 + 1] * iq[(i - 1) * 2 + 1];
    const im = iq[i * 2 + 1] * iq[(i - 1) * 2] - iq[i * 2] * iq[(i - 1) * 2 + 1];
    turn += Math.atan2(im, re);
    mag += Math.hypot(iq[i * 2], iq[i * 2 + 1]);
  }
  const hz = (turn / (count - 1)) * fs / (2 * Math.PI);
  const db = 20 * Math.log10(mag / (count - 1) / AMP);
  const bin = fs / 1024;
  t.diagnostic(`tone at ${hz.toFixed(1)} Hz (want 5000, one bin is ${bin.toFixed(1)}), level ${db.toFixed(3)} dB`);
  assert.ok(Math.abs(hz - 5_000) < bin, `tone at ${hz} Hz`);
  assert.ok(Math.abs(db) < 0.5, `level off by ${db} dB`);
});

test('GNU Radio gives the JS tuner\'s samples, across block boundaries', { skip }, async (t) => {
  const { gr, js, tg, tj } = await engines(t);
  const fs = tg.out.sampleRate, count = Math.round(fs * 0.4), at = 1.3;   // spans two block seams
  await gr.prepare(tg.id, at, count / fs);
  const a = gr._readIQ(tg, at, count), b = js._readIQ(tj, at, count);
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  t.diagnostic(`largest difference ${worst.toExponential(2)} on a signal of amplitude ${AMP}`);
  assert.ok(worst < 2e-3 * AMP, `differs by ${worst}`);
});

test('reads that meet end to end are one read, and every block is full length', { skip }, async (t) => {
  const { gr, tg } = await engines(t);
  const fs = tg.out.sampleRate, n = 3000, t1 = 0.9, t2 = t1 + n / fs;
  await gr.prepare(tg.id, t2, (2 * n) / fs);
  const first = gr._readIQ(tg, t1, n), second = gr._readIQ(tg, t2, n), whole = gr._readIQ(tg, t2, 2 * n);
  assert.deepEqual(Array.from(first), Array.from(whole.subarray(0, n * 2)));
  assert.deepEqual(Array.from(second), Array.from(whole.subarray(n * 2)));
  const B = Math.round(0.25 * fs);
  for (const blk of tg._grBlocks.values()) if (blk) assert.equal(blk.length, B * 2, 'a 0.25 s block, not ~10 ms short');
});

test('a read nobody prepared is answered by the JS engine, and counted', { skip }, async (t) => {
  const { gr, js, tg, tj } = await engines(t);
  const fs = tg.out.sampleRate, count = 2000, at = 1.7;
  const a = gr._readIQ(tg, at, count), b = js._readIQ(tj, at, count);
  assert.equal(gr.grStats.misses, 1);
  assert.deepEqual(Array.from(a), Array.from(b));
});
