// OFDM, and the one thing a cyclic prefix makes possible.
//
// Every OFDM symbol carries a copy of its own tail pasted in front of it. That exists to
// absorb multipath and it has a side effect that gives the whole scheme away: a stretch
// of samples identical to another stretch exactly one FFT length later, recurring once
// per symbol. Nothing else in a signal does that, which is why the FFT size, the prefix
// length and the symbol period can all be recovered without being told any of them.
//
// The fixture spells SDR across its resource grid, and that is not a flourish. In OFDM
// the message can be *which* cells carry anything; a grid recovered with the symbol
// boundaries even slightly wrong smears the letters. It fails where you can see it.
//
//   node --test web/test/ofdm.test.mjs

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
const RATE = 200_000, CENTER = 2_412_000_000;

const made = (opts = {}) => {
  const grid = mod.gridText('SDR', { fftN: opts.fftN || 64 });
  return { grid, ...mod.ofdm(grid, { rate: RATE, fftN: 64, cpN: 16, seed: 0x0fd0, ...opts }) };
};

/** Which cells are lit, thresholded relative to the strongest — the board, as read. */
function litCells(g, floor = 0.3) {
  let peak = 0;
  for (const v of g.data) peak = Math.max(peak, v);
  const rows = [];
  for (let r = 0; r < g.rows; r++) {
    const row = new Uint8Array(g.cols);
    for (let c = 0; c < g.cols; c++) row[c] = g.data[r * g.cols + c] > peak * floor ? 1 : 0;
    rows.push(row);
  }
  return rows;
}

const render = (rows, lo = 12, hi = 52) =>
  rows.map((r) => Array.from(r.slice(lo, hi)).map((b) => (b ? '#' : '.')).join('')).join('\n');

// ── the structure, found from nothing ───────────────────────────────────────

test('the FFT size and the cyclic prefix come out of the signal', () => {
  const g = made();
  const est = dsp.estimateOfdm(g.iq, g.iq.length / 2, RATE);
  assert.equal(est.fftN, 64);
  assert.equal(est.cpN, 16);
  assert.equal(est.confident, true);
  assert.ok(Math.abs(est.symbolS - 80 / RATE) < 1e-9, `symbol ${(est.symbolS * 1e6).toFixed(1)} µs`);
  assert.equal(est.spacingHz, RATE / 64);
  // A real prefix correlates far better than the signal does with itself anywhere else.
  assert.ok(est.contrast > 0.2, `contrast ${est.contrast.toFixed(3)}`);
});

test('a different size and prefix are found just as well', () => {
  for (const [fftN, cpN] of [[128, 32], [64, 8], [256, 16]]) {
    const g = made({ fftN, cpN });
    const est = dsp.estimateOfdm(g.iq, g.iq.length / 2, RATE);
    assert.equal(est.fftN, fftN, `expected FFT ${fftN}, got ${est.fftN}`);
    assert.equal(est.cpN, cpN, `expected prefix ${cpN}, got ${est.cpN}`);
  }
});

test('noise has no prefix, and is not confident about one', () => {
  const rand = mod.rng(0x51de);
  const n = 1 << 15;
  const noise = new Float32Array(n * 2);
  for (let i = 0; i < n * 2; i++) noise[i] = (rand() - 0.5);
  const est = dsp.estimateOfdm(noise, n, RATE);
  assert.equal(est.confident, false, `contrast ${est.contrast?.toFixed(3)}`);
});

test('a single carrier is not OFDM either', () => {
  const n = 1 << 15;
  const iq = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const w = (2 * Math.PI * 9000 * i) / RATE;
    iq[i * 2] = 0.6 * Math.cos(w); iq[i * 2 + 1] = 0.6 * Math.sin(w);
  }
  const est = dsp.estimateOfdm(iq, n, RATE);
  // A tone correlates with itself at *every* lag, so the metric is high everywhere and
  // there is no contrast — which is exactly the case the contrast test exists for.
  assert.equal(est.confident, false, `a tone should not look like OFDM (contrast ${est.contrast?.toFixed(3)})`);
});

// ── the grid ────────────────────────────────────────────────────────────────

