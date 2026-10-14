// The NRZ and Manchester slicers and differential decoding, in JS and computed by GNU Radio
// as their recipes (recipes/nrz.grc, manchester.grc, differential.grc; ADR-0043, ADR-0044).
//
//   node --test web/test/grslicer.test.mjs
//
// The GNU Radio half is skipped where GNU Radio is not installed; it runs in the image
// `Dockerfile.full` builds. The known answer: on-off keyed packets with a known sync word and
// payload, NRZ 40 kHz down and Manchester 40 kHz up, in a little noise.

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

const FS = 250_000, CENTER = 433_000_000, SECONDS = 2;
const NRZ_HZ = -40_000, MAN_HZ = 40_000, NRZ_BAUD = 2400, MAN_BAUD = 1200;
const SYNC = [0x2d, 0xd4];
const PAYLOAD = Array.from({ length: 24 }, (_, i) => (i * 97 + 13) & 0xff);
const PACKET = [0xaa, 0xaa, 0xaa, 0xaa, ...SYNC, ...PAYLOAD];

const bitsOf = (bytes) => bytes.flatMap((v) => Array.from({ length: 8 }, (_, k) => (v >> (7 - k)) & 1));

/** On or off at time `t` (s): packets every 0.45 s from 0.1 s, silence between. */
function keyed(t, baud, manchester) {
  const bits = bitsOf(PACKET);
  const at = (t - 0.1) % 0.45;
  if (t < 0.1 || at < 0) return 0;
  const sym = Math.floor(at * baud);
  if (sym >= bits.length) return 0;
  if (!manchester) return bits[sym];
  // IEEE 802.3: a 1 is low then high.
  const second = (at * baud - sym) >= 0.5;
  return bits[sym] ? (second ? 1 : 0) : (second ? 0 : 1);
}

function file() {
  const n = FS * SECONDS, buf = Buffer.alloc(n * 8);
  let seed = 9;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32 - 0.5) * 0.01;
  for (let i = 0; i < n; i++) {
    const t = i / FS;
    const a = keyed(t, NRZ_BAUD, false) * 0.1, b = keyed(t, MAN_BAUD, true) * 0.1;
    const pa = (2 * Math.PI * NRZ_HZ * i) / FS, pb = (2 * Math.PI * MAN_HZ * i) / FS;
    buf.writeFloatLE(a * Math.cos(pa) + b * Math.cos(pb) + rnd(), i * 8);
    buf.writeFloatLE(a * Math.sin(pa) + b * Math.sin(pb) + rnd(), i * 8 + 4);
  }
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'grslicer-')), 'ook.cf32');
  fs.writeFileSync(f, buf);
  return f;
}

/** The same chain in both engines: a channel, the AM envelope, the slicer, and what follows. */
async function engines(t, at, ops) {
  const f = file();
  const open = () => new FileCapture({ path: f, format: 'cf32', sampleRate: FS, centerHz: CENTER, label: 'ook' });
  const w = new GrWorker();
  t.after(() => { w.stop(); fs.rmSync(path.dirname(f), { recursive: true, force: true }); });
  const out = {};
  for (const [name, e] of [['js', new MockEngine({ latency: false })], ['gr', new GrEngine({ latency: false }, w)]]) {
    await e.createSession(); await e.openCapture(open());
    const tu = await e.addNode({ parent: e.root.id, op: 'core.tuner', selection: { f0: CENTER + at - 10_000, f1: CENTER + at + 10_000 }, at: 1 });
    let parent = await e.addNode({ parent: tu.id, op: 'core.am_envelope', at: 1 });
    const nodes = [];
    for (const [op, set] of ops) {
      parent = await e.addNode({ parent: parent.id, op, at: 1 });
      for (const [k, v] of Object.entries(set)) await e.setParam(parent.id, k, v, 'manual');
      nodes.push(e.node(parent.id));
    }
    out[name] = { e, nodes };
  }
  return out;
}

/** Every payload after a sync word, in order. */
function payloads(bytes) {
  const found = [];
  for (let i = 0; i + PAYLOAD.length <= bytes.length; i++) {
    if (PAYLOAD.every((v, k) => bytes[i + k] === v)) found.push(i);
  }
  return found;
}

