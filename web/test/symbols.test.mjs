// Symbol sync: the node a decoder that reads symbols has to sit behind.
//
//   node --test web/test/symbols.test.mjs
//
// `m17-packet-decode` does not read samples. It reads one float per symbol, already on
// the symbol grid, because it correlates for a syncword rather than recovering a clock —
// so something has to decide where in each symbol period to look, and that decision is
// the difference between a decode and nothing at all. Putting it inside the adapter would
// hide the two numbers that matter; `core.symbols` is those numbers on a node with their
// evidence beside them (ADR-0017).
//
// The end-to-end proof is `fixtures/m17-packet`, which runs M17's own modulator against
// M17's own decoder. What is here is everything that can be checked without either
// program installed: that the filter is the one M17 specifies, that the fit finds the
// burst rather than the silence around it, and — the property that is easy to get wrong
// and impossible to see — that two overlapping reads agree about which sample was a
// symbol.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as dsp from '../src/dsp.js';
import { MockEngine } from '../src/engine.js';
import { Capture } from '../src/capture.js';

const RATE = 96_000, CENTER = 144_800_000, SYMBOL_RATE = 4800;

// ── the filter ──────────────────────────────────────────────────────────────

test('the matched filter is the one M17 publishes', () => {
  const t = dsp.rrcTaps(0.5, 8, 10);
  // `libm17/math/rrc.c`, `rrc_taps_10[]`: alpha 0.5, span 8, sps 10, gain sqrt(sps).
  // Five of the eighty-one, which is enough to catch a sign, a scale or an off-by-one
  // and not so many that this becomes a copy of somebody else's table.
  const want = [
    [0, -0.003195702904062073],
    [1, -0.002930279157647190],
    [40, 0.359452932027607974],   // the peak, at the centre
    [41, 0.350895727088112619],
    [80, -0.003195702904062073],  // and symmetric
  ];
  assert.equal(t.length, 81, 'an odd number of taps, so the peak lands on one');
  // 5e-5, and the number is measured rather than chosen: across all 81 taps the largest
  // disagreement is 2.2e-5, and it is at the peak — libm17's centre tap is 0.35945293
  // where the closed form's k = 0 case gives 0.35943073. Every other tap agrees to
  // better than a part in ten thousand. Which of the two is more nearly right does not
  // matter at this size; what matters is that these are the same filter, and a sign
  // error, a scale error or an off-by-one would all be orders of magnitude louder.
  for (const [i, v] of want) {
    assert.ok(Math.abs(t[i] - v) < 5e-5, `tap ${i}: ${t[i]} against ${v}`);
  }
});

test('the filter stays centred when samples per symbol is not a whole number', () => {
  // A tuner picks its decimation from the channel width, so 4800 symbols a second
  // arrives at 32 kS/s about as often as at 48. A filter whose peak fell between two
  // taps would shift every symbol by half a sample, which the phase search would then
  // spend itself correcting.
  for (const sps of [6.6666, 10, 12.5, 7.3]) {
    const t = dsp.rrcTaps(0.5, 8, sps);
    assert.equal(t.length % 2, 1, `sps ${sps}: odd tap count`);
    const mid = (t.length - 1) / 2;
    for (let k = 1; k <= 4; k++) {
      assert.ok(Math.abs(t[mid - k] - t[mid + k]) < 1e-6, `sps ${sps}: symmetric about the peak`);
      assert.ok(t[mid] > t[mid - k], `sps ${sps}: the peak is the peak`);
    }
  }
});

// ── the fit ─────────────────────────────────────────────────────────────────

/** Deterministic noise, so a failure is a failure and not a Tuesday. */
function noise(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return (s / 0x7fffffff) * 2 - 1; };
}

/**
 * A 4FSK-shaped burst: symbols from {-3,-1,1,3}, RRC-shaped, at `sps` samples each.
 *
 * The transmit half of the pair. Its own filter is the one the receiver will match, which
 * is the whole point of a root-raised cosine — either half alone leaves ISI and the two
 * together do not.
 */
function burst(symbols, sps, { lead = 0, tail = 0, scale = 1, dc = 0, seed = 7 } = {}) {
  const taps = dsp.rrcTaps(0.5, 8, sps);
  const n = Math.round(symbols.length * sps);
  const up = new Float32Array(n);
  for (let k = 0; k < symbols.length; k++) {
    const i = Math.round(k * sps);
    if (i < n) up[i] += symbols[k] * sps;          // an impulse train, then shaped
  }
  const shaped = dsp.fir(up, taps);
  const rnd = noise(seed);
  const out = new Float32Array(lead + n + tail);
  for (let i = 0; i < out.length; i++) out[i] = dc + rnd() * 1e-3 * scale;
  for (let i = 0; i < n; i++) out[lead + i] += shaped[i] * scale;
  return out;
}

/** A fixed, balanced run of symbols. Balanced because a DC estimate has to be possible. */
function symbolRun(count, seed = 3) {
  const rnd = noise(seed);
  const levels = [-3, -1, 1, 3];
  return Array.from({ length: count }, () => levels[Math.floor((rnd() + 1) * 2) % 4]);
}

