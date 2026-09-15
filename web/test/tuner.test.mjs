// How long the channel filter has to be, and what happens when it is too short.
//
// The tuner's tap count said `auto` and "transition width" and was the constant 65. That
// is fine for a wide channel and nowhere near enough for a narrow one, and the way it
// fails is the worst kind: the symbol rate still derives correctly, the pane fills with
// bytes, and the bytes are partly the neighbouring channel's.
//
// So the derivation is measured rather than estimated — evaluate the filter at every
// frequency that folds into the passband and take the worst — and these tests pin both
// the measurement and the end-to-end consequence.
//
//   node --test web/test/tuner.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { MockEngine } from '../src/engine.js';
import { Capture } from '../src/capture.js';
import * as dsp from '../src/dsp.js';
import * as mod from './support/modulate.mjs';

const RATE = 200_000, CENTER = 433_920_000, SPACING = 4_000;
const TEXTS = ['01:ALFA', '02:BRVO', '03:CHAR', '04:DELT', '05:ECHO', '06:FOXT'];

const ascii = (b) => Buffer.from(b).toString('latin1');

function comb(opts = {}) {
  return mod.multitone(TEXTS, { rate: RATE, spacingHz: SPACING, baud: 200, ...opts });
}

async function opened(g) {
  const buf = Buffer.allocUnsafe(g.samples * 2);
  for (let i = 0; i < g.samples * 2; i++) {
    buf[i] = Math.max(0, Math.min(255, Math.round(g.iq[i] * 127.5 + 127.5)));
  }
  const e = new MockEngine({ latency: false });
  await e.createSession();
  await e.openCapture(new Capture({
    buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    format: 'cu8', sampleRate: RATE, centerHz: CENTER, label: 'comb',
  }));
  return e;
}

/** Tune one carrier and read it, optionally forcing a tap count. */
async function readCarrier(e, g, k, { width = SPACING / 2, taps = null } = {}) {
  const f = CENTER + g.plan[k].offsetHz;
  const tu = await e.addNode({ parent: e.root.id, op: 'core.tuner',
    selection: { f0: f - width / 2, f1: f + width / 2 }, at: 0.1 });
  if (taps != null) await e.setParam(tu.id, 'taps', taps);
  const am = await e.addNode({ parent: tu.id, op: 'core.am_envelope', at: 0.1 });
  const sl = await e.addNode({ parent: am.id, op: 'core.nrz_slicer', at: 0.1 });
  await e.setParam(sl.id, 'syncHex', '2d d4');
  const out = await e.sliceBytes(sl.id, null, e.duration());
  return { tuner: e.node(tu.id), text: ascii(out.bytes).slice(0, TEXTS[0].length) };
}

// ── the measurement ─────────────────────────────────────────────────────────

test('alias rejection is measured at the frequencies that actually fold', () => {
  const cutoff = 1_000, decim = 80;
  const short = dsp.aliasRejectionDb(dsp.lowPassTaps(65, cutoff, RATE), RATE, cutoff, decim);
  const long = dsp.aliasRejectionDb(dsp.lowPassTaps(255, cutoff, RATE), RATE, cutoff, decim);
  assert.ok(long < short - 6, `255 taps (${long.toFixed(1)} dB) should beat 65 (${short.toFixed(1)} dB)`);
  assert.ok(short < 0 && short > -30, `65 taps at 80:1 is poor, not catastrophic: ${short.toFixed(1)} dB`);
});

test('nothing folds when nothing is decimated', () => {
  assert.equal(dsp.aliasRejectionDb(dsp.lowPassTaps(65, 50_000, RATE), RATE, 50_000, 1), -Infinity);
  const r = dsp.chooseTaps(RATE, 100_000, 1);
  assert.equal(r.taps, 65, 'the shortest filter, because there is nothing to reject');
  assert.equal(r.met, true);
});

