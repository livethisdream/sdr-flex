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

// ── the same screen, the way a receiver actually gets it ────────────────────
//
// Everything above is the clean case. A real leak differs in three ways, and each one
// breaks something different — see fixtures/tempest-leak/README.md, which says what and
// why. These are the regression tests for the three fixes, and each was checked to fail
// against the code that came before it.

const LEAK_RATE = 8_000_000;
const leak = () => {
  const img = mod.bitmapText('SDR', { width: 40, height: 72, scale: 2 });
  return mod.rasterLeak(img, { width: 40, height: 72, hBlank: 12, vBlank: 12,
                               samplesPerPixel: 3.77, harmonic: 13, frames: 6,
                               walkPerFrame: 0.47, jitter: 1, seed: 0x51ea });
};

test('a folded pixel-clock harmonic does not get mistaken for the line', () => {
  // Without the smoothing this returns 194.02 samples and a two-line "frame": the folded
  // harmonic correlates with itself better than the picture does, and wins.
  const r = leak();
  const est = dsp.estimateRaster(r.signal, r.signal.length, LEAK_RATE);
  assert.ok(Math.abs(est.lineSamples - r.samplesPerLine) < 0.1,
            `${est.lineSamples.toFixed(3)} samples against ${r.samplesPerLine}`);
  assert.equal(est.linesPerFrame, r.frameLines);
  assert.ok(est.smoothWin > 1, 'and it says how much it smoothed to get there');
});

test('the line period is taken back out of the frame, which is far more of it', () => {
  // One correlation peak locates a period to about a tenth of a sample. The same peak a
  // frame away locates it that many lines better, and on a leak the difference between
  // the two is the difference between a readable frame and a sheared one. On the 20 Msps
  // capture this was written for, with 525 lines to a frame, it was 180 ppm against 2.
  // Here it is worth less and for a reason worth keeping: a frame that lands a sample
  // from where it was predicted puts a sample of uncertainty into the lag it is measured
  // from, and 84 lines cannot divide that away the way 525 can. It is still the better
  // of the two numbers by a wide margin, which is all that is being claimed.
  const r = leak();
  const est = dsp.estimateRaster(r.signal, r.signal.length, LEAK_RATE);
  assert.equal(est.refined, true, 'it refined off the frame rather than the line');
  // `value` is where the line peak alone put it; `lineSamples` is after the frame.
  const shear = (P) => Math.abs(P - r.samplesPerLine) * r.frameLines;
  assert.ok(shear(est.lineSamples) < shear(est.value) / 2,
            `${shear(est.lineSamples).toFixed(2)} samples of shear across a frame, ` +
            `against ${shear(est.value).toFixed(2)} off the line peak alone`);
  // Within about the jitter that was put in, which is the floor this can reach.
  assert.ok(shear(est.lineSamples) < 1.5,
            `${shear(est.lineSamples).toFixed(2)} samples from the top of the frame to the bottom`);
});

test('stacking takes the sharper of aligned and not, rather than assuming', () => {
  // The trap this guards against is a stack that looks like more signal and is less. On
  // the 20 Msps leak this was written for, aligning the frames was worth ninety times the
  // horizontal detail. Here it is worth about half — what folds back into the passband is
  // near two samples a cycle, so the column correlation has a peak every two samples and
  // picking the wrong one is worse than not having looked. Neither is knowable in
  // advance, so both get built.
  const r = leak();
  const est = dsp.estimateRaster(r.signal, r.signal.length, LEAK_RATE);
  const P = est.lineSamples, lines = est.linesPerFrame, cols = Math.round(P);
  const st = dsp.stackFrames(r.signal, r.signal.length, P, lines, { cols });
  assert.equal(st.frames, r.frames, 'every frame in the capture');

  const detail = (a) => {
    let s = 0;
    for (let y = 0; y < lines; y++) {
      for (let x = 1; x < cols; x++) { const d = a[y * cols + x] - a[y * cols + x - 1]; s += d * d; }
    }
    return s;
  };
  const blind = new Float32Array(lines * cols);
  for (let f = 0; f < r.frames; f++) {
    const g = dsp.foldRaster(r.signal, r.signal.length, P, { cols, maxRows: lines, from: f * lines * P });
    for (let i = 0; i < blind.length; i++) blind[i] += g.data[i] / r.frames;
  }
  // Whichever it chose, what comes back is at least as sharp as stacking them blind.
  assert.ok(detail(st.data) >= detail(blind) * 0.999,
            `${detail(st.data).toExponential(2)} against ${detail(blind).toExponential(2)} blind`);
  assert.equal(st.aligned, false, 'and on this one, aligning is the worse of the two');
});

test('the node reads the hard capture too, end to end', async () => {
  const data = fs.readFileSync(path.join(HERE, '..', '..', 'fixtures', 'tempest-leak', 'capture.sigmf-data'));
  const e = new MockEngine({ latency: false });
  await e.createSession();
  await e.openCapture(new Capture({
    buffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    format: 'cu8', sampleRate: LEAK_RATE, centerHz: CENTER, label: 'leak' }));
  const n = await e.addNode({ parent: e.root.id, op: 'core.raster', at: e.duration() });
  const g = await e.sliceGrid(n.id, e.duration());

  const r = leak();
  assert.equal(g.rows, r.frameLines, 'a frame of lines');
  assert.equal(g.frames, r.frames, 'every frame in the capture went into it');
  const live = e.node(n.id);
  assert.ok(Math.abs(live.params.lineUs.value - (r.samplesPerLine / LEAK_RATE) * 1e6) < 0.02,
            `${live.params.lineUs.value} µs`);
});

// ── the same numbers, a great deal faster ───────────────────────────────────

test('the autocorrelation agrees with the one done by hand', () => {
  // The direct correlation is one multiply-add per sample per lag, and a raster search
  // wants forty thousand lags: eighty-six seconds on the capture this was written for.
  // The FFT does not care how many lags are asked for. This is the check that swapping
  // one for the other did not change the answer.
  const r = leak();
  const x = r.signal, count = 1 << 14;
  const a = dsp.autocorrelate(x, count, { maxSamples: count });

  let mean = 0;
  for (let i = 0; i < count; i++) mean += x[i];
  mean /= count;
  let e0 = 0;
  for (let i = 0; i < count; i++) { const v = x[i] - mean; e0 += v * v; }
  for (const lag of [1, 7, 120, 196, 500, 1000]) {
    let acc = 0;
    const m = count - lag;
    for (let i = 0; i < m; i++) acc += (x[i] - mean) * (x[i + lag] - mean);
    const byHand = acc / (e0 * (m / count));
    assert.ok(Math.abs(a.r[lag] - byHand) < 2e-3,
              `lag ${lag}: ${a.r[lag].toFixed(5)} by FFT against ${byHand.toFixed(5)} by hand`);
  }
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