test('the symbols come back out', () => {
  const want = symbolRun(400);
  const x = burst(want, 10);
  const got = dsp.softSymbols(x, x.length, 48_000, 4800);
  assert.ok(got.eye > 0.95, `eye ${got.eye}`);
  // Hard-decided, and lined up against the run by searching for the offset — the fit
  // drops a filter's worth at each end, so "the same symbols" is the claim, not "the
  // same indices".
  const hard = [...got.symbols].map((v) => [-3, -1, 1, 3].reduce((a, b) => (Math.abs(v - b) < Math.abs(v - a) ? b : a)));
  const at = want.join(',').indexOf(hard.slice(0, 40).join(','));
  assert.ok(at >= 0, `the first 40 recovered symbols are not in the run: ${hard.slice(0, 12)}`);
});

test('a level and an offset it has never seen make no difference', () => {
  // What a discriminator hands over is in the capture's units with the tuning error
  // added as DC. Neither is knowable in advance, so both are measured — and measured
  // together, because the outer levels are what says where the middle is.
  const want = symbolRun(400);
  const plain = dsp.softSymbols(burst(want, 10), 4000, 48_000, 4800);
  const odd = burst(want, 10, { scale: 0.031, dc: 0.42 });
  const got = dsp.softSymbols(odd, odd.length, 48_000, 4800);
  assert.ok(got.eye > 0.95, `eye ${got.eye}`);
  // Measured after the matched filter, which passes DC with the gain of its own taps —
  // so the number to expect is the offset times that, not the offset. Both halves apply
  // it on the same side of the filter, so the two agree; the reason to pin it here is
  // that they have to keep agreeing.
  const dcGain = [...dsp.rrcTaps(0.5, 8, 10)].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(got.center - 0.42 * dcGain) < 0.05,
            `center ${got.center}, expected about ${0.42 * dcGain}`);
  assert.ok(Math.abs(got.gain / plain.gain - 1 / 0.031) < 2, `gain ${got.gain} against ${plain.gain}`);
  for (let k = 0; k < 40; k++) {
    assert.ok(Math.abs(got.symbols[k] - plain.symbols[k]) < 0.25,
              `symbol ${k}: ${got.symbols[k]} against ${plain.symbols[k]}`);
  }
});

test('a burst in a span of silence is fitted to the burst', () => {
  // The regression this gate exists for, and it is not hypothetical: a span is chosen by
  // dragging on a spectrum, so it is nearly always wider than the signal in it. Fitted
  // over everything, the outer levels landed on the noise, the sampling instant went with
  // them, and the decoder that had been decoding stopped.
  const want = symbolRun(400);
  const x = burst(want, 10, { lead: 24_000, tail: 24_000 });
  const got = dsp.softSymbols(x, x.length, 48_000, 4800);
  assert.ok(got.eye > 0.9, `eye ${got.eye} — the silence took the fit`);
  const tight = dsp.softSymbols(burst(want, 10), 4000, 48_000, 4800);
  assert.ok(Math.abs(got.gain / tight.gain - 1) < 0.2,
            `gain ${got.gain} against ${tight.gain} with no padding`);
});

test('noise degrades the eye rather than the answer', () => {
  const want = symbolRun(600);
  let last = 1;
  for (const snr of [30, 20, 12]) {
    const x = burst(want, 10);
    const rnd = noise(99);
    const a = Math.pow(10, -snr / 20) * 2;
    for (let i = 0; i < x.length; i++) x[i] += rnd() * a;
    const got = dsp.softSymbols(x, x.length, 48_000, 4800);
    assert.ok(got.eye > 0.7, `${snr} dB: eye ${got.eye}`);
    assert.ok(got.eye <= last + 1e-9, `${snr} dB: the eye should not improve with noise`);
    last = got.eye;
  }
});

test('nothing to fit is reported as nothing rather than as a confident zero', () => {
  const empty = dsp.softSymbols(new Float32Array(0), 0, 48_000, 4800);
  assert.equal(empty.n, 0);
  assert.equal(empty.eye, 0);
  // Below two samples a symbol there is no symbol to find, whatever the arithmetic says.
  const tooFast = dsp.softSymbols(new Float32Array(4096), 4096, 4800, 4800);
  assert.equal(tooFast.n, 0);
});

// ── the node ────────────────────────────────────────────────────────────────

/** A capture of one 4FSK burst, FM-modulated the way the fixture's is. */
async function engine(symbols = symbolRun(400)) {
  const basebandRate = 48_000, deviation = 2400;
  const bb = burst(symbols, basebandRate / SYMBOL_RATE, { lead: 4800, tail: 4800, scale: 1 / 3 });
  const up = Math.round(RATE / basebandRate);
  const n = bb.length * up;
  const buf = Buffer.allocUnsafe(n * 2);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const v = bb[Math.floor(i / up)];
    phase += (2 * Math.PI * deviation * v) / RATE;
    buf[i * 2] = Math.round(Math.cos(phase) * 110 + 127.5);
    buf[i * 2 + 1] = Math.round(Math.sin(phase) * 110 + 127.5);
  }
  const e = new MockEngine({ latency: false });
  await e.createSession();
  await e.openCapture(new Capture({
    buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    format: 'cu8', sampleRate: RATE, centerHz: CENTER, label: 'm17',
  }));
  const t = await e.addNode({ parent: e.root.id, op: 'core.tuner',
    selection: { f0: CENTER - 12_000, f1: CENTER + 12_000 }, at: 0.05 });
  const fm = await e.addNode({ parent: t.id, op: 'core.fm_discriminator', at: 0.05 });
  return { e, fm, symbols };
}

