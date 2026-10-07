// A radio's ring, read by GNU Radio (ADR-0044, migration step 4; ADR-0030).
//
//   node --test web/test/grring.test.mjs
//
// Skipped where GNU Radio is not installed. A radio's recording is a file that wraps: sample i
// lives at slot i % ring. A block that straddles the wrap has to come out exactly as the JS
// engine reads it, and a block not yet written must not be fetched until it is.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MockEngine } from '../src/engine.js';
import { GrEngine } from '../../server/gr/engine.js';
import { GrWorker } from '../../server/gr/worker.js';
import { Ring } from '../../server/ring.js';

const python = process.env.SDRFLEX_GR_PYTHON || 'python3';
const hasGr = spawnSync(python, ['-c', 'import gnuradio.gr'], { stdio: 'ignore' }).status === 0;
const skip = !hasGr && 'GNU Radio is not installed';

const FS = 500_000, CENTER = 100_000_000, TONE = 30_000;

/** Write `seconds` more of the tone into the ring, continuing its phase. */
function feed(ring, seconds) {
  const n = Math.round(FS * seconds), buf = Buffer.alloc(n * 8);
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * TONE * (ring.head + i)) / FS;
    buf.writeFloatLE(0.5 * Math.cos(a), i * 8);
    buf.writeFloatLE(0.5 * Math.sin(a), i * 8 + 4);
  }
  ring.write(buf);
}

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grring-'));
  const ring = new Ring({ path: path.join(dir, 'ring.cf32'), format: 'cf32', sampleRate: FS, centerHz: CENTER, seconds: 1 });
  feed(ring, 2.6);                       // a 1 s ring holding 2.6 s: it has wrapped twice
  const w = new GrWorker();
  t.after(() => { w.stop(); ring.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const out = {};
  for (const [name, e] of [['gr', new GrEngine({ latency: false }, w)], ['js', new MockEngine({ latency: false })]]) {
    await e.createSession(); await e.openCapture(ring);
    const tu = await e.addNode({ parent: e.root.id, op: 'core.tuner', selection: { f0: CENTER + 15_000, f1: CENTER + 35_000 }, at: 2.2 });
    out[name] = { e, tu: e.node(tu.id) };
  }
  return { ring, ...out };
}

test('a block across the ring\'s wrap is what the JS engine reads there', { skip }, async (t) => {
  const { ring, gr, js } = await setup(t);
  // Absolute 2.0 s is slot 0: the ring wrapped there. Read 0.3 s across it.
  const fs = gr.tu.out.sampleRate, count = Math.round(fs * 0.3), at = 2.15;
  assert.ok(at - count / fs < 2.0 && at > 2.0, 'the read straddles the wrap');
  await gr.e.prepare(gr.tu.id, at, count / fs);
  const before = gr.e.grStats.misses;
  const a = gr.e._readIQ(gr.tu, at, count), b = js.e._readIQ(js.tu, at, count);
  assert.equal(gr.e.grStats.misses - before, 0, 'served from GNU Radio blocks');
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  t.diagnostic(`largest difference ${worst.toExponential(2)} on a 0.5 signal; ring head at ${(ring.head / FS).toFixed(2)} s`);
  assert.ok(worst < 1e-3, `differs by ${worst}`);
});

test('a block not yet written is not fetched, and is once it is', { skip }, async (t) => {
  const { ring, gr } = await setup(t);
  const fs = gr.tu.out.sampleRate, B = Math.round(0.25 * fs);
  const edge = Math.floor((2.6 * fs) / B);            // the block the head is inside
  await gr.e.prepare(gr.tu.id, 2.6, 0.1);
  assert.ok(!gr.tu._grBlocks.has(edge), 'the block still being written was not fetched');
  feed(ring, 0.5);
  await gr.e.prepare(gr.tu.id, 2.9, 0.4);
  const blk = gr.tu._grBlocks.get(edge);
  assert.ok(blk && blk.length === B * 2, 'and once written, it was');
});

test('scrubbing back reads exactly what played live', { skip }, async (t) => {
  const { ring, gr } = await setup(t);
  const fs = gr.tu.out.sampleRate, count = Math.round(fs * 0.2), at = 2.6 - 0.3;   // the live view, 0.3 s back
  await gr.e.prepare(gr.tu.id, at, count / fs);
  const played = gr.e._readIQ(gr.tu, at, count);
  feed(ring, 0.6);                                                                  // the radio carries on
  await gr.e.prepare(gr.tu.id, at, count / fs);                                     // and later, someone scrubs back
  const scrubbed = gr.e._readIQ(gr.tu, at, count);
  assert.deepEqual(Array.from(scrubbed), Array.from(played));
});
