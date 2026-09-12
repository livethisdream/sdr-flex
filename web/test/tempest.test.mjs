// A screen leaking, folded back into a picture.
//
// A monitor radiates a raster: pixels along a line, lines down a frame, and blanking
// intervals where the beam is flying back and nothing is drawn. The blanking is the only
// structure in the signal and it is what makes the line period findable — so nothing has
// to be told the resolution, which is the whole point, because on a real leak nobody
// knows it.
//
// The fixture has text on the screen deliberately. A raster folded at a period wrong by a
// fraction of a sample shears a little more with every line, so a picture with letters on
// it fails where you can see it rather than as a number that has quietly moved.
//
// What this proves is the mechanism, not that it will read a real leak — see the note at
// the bottom, which is the honest limit.
//
//   node --test web/test/tempest.test.mjs

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
const RATE = 200_000, CENTER = 300_000_000;
const W = 96, H = 64, LINE = 120, FRAME = 72;

const screen = (opts = {}) => {
  const img = mod.bitmapText('SDR', { width: W, height: H, scale: 4 });
  return { img, ...mod.rasterScan(img, { width: W, height: H, hBlank: 24, vBlank: 8, ...opts }) };
};

const render = (g, floor = 0.45, step = 3) => {
  let peak = 0;
  for (const v of g.data) peak = Math.max(peak, v);
  const out = [];
  for (let y = 0; y < g.rows; y += step) {
    let s = '';
    for (let x = 0; x < Math.min(W, g.cols); x += 2) s += g.data[y * g.cols + x] > peak * floor ? '#' : '.';
    out.push(s);
  }
  return out.join('\n');
};

// ── the two periods ─────────────────────────────────────────────────────────

test('the line period comes out of an autocorrelation', () => {
  const r = screen();
  const est = dsp.estimatePeriod(r.signal, { minLag: 20, maxLag: 400 });
  assert.ok(Math.abs(est.value - LINE) < 0.1, `${est.value.toFixed(3)} samples against ${LINE}`);
  assert.equal(est.confident, true);
});

test('the period is fractional, because a raster line rarely is not', () => {
  // A period rounded to the nearest sample shears a little more with every line. The
  // parabola through the correlation peak is what keeps the picture straight.
  const r = screen();
  const est = dsp.estimatePeriod(r.signal, { minLag: 20, maxLag: 400 });
  assert.notEqual(est.value, Math.round(est.value), 'it refines below a whole sample');
});

test('the frame is a whole number of lines, and only whole numbers are tried', () => {
  const r = screen();
  const est = dsp.estimateRaster(r.signal, r.signal.length, RATE);
  assert.equal(est.linesPerFrame, FRAME);
  assert.equal(est.frameConfident, true);
  assert.ok(Math.abs(est.lineUs - (LINE / RATE) * 1e6) < 1);
});

test('noise has no raster in it', () => {
  const rand = mod.rng(0x9e11);
  const noise = new Float32Array(40_000);
  for (let i = 0; i < noise.length; i++) noise[i] = rand();
  const est = dsp.estimateRaster(noise, noise.length, RATE);
  assert.equal(est.confident, false, `peak ${est.peak?.toFixed(3)} contrast ${est.contrast?.toFixed(3)}`);
});

// ── the picture ─────────────────────────────────────────────────────────────

test('folding at the line period gives the screen back', () => {
  const r = screen();
  const est = dsp.estimatePeriod(r.signal, { minLag: 20, maxLag: 400 });
  const g = dsp.foldRaster(r.signal, r.signal.length, est.value, { cols: LINE });
  assert.ok(g.rows >= FRAME, `${g.rows} rows`);

  // Against the bitmap that was scanned, cell for cell over the visible area.
  let same = 0, total = 0;
  let peak = 0;
  for (const v of g.data) peak = Math.max(peak, v);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      total++;
      const lit = g.data[y * g.cols + x] > peak * 0.45 ? 1 : 0;
      if (lit === (r.img[y * W + x] > 0.5 ? 1 : 0)) same++;
    }
  }
  assert.ok(same / total > 0.98,
            `${((same / total) * 100).toFixed(1)}% of pixels agree\n${render(g)}`);
});

// ── through the graph ───────────────────────────────────────────────────────