test('NRZ: GNU Radio makes the decisions, and they are the JS slicer\'s', { skip }, async (t) => {
  const { js, gr } = await engines(t, NRZ_HZ, [['core.nrz_slicer', { syncHex: '2dd4', symbolUs: 1e6 / NRZ_BAUD }], ['core.differential', {}]]);
  // Timed against warm workers, as a running server's are: a cold one is ~200 ms of Python
  // and GNU Radio starting, paid once per session and not per slice.
  if (process.env.SLICETIME) {
    const w0 = performance.now();
    await gr.e.gr.request({ op: 'ping' });
    t.diagnostic(`worker start ${(performance.now() - w0).toFixed(0)} ms`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  let t0 = performance.now();
  const a = await gr.e.sliceBytes(gr.nodes[0].id);
  const msGr = performance.now() - t0;
  if (process.env.SLICETIME) t.diagnostic(`grStats ${JSON.stringify(gr.e.grStats)}`);
  t0 = performance.now();
  const b = await js.e.sliceBytes(js.nodes[0].id);
  const msJs = performance.now() - t0;
  t.diagnostic(`slicing the capture: GNU Radio engine ${msGr.toFixed(0)} ms, JS engine ${msJs.toFixed(0)} ms`);
  if (process.env.SLICETIME) {
    for (const e of [gr.e, js.e]) {
      const n = e.node((e === gr.e ? gr : js).nodes[0].id);
      for (const v of [0.031, 0.032]) {
        n.params.threshold = { ...n.params.threshold, value: v, mode: 'manual' };
        const t1 = performance.now(); await e.sliceBytes(n.id);
        t.diagnostic(`${e === gr.e ? 'gr' : 'js'} again: ${(performance.now() - t1).toFixed(0)} ms`);
      }
    }
  }
  assert.equal(a.engine, 'gnuradio', 'decided by recipes/nrz.grc');
  assert.ok(gr.e.grStats.grid > 0.9 * a.bits, `GNU Radio made ${gr.e.grStats.grid} of ${a.bits} decisions`);
  t.diagnostic(`symbol ${a.sps.toFixed(2)} samples, phase ${a.phase.toFixed(2)}; ${a.bits} decisions, ${gr.e.grStats.grid} by GNU Radio`);
  assert.equal(a.syncAt, b.syncAt);
  assert.deepEqual(Array.from(a.bytes), Array.from(b.bytes), 'the same bytes from both engines');
  assert.equal(payloads(a.bytes)[0], 0, 'the payload follows the sync word');

  const da = await gr.e.sliceBytes(gr.nodes[1].id), db = await js.e.sliceBytes(js.nodes[1].id);
  assert.equal(da.engine, 'gnuradio', 'decoded by recipes/differential.grc');
  assert.deepEqual(Array.from(da.bytes), Array.from(db.bytes));
});

test('Manchester: GNU Radio makes the half-symbol decisions; the pairs and violations agree', { skip }, async (t) => {
  const { js, gr } = await engines(t, MAN_HZ, [['core.manchester', { syncHex: '2dd4' }]]);
  const a = await gr.e.sliceBytes(gr.nodes[0].id), b = await js.e.sliceBytes(js.nodes[0].id);
  assert.equal(a.engine, 'gnuradio', 'decided by recipes/manchester.grc');
  t.diagnostic(`symbol ${a.sps.toFixed(2)} samples; ${a.symbols} symbols, ${a.violations} without a transition (JS ${b.violations})`);
  assert.ok(gr.e.grStats.grid > 0.9 * 2 * a.symbols);
  assert.equal(a.symbols, b.symbols);
  assert.ok(Math.abs(a.violations - b.violations) <= 2, `violations ${a.violations} against ${b.violations}`);
  assert.equal(a.syncAt, b.syncAt);
  assert.equal(payloads(a.bytes)[0], 0, 'the payload follows the sync word');
  assert.deepEqual(payloads(a.bytes), payloads(b.bytes), 'every packet found by both');
});

test('differential decoding: GNU Radio\'s diff_decoder_bb is NRZ-M and NRZ-S as dsp.js has them', { skip }, async (t) => {
  const w = new GrWorker();
  t.after(() => w.stop());
  const e = new GrEngine({ latency: false }, w);
  const bytes = Uint8Array.from([0xc5, 0x3a, 0x00, 0xff, 0x96]);
  for (const mode of ['nrz-m', 'nrz-s']) {
    const got = await e._bitsThrough('differential', { mode }, dsp.unpackBits(bytes, true));
    assert.deepEqual(Array.from(dsp.packBits(Array.from(got)).bytes),
                     Array.from(dsp.differentialDecode(bytes, mode).bytes), mode);
  }
});

test('symbol sync: GNU Radio\'s matched filter and resampler on the fitted grid give the JS soft symbols', { skip }, async (t) => {
  // 4FSK at 4800 symbols a second, FM at 2.4 kHz deviation, from 0.2 s to 1.8 s.
  const RATE = 96_000, BAUD = 4800, DEV = 2400, n = RATE * 2;
  const buf = Buffer.alloc(n * 8);
  let seed = 3, ph = 0, sym = 0;
  const pick = () => [-3, -1, 1, 3][((seed = (seed * 1103515245 + 12345) >>> 0) >>> 30)];
  for (let i = 0; i < n; i++) {
    const tt = i / RATE;
    if (i % (RATE / BAUD) === 0) sym = tt > 0.2 && tt < 1.8 ? pick() : 0;
    ph += (2 * Math.PI * DEV * (sym / 3)) / RATE;
    buf.writeFloatLE(0.3 * Math.cos(ph), i * 8);
    buf.writeFloatLE(0.3 * Math.sin(ph), i * 8 + 4);
  }
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'grsym-')), 'fsk.cf32');
  fs.writeFileSync(f, buf);
  const w = new GrWorker();
  t.after(() => { w.stop(); fs.rmSync(path.dirname(f), { recursive: true, force: true }); });
  const got = {};
  for (const [name, e] of [['js', new MockEngine({ latency: false })], ['gr', new GrEngine({ latency: false }, w)]]) {
    await e.createSession();
    await e.openCapture(new FileCapture({ path: f, format: 'cf32', sampleRate: RATE, centerHz: 0, label: 'fsk' }));
    const tu = await e.addNode({ parent: e.root.id, op: 'core.tuner', selection: { f0: -12_000, f1: 12_000 }, at: 1 });
    const fm = await e.addNode({ parent: tu.id, op: 'core.fm_discriminator', at: 1 });
    const s = e.node((await e.addNode({ parent: fm.id, op: 'core.symbols', at: 1 })).id);
    got[name] = { e, s };
  }
  const { js, gr } = got;
  assert.equal(gr.e._grKind(gr.s), 'symbols', 'computed by recipes/symbols.grc');
  const count = BAUD, at = 1.5;
  gr.e.grStats.misses = 0;
  await gr.e.prepare(gr.s.id, at, count / BAUD);
  const a = gr.e._detectRaw(gr.s, at, count), b = js.e._detectRaw(js.s, at, count);
  assert.equal(gr.e.grStats.misses, 0, 'read entirely from GNU Radio blocks');
  let worst = 0, flips = 0;
  const level = (v) => Math.max(-3, Math.min(3, 2 * Math.round((v - 1) / 2) + 1));
  for (let i = 0; i < count; i++) {
    worst = Math.max(worst, Math.abs(a[i] - b[i]));
    if (level(a[i]) !== level(b[i])) flips++;
  }
  t.diagnostic(`sps ${(gr.e.node(gr.s.parent).out.sampleRate / BAUD).toFixed(2)}, eye ${gr.s.params.phase.auto.from.match(/eye ([\d.]+)/)[1]}; ` +
               `largest difference ${worst.toFixed(4)} on levels at ±1, ±3; ${flips} of ${count} symbols decided differently`);
  assert.equal(flips, 0, 'every symbol on the same level');
  // Not closer than this, and not meant to be: dsp.js interpolates linearly between samples,
  // which shaves a peak by a few percent at under seven samples a symbol, and GNU Radio's
  // resampler is an 8-tap MMSE interpolator, which does not. Its levels sit nearer ±3.
  assert.ok(worst < 0.1, `differs by ${worst}`);
});
