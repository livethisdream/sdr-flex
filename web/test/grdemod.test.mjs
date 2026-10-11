// The AM and SSB demods, in JS and computed by GNU Radio as their recipes (recipes/am.grc,
// recipes/ssb.grc; ADR-0043, ADR-0044).
//
//   node --test web/test/grdemod.test.mjs
//
// The GNU Radio half is skipped where GNU Radio is not installed; it runs in the image
// `Dockerfile.full` builds. The known answers: an AM carrier modulated by a 1 kHz tone, and a
// single 1 kHz tone above a suppressed carrier, which is upper sideband by construction.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MockEngine } from '../src/engine.js';
import * as dsp from '../src/dsp.js';
import { GrEngine } from '../../server/gr/engine.js';
import { GrWorker } from '../../server/gr/worker.js';
import { FileCapture } from '../../server/filecapture.js';

const python = process.env.SDRFLEX_GR_PYTHON || 'python3';
const hasGr = spawnSync(python, ['-c', 'import gnuradio.gr'], { stdio: 'ignore' }).status === 0;
const skip = !hasGr && 'GNU Radio is not installed';

// AM 40 kHz down, SSB 40 kHz up, in a little noise.
const FS = 250_000, CENTER = 7_000_000, SECONDS = 2, TONE = 1_000;
const AM_HZ = -40_000, SSB_HZ = 40_000;

function file() {
  const n = FS * SECONDS, buf = Buffer.alloc(n * 8);
  let seed = 5;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32 - 0.5) * 0.01;
  for (let i = 0; i < n; i++) {
    const m = 1 + 0.5 * Math.sin((2 * Math.PI * TONE * i) / FS);
    const a = (2 * Math.PI * AM_HZ * i) / FS, s = (2 * Math.PI * (SSB_HZ + TONE) * i) / FS;
    buf.writeFloatLE(0.1 * m * Math.cos(a) + 0.1 * Math.cos(s) + rnd(), i * 8);
    buf.writeFloatLE(0.1 * m * Math.sin(a) + 0.1 * Math.sin(s) + rnd(), i * 8 + 4);
  }
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'grdemod-')), 'demod.cf32');
  fs.writeFileSync(f, buf);
  return f;
}

async function engines(t, op, at, set = {}) {
  const f = file();
  const open = () => new FileCapture({ path: f, format: 'cf32', sampleRate: FS, centerHz: CENTER, label: 'demod' });
  const w = new GrWorker();
  t.after(() => { w.stop(); fs.rmSync(path.dirname(f), { recursive: true, force: true }); });
  const out = {};
  for (const [name, e] of [['js', new MockEngine({ latency: false })], ['gr', new GrEngine({ latency: false }, w)]]) {
    await e.createSession(); await e.openCapture(open());
    const tu = await e.addNode({ parent: e.root.id, op: 'core.tuner', selection: { f0: CENTER + at - 5_000, f1: CENTER + at + 5_000 }, at: 1 });
    const d = await e.addNode({ parent: tu.id, op, at: 1 });
    for (const [k, v] of Object.entries(set)) await e.setParam(d.id, k, v, 'manual');
    out[name] = { e, d: e.node(d.id) };
  }
  return out;
}

/** GNU Radio's samples against the JS demod's, over a read that crosses block seams. */
async function agree(t, { js, gr }, kind) {
  assert.equal(gr.e._grKind(gr.d), kind);
  assert.equal(gr.e._grSpec(gr.d).recipe, kind, `run as the recipe, recipes/${kind}.grc`);
  const fs = gr.d.out.sampleRate, count = Math.round(fs * 0.4), at = 1.3;
  gr.e.grStats.misses = 0;
  await gr.e.prepare(gr.d.id, at, count / fs);
  const a = gr.e._detectRaw(gr.d, at, count), b = js.e._detectRaw(js.d, at, count);
  assert.equal(gr.e.grStats.misses, 0, 'read entirely from GNU Radio blocks');
  let worst = 0, peak = 0;
  for (let i = 0; i < count; i++) { worst = Math.max(worst, Math.abs(a[i] - b[i])); peak = Math.max(peak, Math.abs(b[i])); }
  t.diagnostic(`largest difference ${worst.toExponential(2)} on a peak of ${peak.toFixed(4)}`);
  assert.ok(peak > 0, 'there is a signal');
  assert.ok(worst < 2e-3 * peak, `differs by ${worst}`);
  return b;
}

