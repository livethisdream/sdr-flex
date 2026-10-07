// FM stereo, computed by GNU Radio (ADR-0044, migration step 3).
//
//   node --test web/test/grstereo.test.mjs
//
// Skipped where GNU Radio is not installed; it runs in the image `Dockerfile.full` builds.
// The known answer is the broadcast standard (ITU-R BS.450), not this project's modulator:
// that modulator and the JS decoder were both 90° off together, and agreed with each other.
// Here a 400 Hz tone is on the left and 3 kHz on the right, with the pilot and subcarrier in
// the phase the standard fixes, and what is measured is how much of each leaks across.

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

const FS = 500_000, CENTER = 100_000_000, SECONDS = 2, L_HZ = 400, R_HZ = 3_000;

/** A standard stereo broadcast at the capture's center: sin pilot, sin(2θ) subcarrier. */
function stationFile() {
  const n = FS * SECONDS, buf = Buffer.alloc(n * 8);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / FS, L = Math.sin(2 * Math.PI * L_HZ * t), R = Math.sin(2 * Math.PI * R_HZ * t);
    const th = 2 * Math.PI * 19_000 * t + 0.7;
    const mpx = 0.45 * (L + R) / 2 + 0.09 * Math.sin(th) + 0.45 * (L - R) / 2 * Math.sin(2 * th);
    ph += (2 * Math.PI * 75_000 * mpx) / FS;
    buf.writeFloatLE(0.5 * Math.cos(ph), i * 8);
    buf.writeFloatLE(0.5 * Math.sin(ph), i * 8 + 4);
  }
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'grstereo-')), 'station.cf32');
  fs.writeFileSync(file, buf);
  return file;
}

async function chains(t) {
  const file = stationFile();
  const open = () => new FileCapture({ path: file, format: 'cf32', sampleRate: FS, centerHz: CENTER, label: 'station' });
  const w = new GrWorker();
  t.after(() => { w.stop(); fs.rmSync(path.dirname(file), { recursive: true, force: true }); });
  const out = {};
  for (const [name, e] of [['gr', new GrEngine({ latency: false }, w)], ['js', new MockEngine({ latency: false })]]) {
    await e.createSession(); await e.openCapture(open());
    // 240 kHz: a broadcast station's sidebands reach past 200 kHz, and a narrower channel
    // costs separation before the stereo decoder ever sees the signal (36 dB at 200 kHz).
    const tu = await e.addNode({ parent: e.root.id, op: 'core.tuner', selection: { f0: CENTER - 120_000, f1: CENTER + 120_000 }, at: 0.5 });
    const fm = await e.addNode({ parent: tu.id, op: 'core.fm_discriminator', at: 0.5 });
    await e.setParam(fm.id, 'deviationHz', 75_000, 'manual');
    await e.setParam(fm.id, 'gain', 1, 'manual');
    const st = await e.addNode({ parent: fm.id, op: 'core.stereo', at: 0.5 });
    await e.setParam(st.id, 'deemphasisUs', 0, 'manual');
    out[name] = { e, st: e.node(st.id) };
  }
  return out;
}

function amp(x, ch, fs, hz) {
  let re = 0, im = 0, n = 0;
  for (let i = ch; i < x.length; i += 2) { const a = (2 * Math.PI * hz * n) / fs; re += x[i] * Math.cos(a); im += x[i] * Math.sin(a); n++; }
  return (2 * Math.hypot(re, im)) / n;
}
const separation = (x, fs) => Math.min(20 * Math.log10(amp(x, 0, fs, L_HZ) / amp(x, 0, fs, R_HZ)),
                                       20 * Math.log10(amp(x, 1, fs, R_HZ) / amp(x, 1, fs, L_HZ)));