async function opened() {
  const data = fs.readFileSync(path.join(HERE, '..', '..', 'fixtures', 'tempest-raster', 'capture.sigmf-data'));
  const cap = new Capture({ buffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
                            format: 'cu8', sampleRate: RATE, centerHz: CENTER, label: 'tempest' });
  const e = new MockEngine({ latency: false });
  await e.createSession();
  await e.openCapture(cap);
  return e;
}

test('the node reads a screen off a capture, with its evidence', async () => {
  const e = await opened();
  const n = await e.addNode({ parent: e.root.id, op: 'core.raster', at: 0.05 });
  const g = await e.sliceGrid(n.id, 0.05);
  assert.ok(g && g.rows > 0, 'nothing came back');
  assert.equal(g.rows, FRAME, 'one frame, the frames averaged together');
  assert.equal(g.frames, 3, 'and all three of them went into it');

  const live = e.node(n.id);
  assert.ok(Math.abs(live.params.lineUs.value - 600) < 1, `${live.params.lineUs.value} µs`);
  assert.equal(live.params.lines.value, FRAME);
  assert.equal(live.params.lineUs.auto.confident, true);
  assert.match(live.params.lineUs.auto.from, /repeats every 120\.0 samples/);
  assert.match(live.params.lines.auto.from, /whole frame repeats every 72 lines/);

  const drawn = render(g);
  assert.match(drawn, /######\.\.####\.\.\.\.######/, `the screen does not say SDR:\n${drawn}`);
});

test('it takes IQ directly, because the AM detector is sized for audio', async () => {
  // The post-detection filter in the AM demodulator is forty microseconds, which is right
  // for speech and eight pixels wide here. Through it the letters come out as bars.
  const e = await opened();
  const direct = await e.addNode({ parent: e.root.id, op: 'core.raster', at: 0.05 });
  const sharp = render(await e.sliceGrid(direct.id, 0.05));

  const am = await e.addNode({ parent: e.root.id, op: 'core.am_envelope', at: 0.05 });
  const viaAm = await e.addNode({ parent: am.id, op: 'core.raster', at: 0.05 });
  const smeared = render(await e.sliceGrid(viaAm.id, 0.05));

  assert.match(sharp, /######\.\.####/, 'straight off IQ the letters are sharp');
  assert.notEqual(smeared, sharp, 'and through the audio filter they are not the same picture');
  // The smeared one has more lit pixels: that is what a blur does.
  const lit = (s) => (s.match(/#/g) || []).length;
  assert.ok(lit(smeared) > lit(sharp), `${lit(smeared)} lit against ${lit(sharp)}`);
});

test('averaging can be turned off, and then you see every frame', async () => {
  const e = await opened();
  const n = await e.addNode({ parent: e.root.id, op: 'core.raster', at: 0.05 });
  await e.setParam(n.id, 'average', 0, 'manual');
  const g = await e.sliceGrid(n.id, 0.05);
  assert.ok(g.rows > FRAME * 2, `${g.rows} rows, so the frames are stacked rather than folded`);
  assert.equal(g.frames, 1);
});

// ── and the limit, stated rather than discovered later ──────────────────────

test('a moving picture has no frame to average, and says so', async () => {
  // Every frame different: the line period is still there, the frame repeat is not. The
  // node should find the line, fail to find a frame, and say which — rather than
  // averaging three different pictures into a grey smear and calling it a screen.
  const rows = [];
  for (let f = 0; f < 3; f++) {
    const img = mod.bitmapText(['SDR', 'FLEX', 'OX'][f], { width: W, height: H, scale: 3 });
    rows.push(mod.rasterScan(img, { width: W, height: H, hBlank: 24, vBlank: 8, seed: 0x11 + f }));
  }
  const all = new Float32Array(rows.reduce((n, r) => n + r.signal.length / 3, 0));
  let w = 0;
  for (const r of rows) { all.set(r.signal.subarray(0, r.signal.length / 3), w); w += r.signal.length / 3; }
  const est = dsp.estimateRaster(all, all.length, RATE);
  assert.ok(Math.abs(est.lineSamples - LINE) < 0.5, 'the line is still found');
  assert.equal(est.frameConfident, false, 'but there is no frame that repeats');
});