/** Amplitude of a tone at `hz`, by correlation. */
function amp(x, fs, hz) {
  let re = 0, im = 0;
  for (let i = 0; i < x.length; i++) { const a = (2 * Math.PI * hz * i) / fs; re += x[i] * Math.cos(a); im += x[i] * Math.sin(a); }
  return (2 * Math.hypot(re, im)) / x.length;
}

test('the JS Hilbert transformer is the recipe\'s: GNU Radio\'s firdes.hilbert, tap for tap', { skip }, () => {
  const py = spawnSync(python, ['-c', `from gnuradio.filter import firdes
from gnuradio.fft import window
print(list(firdes.hilbert(65, window.WIN_HAMMING)))`], { encoding: 'utf8' });
  const want = JSON.parse(py.stdout), got = dsp.hilbertTaps(65);
  assert.equal(got.length, want.length);
  let worst = 0;
  for (let i = 0; i < want.length; i++) worst = Math.max(worst, Math.abs(got[i] - want[i]));
  assert.ok(worst < 1e-7, `differs by ${worst}`);
});

test('JS reads join: two AM reads end to end are one read, smoothing and all', async () => {
  const e = new MockEngine({ latency: false });
  const f = file();
  try {
    await e.createSession();
    await e.openCapture(new FileCapture({ path: f, format: 'cf32', sampleRate: FS, centerHz: CENTER, label: 'demod' }));
    const tu = await e.addNode({ parent: e.root.id, op: 'core.tuner', selection: { f0: CENTER + AM_HZ - 5_000, f1: CENTER + AM_HZ + 5_000 }, at: 1 });
    const am = e.node((await e.addNode({ parent: tu.id, op: 'core.am_envelope', at: 1 })).id);
    const fs = am.out.sampleRate, n = 3000, t1 = 0.9, t2 = t1 + n / fs;
    const a = e._detectRaw(am, t1, n), b = e._detectRaw(am, t2, n), whole = e._detectRaw(am, t2, 2 * n);
    let worst = 0;
    for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(a[i] - whole[i]), Math.abs(b[i] - whole[n + i]));
    assert.ok(worst < 1e-5, `differs by ${worst}`);
  } finally { fs.rmSync(path.dirname(f), { recursive: true, force: true }); }
});

test('GNU Radio gives the JS AM demod\'s samples, and the tone is there', { skip }, async (t) => {
  const pair = await engines(t, 'core.am_envelope', AM_HZ);
  const b = await agree(t, pair, 'am');
  const a = amp(b, pair.js.d.out.sampleRate, TONE);
  t.diagnostic(`1 kHz at ${a.toFixed(4)} (want about 0.05, half of the 0.1 carrier)`);
  assert.ok(Math.abs(a - 0.05) < 0.01);
});

test('GNU Radio gives the JS SSB demod\'s samples: upper sideband, with a BFO', { skip }, async (t) => {
  const pair = await engines(t, 'core.ssb', SSB_HZ, { sideband: 'usb', bfoHz: 300 });
  const b = await agree(t, pair, 'ssb');
  const fs = pair.js.d.out.sampleRate;
  // The tone 1 kHz above the carrier, moved down by the BFO.
  t.diagnostic(`700 Hz at ${amp(b, fs, 700).toFixed(4)}, 1300 Hz at ${amp(b, fs, 1300).toFixed(4)}`);
  assert.ok(amp(b, fs, 700) > 20 * amp(b, fs, 1300));
});

test('GNU Radio gives the JS SSB demod\'s samples: lower sideband, which rejects this tone', { skip }, async (t) => {
  const pair = await engines(t, 'core.ssb', SSB_HZ, { sideband: 'lsb', bfoHz: 0 });
  const b = await agree(t, pair, 'ssb');
  const fs = pair.js.d.out.sampleRate;
  const usb = 0.1 * 6;   // what upper sideband gives: the tone, times the node's gain
  t.diagnostic(`1 kHz at ${amp(b, fs, TONE).toFixed(4)}, against ${usb} on the right side`);
  assert.ok(amp(b, fs, TONE) < usb / 30);
});
