// The CW demod and its filter, in JS and computed by GNU Radio (ADR-0043, ADR-0044).
//
//   node --test web/test/grcw.test.mjs
//
// The GNU Radio half is skipped where GNU Radio is not installed; it runs in the image
// `Dockerfile.full` builds. The known answer is a carrier at a known place in a wide channel
// full of noise: the beat must land on the pitch, and the noise away from it must go.

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

// A carrier 25.3 kHz up, in noise spread across the whole capture.
const FS = 250_000, CARRIER_HZ = 25_300, AMP = 0.05, NOISE = 0.2, CENTER = 7_000_000, SECONDS = 2;

function carrierFile() {
  const n = FS * SECONDS, buf = Buffer.alloc(n * 8);
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32 - 0.5) * NOISE;
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * CARRIER_HZ * i) / FS;
    buf.writeFloatLE(AMP * Math.cos(a) + rnd(), i * 8);
    buf.writeFloatLE(AMP * Math.sin(a) + rnd(), i * 8 + 4);
  }
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'grcw-')), 'carrier.cf32');
  fs.writeFileSync(file, buf);
  return file;
}

async function engines(t, { gr: withGr = true } = {}) {
  const file = carrierFile();
  const open = () => new FileCapture({ path: file, format: 'cf32', sampleRate: FS, centerHz: CENTER, label: 'cw' });
  const w = withGr ? new GrWorker() : null;
  t.after(() => { if (w) w.stop(); fs.rmSync(path.dirname(file), { recursive: true, force: true }); });
  const out = {};
  for (const [name, e] of [['js', new MockEngine({ latency: false })], ...(w ? [['gr', new GrEngine({ latency: false }, w)]] : [])]) {
    await e.createSession(); await e.openCapture(open());
    // A 20 kHz box, the width a finger draws, with the carrier 300 Hz off its center.
    const tu = await e.addNode({ parent: e.root.id, op: 'core.tuner', selection: { f0: CENTER + 15_000, f1: CENTER + 35_000 }, at: 1 });
    const cw = await e.addNode({ parent: tu.id, op: 'core.cw', at: 1 });
    out[name] = { e, cw: e.node(cw.id) };
  }
  return out;
}

/** Power at `hz` and the average power elsewhere, by a direct DFT over a few bins. */
function tone(x, fs, hz) {
  const n = x.length;
  const at = (f) => {
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) { const a = (2 * Math.PI * f * i) / fs; re += x[i] * Math.cos(a); im -= x[i] * Math.sin(a); }
    return (re * re + im * im) / (n * n);
  };
  // Noise is noise: one bin of it varies by its own size, so the average is over fifty.
  let away = 0;
  const others = Array.from({ length: 50 }, (_, i) => hz + 1500 + i * 150);
  for (const f of others) away += at(f);
  return { on: at(hz), away: away / others.length };
}

test('the carrier is measured, and the beat lands on the pitch above the noise', async (t) => {
  const { js } = await engines(t, { gr: false });
  const { e, cw } = js;
  const off = cw.params.offsetHz.value;
  t.diagnostic(`carrier measured at ${off} Hz from the channel's center (want about 300)`);
  assert.ok(Math.abs(off - 300) < 60, `offset ${off}`);
  const fs = cw.out.sampleRate, count = 8192;
  const x = e._detectRaw(cw, 1.2, count);
  const { on, away } = tone(x, fs, cw.params.pitchHz.value);
  const db = 10 * Math.log10(on / away);
  t.diagnostic(`pitch ${(db).toFixed(1)} dB above a bin away from it`);
  assert.ok(db > 30, `only ${db} dB`);
});

test('the filter takes the noise away from the pitch, and leaves the beat', async (t) => {
  const { js } = await engines(t, { gr: false });
  const { e, cw } = js;
  const fs = cw.out.sampleRate, count = 8192, pitch = cw.params.pitchHz.value;
  const filtered = tone(e._detectRaw(cw, 1.2, count), fs, pitch);
  cw.params.filterHz.value = '0';
  const open = tone(e._detectRaw(cw, 1.2, count), fs, pitch);
  const cut = 10 * Math.log10(open.away / filtered.away);
  const kept = 10 * Math.log10(filtered.on / open.on);
  t.diagnostic(`noise away from the pitch down ${cut.toFixed(1)} dB; the beat changed ${kept.toFixed(2)} dB`);
  assert.ok(cut > 20, `noise only ${cut} dB down`);
  assert.ok(Math.abs(kept) < 1, `beat changed ${kept} dB`);
});

test('blocks join: two reads end to end are one read', async (t) => {
  const { js } = await engines(t, { gr: false });
  const { e, cw } = js;
  const fs = cw.out.sampleRate, n = 3000, t1 = 0.9, t2 = t1 + n / fs;
  const a = e._detectRaw(cw, t1, n), b = e._detectRaw(cw, t2, n), whole = e._detectRaw(cw, t2, 2 * n);
  let worst = 0;
  for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(a[i] - whole[i]), Math.abs(b[i] - whole[n + i]));
  assert.ok(worst < 1e-5, `differs by ${worst}`);
});

test('GNU Radio gives the JS CW demod\'s samples, across block boundaries', { skip }, async (t) => {
  const { js, gr } = await engines(t);
  assert.equal(gr.e._grKind(gr.cw), 'cw');
  const fs = gr.cw.out.sampleRate, count = Math.round(fs * 0.4), at = 1.3;   // spans two block seams
  // Adding the node measured the carrier from the tuner, unprepared; that read is not this one.
  gr.e.grStats.misses = 0;
  await gr.e.prepare(gr.cw.id, at, count / fs);
  const a = gr.e._detectRaw(gr.cw, at, count), b = js.e._detectRaw(js.cw, at, count);
  assert.equal(gr.e.grStats.misses, 0, 'read entirely from GNU Radio blocks');
  let worst = 0, peak = 0;
  for (let i = 0; i < count; i++) { worst = Math.max(worst, Math.abs(a[i] - b[i])); peak = Math.max(peak, Math.abs(b[i])); }
  t.diagnostic(`largest difference ${worst.toExponential(2)} on a peak of ${peak.toFixed(4)}`);
  assert.ok(worst < 2e-3 * peak, `differs by ${worst}`);
});

test('the filter\'s length is its delay', () => {
  const taps = dsp.cwTaps(25_000, 500);
  assert.equal(taps.length % 2, 1);
  assert.ok(taps.length / 25_000 < 0.03, 'shorter than the detector cache\'s margin');
});