test('the board comes back readable', () => {
  const g = made();
  const est = dsp.estimateOfdm(g.iq, g.iq.length / 2, RATE);
  const out = dsp.ofdmGrid(g.iq, g.iq.length / 2, est);
  assert.ok(out.rows >= g.grid.length - 1, `${out.rows} rows of ${g.grid.length}`);
  assert.equal(out.cols, 64);

  // Cell for cell against what was transmitted. Anything less than near-perfect here and
  // the letters are smeared, which is the failure this fixture exists to make visible.
  const read = litCells(out);
  let same = 0, total = 0;
  for (let r = 0; r < read.length; r++) {
    for (let c = 0; c < 64; c++) { total++; if (read[r][c] === g.grid[r][c]) same++; }
  }
  assert.ok(same / total > 0.99,
            `${((same / total) * 100).toFixed(1)}% of cells agree\n${render(read)}`);
});

test('the grid is in frequency order, not FFT order', () => {
  // FFT order puts DC first and wraps the negative frequencies to the top, which would
  // cut the picture in half and paste it back the wrong way round. A person reading a
  // resource grid expects the lowest frequency at one end.
  const g = made();
  const est = dsp.estimateOfdm(g.iq, g.iq.length / 2, RATE);
  const read = litCells(dsp.ofdmGrid(g.iq, g.iq.length / 2, est));
  const middle = read[Math.floor(read.length / 2)];
  let lo = -1, hi = -1;
  for (let c = 0; c < 64; c++) if (middle[c]) { if (lo < 0) lo = c; hi = c; }
  assert.ok(lo > 8 && hi < 56, `the lit block sits in the middle, at ${lo}..${hi}`);
});

// ── through the graph ───────────────────────────────────────────────────────

async function opened() {
  const data = fs.readFileSync(path.join(HERE, '..', '..', 'fixtures', 'ofdm-grid', 'capture.sigmf-data'));
  const cap = new Capture({ buffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
                            format: 'cu8', sampleRate: RATE, centerHz: CENTER, label: 'ofdm' });
  const e = new MockEngine({ latency: false });
  await e.createSession();
  await e.openCapture(cap);
  return e;
}

test('the node derives its own parameters and says what told it so', async () => {
  const e = await opened();
  const n = await e.addNode({ parent: e.root.id, op: 'core.ofdm', at: 0.005 });
  const g = await e.sliceGrid(n.id, 0.005);
  assert.ok(g && g.rows > 10, `${g && g.rows} rows`);
  assert.equal(g.cols, 64);

  const live = e.node(n.id);
  assert.equal(live.params.fftN.value, 64);
  assert.equal(live.params.cpN.value, 16);
  assert.ok(Math.abs(live.params.symbolUs.value - 400) < 1);
  assert.equal(live.params.fftN.auto.confident, true);
  assert.match(live.params.fftN.auto.from, /prefix correlates at a lag of 64 samples/);
  assert.match(live.params.cpN.auto.from, /25% prefix/);
});

test('the letters survive the round trip through a capture', async () => {
  const e = await opened();
  const n = await e.addNode({ parent: e.root.id, op: 'core.ofdm', at: 0.005 });
  const g = await e.sliceGrid(n.id, 0.005);
  const read = litCells(g);
  // The fixture spells SDR. Each letter is three cells wide with a gap, repeated three
  // rows deep, so the middle of the pattern is the middle bar of each letter.
  const drawn = render(read);
  assert.match(drawn, /#########...######/, `the top of S D R is not there:\n${drawn}`);
  assert.ok(read.some((r) => r.some((v) => v)), 'something is lit at all');
  // and the blank rows at either end really are blank
  assert.ok(!read[0].some((v) => v), 'the grid starts quiet');
});

test('caching is keyed on the settings, so pinning a size re-reads', async () => {
  const e = await opened();
  const n = await e.addNode({ parent: e.root.id, op: 'core.ofdm', at: 0.005 });
  const first = await e.sliceGrid(n.id, 0.005);
  assert.equal(await e.sliceGrid(n.id, 0.005), first, 'the same settings return the same object');
  await e.setParam(n.id, 'fftN', 128, 'manual');
  const second = await e.sliceGrid(n.id, 0.005);
  assert.notEqual(second, first, 'a pinned size is a different question');
  assert.equal(e.node(n.id).params.fftN.value, 128, 'and it is honored rather than overruled');
});
