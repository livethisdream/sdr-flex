// Frequency hopping: where it went, and what it said.
//
// Two answers out of one capability, which is the reason to build it this way. A hop map
// that only reported the sequence would leave the payload on the table; a de-hopper that
// needed to be told the sequence would be a de-hopper for somebody who already had the
// answer. The dwells are found once and both questions are answered from them.
//
// The control matters as much as the result. A de-hopper that "worked" on a capture whose
// payload restarts on every dwell would be indistinguishable from one that did nothing, so
// the fixture's payload runs continuously across the hops and this checks that the same
// chain without de-hopping first recovers nothing at all.
//
//   node --test web/test/fhss.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockEngine } from '../src/engine.js';
import { Capture } from '../src/capture.js';
import * as dsp from '../src/dsp.js';
import * as mod from './support/modulate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RATE = 200_000, CENTER = 433_920_000;
const TEXT = 'HOPPING PAYLOAD 12345';

/** The same signal the fixture holds, built here so the DSP tests need no file. */
function signal(opts = {}) {
  const bytes = [0xaa, 0xaa, 0xaa, 0x2d, 0xd4, ...[...TEXT].map((c) => c.charCodeAt(0))];
  const bits = [];
  for (const b of bytes) for (let k = 7; k >= 0; k--) bits.push((b >> k) & 1);
  return { bytes, ...mod.fhss(bits, { rate: RATE, channels: 6, spacingHz: 25_000,
                                      dwellSymbols: 16, baud: 2400, deviationHz: 2400,
                                      seed: 0x71c5, ...opts }) };
}

function capture() {
  const data = fs.readFileSync(path.join(HERE, '..', '..', 'fixtures', 'fhss-6ch', 'capture.sigmf-data'));
  return new Capture({ buffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
                       format: 'cu8', sampleRate: RATE, centerHz: CENTER, label: 'fhss' });
}

async function opened() {
  const e = new MockEngine({ latency: false });
  await e.createSession();
  await e.openCapture(capture());
  return e;
}

// ── finding the dwells ──────────────────────────────────────────────────────

test('the hop sequence comes back exactly', () => {
  const g = signal();
  const r = dsp.findHops(g.iq, g.iq.length / 2, RATE);
  assert.equal(r.hops.length, g.hops.length, `${r.hops.length} dwells, ${g.hops.length} transmitted`);
  assert.deepEqual(r.hops.map((h) => h.channel), g.hops);
  assert.equal(r.confident, true);
});

test('the dwell and the spacing are measured, not assumed', () => {
  const g = signal();
  const r = dsp.findHops(g.iq, g.iq.length / 2, RATE);
  assert.ok(Math.abs(r.dwellS - g.dwellS) < g.dwellS * 0.05,
            `dwell ${(r.dwellS * 1e3).toFixed(2)} ms against ${(g.dwellS * 1e3).toFixed(2)}`);
  assert.ok(Math.abs(r.spacingHz - 25_000) < 25_000 * 0.05,
            `spacing ${r.spacingHz.toFixed(0)} Hz`);
  // Five, not six: this sequence never visits the sixth channel, and reporting six would
  // be reporting something that is not in the capture.
  assert.equal(r.channels.length, new Set(g.hops).size);
});

test('a dwell is not broken up by its own modulation', () => {
  // The first version grouped time steps by "the peak has not moved much", which looks
  // obvious and is wrong: the modulation inside a channel moves the peak too. An FSK
  // payload with a 2.4 kHz shift split every dwell at each bit transition and turned 24
  // dwells into 65. Clustering the channels first is what fixes it, so a wider shift
  // should still come back as one dwell each.
  const g = signal({ deviationHz: 6000 });
  const r = dsp.findHops(g.iq, g.iq.length / 2, RATE);
  assert.equal(r.hops.length, g.hops.length, `${r.hops.length} dwells for ${g.hops.length}`);
});

test('two dwells in a row on the same channel are still two dwells', () => {
  // A hop sequence repeats a channel sooner or later, and back to back those dwells are
  // one unbroken stretch of the same frequency — nothing in the signal separates them
  // until the dwell time is known.
  const g = signal();
  const repeats = g.hops.filter((c, i) => i > 0 && c === g.hops[i - 1]).length;
  assert.ok(repeats > 0, 'the fixture sequence does repeat a channel');
  const r = dsp.findHops(g.iq, g.iq.length / 2, RATE);
  assert.equal(r.hops.length, g.hops.length);
});

