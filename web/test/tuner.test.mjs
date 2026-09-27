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

// ── what the display ranges to ──────────────────────────────────────────────

test('a frame with nothing in it is not a measurement', () => {
  // A channel that has not produced samples answers with zeros. That is a valid
  // spectrum of silence at about -200 dBFS, and ranging a display to it puts the floor
  // somewhere no signal reaches — after which the auto-range spends seventeen seconds
  // climbing back. The symptom reads as a slow filter and is one empty frame.
  const empty = new Float32Array(1024).fill(-200);
  assert.equal(dsp.spectrumHasSignal(empty), false);
  assert.equal(dsp.spectrumHasSignal(new Float32Array(1024)), false, 'flat at zero is still flat');
  assert.equal(dsp.spectrumHasSignal(new Float32Array(0)), false);
  assert.equal(dsp.spectrumHasSignal(null), false);
});

test('noise is a measurement, and reads as one', () => {
  // The distinction has to survive the quietest thing that is still real, or the
  // display refuses to range on an empty band.
  const rand = mod.rng(0x515e);
  const noise = Float32Array.from({ length: 1024 }, () => -110 + (rand() - 0.5) * 12);
  assert.equal(dsp.spectrumHasSignal(noise), true);

  const g = comb();
  const spec = dsp.spectrum(g.iq.subarray(0, 2048), 1024, 'Hann');
  assert.equal(dsp.spectrumHasSignal(spec), true);
});

test('a strong flat signal is still not a spectrum', () => {
  // Guard against the obvious wrong fix, which is to test the level rather than the
  // spread. Every bin at -20 dBFS is not a loud signal, it is a broken one.
  assert.equal(dsp.spectrumHasSignal(new Float32Array(1024).fill(-20)), false);
});

// ── the output grid belongs to the capture, not to the read ─────────────────

test('the same instant reads the same samples whatever window asked for it', async () => {
  // `xlateFilterDecimate` takes every `decim`-th sample counting from the start of what
  // it is handed, so where that starts decides *which* input samples become output
  // samples. It used to start at `Math.floor(tEnd * parentRate) - need`, whose remainder
  // modulo `decim` moves with `tEnd` — so a read whose end lands between two output
  // samples came back on a different grid, a shift of up to `(decim - 1) / decim` of an
  // output sample.
  //
  // The moves below are all *within* one output sample, so `Math.floor(tEnd * ownRate)`
  // does not change: every one of these reads is a request for exactly the same output
  // samples and must return exactly the same numbers. Ending a read at a moment that is
  // not on the output grid is the ordinary case — `_readSymbols` positions its reads by
  // absolute *parent* sample, which is where this was found.
  //
  // Harmless until something cares about a fraction of a sample. Measured on the GRCon26
  // M17 slot, where a 9 kHz selection decimates by 42 into 2.48 samples per symbol: the
  // symbols a symbol sync node handed over came back a fifth of full scale away from the
  // ones a direct fit produced from the same seconds, and the decoder read 0 records
  // against 10. At a 24 kHz selection — decim 16, 6.5 samples a symbol — the worst case
  // is 0.14 of a symbol and the two paths agreed to the bit, which is why this went
  // unnoticed for as long as it did.
  const g = comb();
  const e = await opened(g);
  const f = CENTER + g.plan[2].offsetHz;
  const tu = await e.addNode({ parent: e.root.id, op: 'core.tuner',
    selection: { f0: f - SPACING / 4, f1: f + SPACING / 4 }, at: 0.1 });
  const decim = tu.params.decim.value;
  assert.ok(decim > 1, 'this is only a question when something is decimated');

  const count = 600;
  // An end that sits exactly on an output sample, then nudged along inside that sample.
  const k = Math.floor(0.2 * tu.out.sampleRate);
  const base = e._readIQ(e.node(tu.id), k / tu.out.sampleRate, count);
  for (let j = 1; j < decim; j++) {
    const at = (k * decim + j) / RATE;              // j parent samples past the boundary
    assert.equal(Math.floor(at * tu.out.sampleRate), k, 'the nudge left the output sample');
    const got = e._readIQ(e.node(tu.id), at, count);
    for (let i = 0; i < count * 2; i++) {
      assert.ok(Math.abs(base[i] - got[i]) < 1e-6,
                `ending ${j}/${decim} of an output sample later moved sample ${i >> 1}: ` +
                `${base[i]} against ${got[i]}`);
    }
  }
});

test('a longer read of the same instant is the same signal', async () => {
  // The other half of the same property: the count must not move the grid either.
  const g = comb();
  const e = await opened(g);
  const f = CENTER + g.plan[1].offsetHz;
  const tu = await e.addNode({ parent: e.root.id, op: 'core.tuner',
    selection: { f0: f - SPACING / 4, f1: f + SPACING / 4 }, at: 0.1 });
  const at = 0.25, count = 400;
  const short = e._readIQ(e.node(tu.id), at, count);
  const long = e._readIQ(e.node(tu.id), at, count * 3);
  const skip = (count * 3 - count) * 2;       // both end at `at`, so align on the end
  for (let i = 0; i < count * 2; i++) {
    assert.ok(Math.abs(short[i] - long[skip + i]) < 1e-6,
              `a ${count * 3}-sample read disagrees with a ${count}-sample one at ${i >> 1}`);
  }
});