test('a standard stereo signal comes apart by at least 40 dB', { skip }, async (t) => {
  const { gr } = await chains(t);
  assert.equal(gr.st.params.decode.value, 'stereo', 'the pilot was found');
  const fs = gr.st.out.sampleRate, count = Math.round(fs * 0.5), at = 1.4;
  await gr.e.prepare(gr.st.id, at, count / fs);
  const before = gr.e.grStats.misses;
  const x = gr.e._detect(gr.st, at, count);
  assert.equal(gr.e.grStats.misses - before, 0, 'read entirely from GNU Radio blocks');
  const sep = separation(x, fs);
  t.diagnostic(`separation ${sep.toFixed(1)} dB`);
  assert.ok(sep >= 40, `separation ${sep.toFixed(1)} dB`);
});

test('GNU Radio and the JS decoder hear the same tones, now both follow the standard', { skip }, async (t) => {
  // The tones, not the waveforms. Each decoder has one small artifact of its own, about
  // 35 dB down and below hearing: the JS low-pass lets a little of the 19 kHz pilot through,
  // and GNU Radio's pilot PLL, at the loop bandwidth wfm_rcv_pll uses, wobbles enough to put
  // sidebands 50 Hz either side of a tone. Raw correlation counted both as disagreement
  // (0.966), when what the person hears — which tone, how loud, when — agrees.
  const { gr, js } = await chains(t);
  const fs = gr.st.out.sampleRate, count = Math.round(fs * 0.4), at = 1.2;
  await gr.e.prepare(gr.st.id, at, count / fs);
  const a = gr.e._detect(gr.st, at, count), b = js.e._detect(js.st, at, count);
  const phasor = (x, ch, hz) => {
    let re = 0, im = 0, n = 0;
    for (let i = ch; i < x.length; i += 2) { const q = (2 * Math.PI * hz * n) / fs; re += x[i] * Math.cos(q); im += x[i] * Math.sin(q); n++; }
    return { a: (2 * Math.hypot(re, im)) / n, deg: (Math.atan2(im, re) * 180) / Math.PI };
  };
  for (const [ch, hz] of [[0, L_HZ], [1, R_HZ]]) {
    const g = phasor(a, ch, hz), j = phasor(b, ch, hz);
    const db = 20 * Math.log10(g.a / j.a), deg = Math.abs(((g.deg - j.deg + 540) % 360) - 180);
    t.diagnostic(`${ch ? 'right' : 'left'} ${hz} Hz: level ${db.toFixed(2)} dB apart, phase ${deg.toFixed(2)}° apart`);
    assert.ok(Math.abs(db) < 1, `level differs by ${db} dB`);
    assert.ok(deg < 2, `phase differs by ${deg}°`);
  }
});

test('decoded as mono, left and right are the same', { skip }, async (t) => {
  const { gr } = await chains(t);
  await gr.e.setParam(gr.st.id, 'decode', 'mono', 'manual');
  const st = gr.e.node(gr.st.id);
  const fs = st.out.sampleRate, count = Math.round(fs * 0.2), at = 1.0;
  await gr.e.prepare(st.id, at, count / fs);
  const x = gr.e._detect(st, at, count);
  let worst = 0;
  for (let i = 0; i < count; i++) worst = Math.max(worst, Math.abs(x[i * 2] - x[i * 2 + 1]));
  assert.equal(worst, 0);
});

test('reads that meet end to end are one read', { skip }, async (t) => {
  const { gr } = await chains(t);
  const fs = gr.st.out.sampleRate, n = 4000, t1 = 0.9, t2 = t1 + n / fs;
  await gr.e.prepare(gr.st.id, t2, (2 * n) / fs);
  const first = gr.e._detect(gr.st, t1, n), second = gr.e._detect(gr.st, t2, n), whole = gr.e._detect(gr.st, t2, 2 * n);
  assert.deepEqual(Array.from(first), Array.from(whole.subarray(0, n * 2)));
  assert.deepEqual(Array.from(second), Array.from(whole.subarray(n * 2)));
});