test('noise is not a hopper, and says so', () => {
  const rand = mod.rng(0x4242);
  const noise = new Float32Array(200_000 * 2);
  for (let i = 0; i < noise.length; i++) noise[i] = (rand() - 0.5) * 0.5;
  const r = dsp.findHops(noise, 200_000, RATE);
  assert.equal(r.confident, false);
});

// ── the node ────────────────────────────────────────────────────────────────

test('the hop map leads with the sequence and derives its own parameters', async () => {
  const e = await opened();
  const n = await e.addNode({ parent: e.root.id, op: 'core.hopmap', at: 0.05 });
  const out = await e.runRecords(n.id, 0.05);
  assert.equal(out.error, undefined, out.error);
  assert.match(out.records[0].text, /^sequence: 1 3 1 3 3 4 2 4 4 1 0 0 2 1$/);
  assert.equal(out.records.length, 15, 'the sequence, then one row per dwell');
  assert.match(out.records[1].text, /^ch \d · 433\.\d+ MHz$/);

  const live = e.node(n.id);
  assert.ok(Math.abs(live.params.dwellMs.value - 6.67) < 0.4, `${live.params.dwellMs.value} ms`);
  assert.equal(live.params.dwellMs.auto.confident, true);
  assert.match(live.params.dwellMs.auto.from, /median of 14 dwells/);
  assert.ok(Math.abs(live.params.spacingHz.value - 25_000) < 1200);
});

// ── and following it ────────────────────────────────────────────────────────

async function payloadThrough(parentOp) {
  const e = await opened();
  let parent = e.root.id;
  if (parentOp) parent = (await e.addNode({ parent, op: parentOp, at: 0.05 })).id;
  const fm = await e.addNode({ parent, op: 'core.fm_discriminator', at: 0.05 });
  const sl = await e.addNode({ parent: fm.id, op: 'core.nrz_slicer', at: 0.05 });
  const out = await e.sliceBytes(sl.id, null, e.duration());
  return { e, sl, text: out ? Buffer.from(out.bytes).toString('latin1') : '', bytes: out && out.bytes };
}

test('de-hopping recovers the payload the hops carried', async () => {
  const { text, sl, e } = await payloadThrough('core.dehop');
  assert.ok(text.includes(TEXT), `expected ${JSON.stringify(TEXT)} in ${JSON.stringify(text.slice(0, 60))}`);
  // and the preamble and sync word ahead of it, which is the whole packet
  const hex = Buffer.from(e.node(sl.id)._sliced.bytes).toString('hex');
  assert.match(hex, /^aaaaaa2dd4/);
});

test('without de-hopping, the same chain gets nothing — which is the point', async () => {
  const { text } = await payloadThrough(null);
  assert.ok(!text.includes(TEXT),
            'if the payload comes out without de-hopping, the fixture is not testing de-hopping');
  assert.ok(!text.includes('HOPPING'), 'not even the start of it');
});

test('de-hop corrects rather than rearranges, so the time base survives', async () => {
  const e = await opened();
  const n = await e.addNode({ parent: e.root.id, op: 'core.dehop', at: 0.05 });
  const st = await e.sliceDehop(n.id, 0.05);
  assert.equal(st.count, Math.floor(e.duration() * RATE), 'same length as the span it came from');
  assert.equal(n.out.sampleRate, RATE, 'and the same rate');
  // Cutting the dwells out and stitching them looks obvious and loses a fraction of a
  // symbol per hop, which walks the symbol clock and decodes to nothing.
  assert.ok(st.keptS / st.spanS > 0.95, `${(100 * st.keptS / st.spanS).toFixed(1)}% of the span corrected`);
});

test('one channel at a time, for a hopper you only want part of', async () => {
  const e = await opened();
  const n = await e.addNode({ parent: e.root.id, op: 'core.dehop', at: 0.05 });
  await e.setParam(n.id, 'channel', 1, 'manual');
  const st = e.node(n.id)._dehopped;
  assert.equal(st.hops, 4, 'channel 1 is used four times in 1 3 1 3 3 4 2 4 4 1 0 0 2 1');
  assert.ok(st.keptS < st.spanS * 0.3, 'and the rest of the span is left alone');
});