test('a narrower channel gets a longer filter', () => {
  const wide = dsp.chooseTaps(RATE, 50_000, dsp.chooseDecimation(RATE, 50_000 * 1.25));
  const mid = dsp.chooseTaps(RATE, 8_000, dsp.chooseDecimation(RATE, 8_000 * 1.25));
  const narrow = dsp.chooseTaps(RATE, 2_000, dsp.chooseDecimation(RATE, 2_000 * 1.25));
  assert.ok(wide.taps < mid.taps, `${wide.taps} then ${mid.taps}`);
  assert.ok(mid.taps <= narrow.taps, `${mid.taps} then ${narrow.taps}`);
  assert.ok(wide.taps >= 65, 'never shorter than what it used to always be');
  assert.ok(narrow.taps <= 255, 'and never longer than the manual control allows');
});

test('a target it cannot reach is reported, not pretended', () => {
  // A single-stage FIR decimating by eighty has a transition band a thousandth of the
  // input rate wide. No affordable tap count brick-walls that, and saying so is the
  // useful answer — the fix is a wider selection, not a longer filter.
  const r = dsp.chooseTaps(RATE, 2_000, dsp.chooseDecimation(RATE, 2_500));
  assert.equal(r.met, false);
  assert.equal(r.taps, 255, 'having failed, it spends the whole budget');
  assert.ok(r.rejectionDb > -60 && r.rejectionDb < 0, `${r.rejectionDb.toFixed(1)} dB achieved`);
});

// ── what it costs when it is wrong ──────────────────────────────────────────

test('six carriers 4 kHz apart all read, on the derived tap count', async () => {
  const g = comb();
  const e = await opened(g);
  for (let k = 0; k < TEXTS.length; k++) {
    const { text } = await readCarrier(e, g, k);
    assert.equal(text, TEXTS[k], `carrier ${k + 1}`);
  }
});

test('and the short filter this used to use loses some of them', async () => {
  // The control. Without it, the test above proves only that a comb decodes — not that
  // the tap count is what makes it decode.
  const g = comb();
  const e = await opened(g);
  let right = 0;
  for (let k = 0; k < TEXTS.length; k++) {
    const { text } = await readCarrier(e, g, k, { taps: 65 });
    if (text === TEXTS[k]) right++;
  }
  assert.ok(right < TEXTS.length, `65 taps read ${right} of ${TEXTS.length} — it should not read them all`);
});

test('the tuner says how much leaks in, and admits when it is a lot', async () => {
  const g = comb();
  const e = await opened(g);
  const narrow = await readCarrier(e, g, 2, { width: 2_000 });
  const t = narrow.tuner.params.taps;
  assert.equal(t.mode, 'auto');
  assert.match(t.auto.from, /folds in/);
  // This channel is narrow enough that the target cannot be met, so the evidence has to
  // say so rather than badge an inadequate filter as confident.
  assert.equal(t.auto.confident, false);
  assert.match(t.auto.from, /a wider selection is the fix/i);

  // A wide one on the same source reaches the target and says so plainly.
  const f = CENTER + 20_000;
  const wide = await e.addNode({ parent: e.root.id, op: 'core.tuner',
    selection: { f0: f - 25_000, f1: f + 25_000 }, at: 0.1 });
  const wt = e.node(wide.id).params.taps;
  assert.equal(wt.auto.confident, true);
  assert.match(wt.auto.from, /\d+ dB down/);
});

test('a pinned tap count is still a pinned tap count', async () => {
  const g = comb();
  const e = await opened(g);
  const f = CENTER + g.plan[2].offsetHz;
  const tu = await e.addNode({ parent: e.root.id, op: 'core.tuner',
    selection: { f0: f - 1_000, f1: f + 1_000 }, at: 0.1 });
  assert.equal(e.node(tu.id).params.taps.mode, 'auto');

  await e.setParam(tu.id, 'taps', 97);
  assert.equal(e.node(tu.id).params.taps.value, 97);
  assert.equal(e.node(tu.id).params.taps.mode, 'manual');

  // And moving something else does not quietly re-derive it back. Deriving a parameter
  // is a default, not a policy — the whole point of `manual` is that it stays put.
  await e.setParam(tu.id, 'centerHz', f + 200);
  assert.equal(e.node(tu.id).params.taps.value, 97);
  assert.equal(e.node(tu.id).params.taps.mode, 'manual');
});