test('a symbol sync comes out at the symbol rate, with its evidence', async () => {
  const { e, fm } = await engine();
  const n = await e.addNode({ parent: fm.id, op: 'core.symbols', at: 0.05 });
  assert.equal(n.out.kind, 'real', 'a soft symbol is a real number and a run of them is a real stream');
  assert.equal(n.out.sampleRate, SYMBOL_RATE);
  for (const key of ['phase', 'center', 'gain']) {
    assert.equal(n.params[key].mode, 'auto', `${key} is derived`);
    assert.ok(n.params[key].auto && n.params[key].auto.from, `${key} says where its value came from`);
    assert.match(n.params[key].auto.from, /eye|levels/, `${key}'s evidence names the measurement`);
  }
  assert.ok(n.params.phase.auto.confident, 'a clean burst is a confident fit');
  const eye = Number(/eye ([\d.]+)/.exec(n.params.phase.auto.from)[1]);
  assert.ok(eye > 0.85, `eye ${eye}`);
});

test('the fit is derived over the whole span, not the moment it was added', async () => {
  // The burst is a tenth of a second in the middle of a span that is mostly quiet, and
  // the node is added with the playhead at 0.05 s, which is in the quiet part. Derived
  // from a peek window this reported an eye of 0.475 with complete confidence.
  const { e, fm } = await engine();
  const n = await e.addNode({ parent: fm.id, op: 'core.symbols', at: 0.05 });
  const eye = Number(/eye ([\d.]+)/.exec(n.params.phase.auto.from)[1]);
  assert.ok(eye > 0.85, `eye ${eye} — the fit found the silence, not the burst`);
});

test('two reads that overlap agree about which sample was a symbol', async () => {
  // The property that decides whether a decoder downstream sees one signal or a new one
  // every frame, and the one nothing on screen would show. A symbol is named by an
  // absolute index, so a window that starts somewhere else still lands on the same grid
  // — the same bug the tuner's carrier phase had, in a different coordinate.
  const { e, fm } = await engine();
  const n = await e.addNode({ parent: fm.id, op: 'core.symbols', at: 0.05 });
  const wide = e._readSymbols(n, 0.3, 1000);
  const narrow = e._readSymbols(n, 0.3, 400);
  for (let k = 0; k < 400; k++) {
    assert.ok(Math.abs(wide[600 + k] - narrow[k]) < 1e-5,
              `symbol ${k}: ${wide[600 + k]} from a 1000-symbol read, ${narrow[k]} from a 400-symbol one`);
  }
  // And a window that ends elsewhere lands on the grid too, not on its own.
  const later = e._readSymbols(n, 0.3 + 50 / SYMBOL_RATE, 400);
  for (let k = 0; k < 350; k++) {
    assert.ok(Math.abs(later[k] - narrow[k + 50]) < 1e-5, `shifted read, symbol ${k}`);
  }
});

test('invert turns every symbol upside down and nothing else', async () => {
  const { e, fm } = await engine();
  const n = await e.addNode({ parent: fm.id, op: 'core.symbols', at: 0.05 });
  const up = e._readSymbols(n, 0.3, 200);
  await e.setParam(n.id, 'invert', 'yes');
  const down = e._readSymbols(e.node(n.id), 0.3, 200);
  for (let k = 0; k < 200; k++) {
    assert.ok(Math.abs(down[k] + up[k]) < 1e-5, `symbol ${k}: ${down[k]} is not −${up[k]}`);
  }
});

test('the symbols a node hands over are the ones that were sent', async () => {
  const want = symbolRun(400);
  const { e, fm } = await engine(want);
  const n = await e.addNode({ parent: fm.id, op: 'core.symbols', at: 0.05 });
  const all = e._readSymbols(n, e.duration(), Math.floor(e.duration() * SYMBOL_RATE));
  const hard = [...all].map((v) => (Math.abs(v) < 0.5 ? null
    : [-3, -1, 1, 3].reduce((a, b) => (Math.abs(v - b) < Math.abs(v - a) ? b : a))));
  const run = want.join(',');
  // Somewhere in that stream is the run that was sent. Forty symbols is far more than
  // could line up by accident out of four levels.
  let found = false;
  for (let i = 0; i + 40 < hard.length && !found; i++) {
    if (hard[i] == null) continue;
    found = run.includes(hard.slice(i, i + 40).join(','));
  }
  assert.ok(found, 'no run of 40 recovered symbols appears in what was sent');
});
