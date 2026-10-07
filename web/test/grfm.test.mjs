// FM demodulation, computed by GNU Radio (ADR-0044, migration step 2).
//
//   node --test web/test/grfm.test.mjs
//
// Skipped where GNU Radio is not installed; it runs in the image `Dockerfile.full` builds.
// The known answer is a 1 kHz tone frequency-modulated at exactly 5 kHz of deviation. With
// the demod's deviation set to 5 kHz by hand, the output is a 1 kHz tone of amplitude 1.0;
// nothing about that depends on SDR Flex's own estimator or on the JS demod.

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

const FS = 500_000, CARRIER = 30_000, TONE = 1_000, DEV = 5_000, CENTER = 100_000_000, SECONDS = 2;

function fmFile() {
  const n = FS * SECONDS, buf = Buffer.alloc(n * 8);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    phase += (2 * Math.PI * (CARRIER + DEV * Math.sin((2 * Math.PI * TONE * i) / FS))) / FS;
    buf.writeFloatLE(0.5 * Math.cos(phase), i * 8);
    buf.writeFloatLE(0.5 * Math.sin(phase), i * 8 + 4);
  }
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'grfm-')), 'fm.cf32');
  fs.writeFileSync(file, buf);
  return file;
}

async function chain(t) {
  const file = fmFile();
  const open = () => new FileCapture({ path: file, format: 'cf32', sampleRate: FS, centerHz: CENTER, label: 'fm' });
  const w = new GrWorker();
  t.after(() => { w.stop(); fs.rmSync(path.dirname(file), { recursive: true, force: true }); });
  const out = {};
  for (const [name, e] of [['gr', new GrEngine({ latency: false }, w)], ['js', new MockEngine({ latency: false })]]) {
    await e.createSession(); await e.openCapture(open());
    const tu = await e.addNode({ parent: e.root.id, op: 'core.tuner', selection: { f0: CENTER + 22_000, f1: CENTER + 38_000 }, at: 0.5 });
    const fm = await e.addNode({ parent: tu.id, op: 'core.fm_discriminator', at: 0.5 });
    await e.setParam(fm.id, 'deviationHz', DEV, 'manual');
    await e.setParam(fm.id, 'gain', 1, 'manual');
    out[name] = { e, tu: e.node(tu.id), fm: e.node(fm.id) };
  }
  return out;
}

/** Amplitude and frequency of the strongest tone, by correlation over a grid. */
function tone(x, fs) {
  const amp = (hz) => { let re = 0, im = 0; for (let i = 0; i < x.length; i++) { const a = (2 * Math.PI * hz * i) / fs; re += x[i] * Math.cos(a); im += x[i] * Math.sin(a); } return (2 * Math.hypot(re, im)) / x.length; };
  let best = { hz: 0, a: 0 };
  for (let hz = 900; hz <= 1100; hz += 1) { const a = amp(hz); if (a > best.a) best = { hz, a }; }
  return best;
}

test('a 1 kHz tone at 5 kHz deviation comes back as a 1 kHz tone of amplitude 1', { skip }, async (t) => {
  const { gr } = await chain(t);
  const fs = gr.fm.out.sampleRate, count = Math.round(fs * 0.2), at = 1.0;
  await gr.e.prepare(gr.fm.id, at, count / fs);
  // Setting the chain up read the tuner to derive parameters before anything was prefetched;
  // what matters is that this read, prepared, misses nothing.
  const before = gr.e.grStats.misses;
  const x = gr.e._detect(gr.fm, at, count);
  assert.equal(gr.e.grStats.misses - before, 0, 'read entirely from GNU Radio blocks');
  const { hz, a } = tone(x, fs);
  const db = 20 * Math.log10(a / 1.0);
  t.diagnostic(`tone at ${hz} Hz, amplitude ${a.toFixed(4)} (${db.toFixed(3)} dB)`);
  assert.ok(Math.abs(hz - TONE) <= 1, `tone at ${hz} Hz`);
  assert.ok(Math.abs(db) < 0.5, `level off by ${db} dB`);
});

test('GNU Radio gives the JS demod\'s samples, across block boundaries', { skip }, async (t) => {
  const { gr, js } = await chain(t);
  const fs = gr.fm.out.sampleRate, count = Math.round(fs * 0.6), at = 1.4;
  await gr.e.prepare(gr.fm.id, at, count / fs);
  const a = gr.e._detect(gr.fm, at, count), b = js.e._detect(js.fm, at, count);
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  t.diagnostic(`largest difference ${worst.toExponential(2)} on a signal of amplitude 1`);
  assert.ok(worst < 2e-3, `differs by ${worst}`);
});

test('reading the demod fetches the demod, not its tuner as well', { skip }, async (t) => {
  // Its blocks were made in one flowgraph with the tuner, so the tuner's own blocks would be
  // a second copy of the same work.
  const { gr } = await chain(t);
  await gr.e.prepare(gr.fm.id, 1.0, 0.1);
  assert.ok(gr.fm._grBlocks && gr.fm._grBlocks.size > 0, 'the demod has blocks');
  assert.ok(!gr.tu._grBlocks || gr.tu._grBlocks.size === 0, 'the tuner was not fetched');
});
