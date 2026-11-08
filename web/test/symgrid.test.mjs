// The symbol grid (ADR-0046): measured first, then moved by hand, then handed to a slicer.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../src/symgrid.js';
import { MockEngine } from '../src/engine.js';
import { Capture } from '../src/capture.js';

const FS = 100_000, SYM_S = 417e-6, OFFSET_S = 0.0031;

/** NRZ at 417 µs a symbol, starting 3.1 ms in, with a little noise. */
function nrz(bits = '1010101011001110001011010011101001', seconds = 0.03) {
  const n = Math.round(FS * seconds), x = new Float32Array(n);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32 - 0.5) * 0.1;
  for (let i = 0; i < n; i++) {
    const k = Math.floor((i / FS - OFFSET_S) / SYM_S);
    x[i] = (k >= 0 && k < bits.length && bits[k] === '1' ? 1 : 0) + rnd();
  }
  return x;
}

test('an auto grid finds the period and puts its lines on the transitions', () => {
  const x = nrz(), t0 = 10;
  const g = G.fitGrid(x, FS, t0, 0, x.length);
  assert.equal(g.mode, 'auto');
  assert.ok(Math.abs(g.period - SYM_S) < 2e-6, `period ${g.period * 1e6} µs`);
  // every line is a whole number of symbols from where the data starts
  const k = (g.start - t0 - OFFSET_S) / SYM_S;
  assert.ok(Math.abs(k - Math.round(k)) < 0.05, `first line ${k.toFixed(3)} symbols off the grid`);
  assert.ok(g.start >= t0 && g.start + g.count * g.period <= t0 + x.length / FS + 1e-9, 'inside the box');
  assert.match(g.from, /edges in the box agree on 417\.\d µs \(\d+%\), within ±\d/);
});

test('a Manchester grid is one line a symbol, though its edges come every half', () => {
  const bits = '1010101011001110001011010011101001', n = Math.round(FS * 0.03), x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = (i / FS - OFFSET_S) / SYM_S, k = Math.floor(u);
    const firstHalf = u - k < 0.5;
    x[i] = k >= 0 && k < bits.length ? ((bits[k] === '1') === firstHalf ? 1 : 0) : 0;
  }
  const g = G.fitGrid(x, FS, 0, 0, x.length, 'manchester');
  assert.ok(Math.abs(g.period - SYM_S) < 2e-6, `period ${g.period * 1e6} µs`);
});

test('moving, stretching or recounting a grid makes it a hand grid', () => {
  const g = { start: 1, period: 0.001, count: 10, mode: 'auto' };
  const m = G.move(g, 0.0002);
  assert.equal(m.mode, 'hand');
  assert.equal(m.start, 1.0002);
  const s = G.stretch(g, 1.012);
  assert.ok(Math.abs(s.period - 0.0012) < 1e-12);
  assert.equal(s.start, 1);
  const c = G.setCount(g, 20);
  assert.equal(c.count, 20);
  assert.ok(Math.abs(c.count * c.period - 0.01) < 1e-12, 'same width');
  assert.equal(G.lines(g).length, 11);
  assert.equal(G.describe(g), '10 symbols · 1.00 ms · 1000 Bd');
});

test('too few edges is said plainly, and a hand grid is still there to place', () => {
  const flat = new Float32Array(2000).fill(0.5);
  const g = G.fitGrid(flat, FS, 0, 0, flat.length);
  assert.match(g.error, /too few to measure/);
  const h = G.handGrid(0, 0.008, 8);
  assert.equal(h.mode, 'hand');
  assert.ok(Math.abs(h.period - 0.001) < 1e-12);
});

test('a frequency trace with gaps (NaN) still fits', () => {
  const x = nrz();
  for (let i = 0; i < 200; i++) x[i] = NaN;
  const g = G.fitGrid(x, FS, 0, 0, x.length);
  assert.ok(Math.abs(g.period - SYM_S) < 2e-6, `period ${g.period * 1e6} µs`);
});

test('the residual says how well the lines sit on the edges', () => {
  const g = { start: 0, period: 1e-3, count: 10, mode: 'hand' };
  assert.equal(G.residual(g, [0.001, 0.002, 0.005]), 0);
  assert.ok(Math.abs(G.residual(g, [0.0011, 0.0019]) - 1e-4) < 1e-12);
});

test('"use this": a hand grid pins the slicer, with where the number came from', () => {
  const h = G.handoff({ start: 2, period: 416e-6, count: 24, mode: 'hand' });
  assert.deepEqual(h, { value: 416, mode: 'manual', extra: { from: 'set by hand: 24 symbols over 9.98 ms' } });
  const a = G.handoff({ start: 2, period: 416e-6, count: 24, mode: 'auto', from: 'x' });
  assert.equal(a.mode, 'auto');
  assert.ok(Math.abs(a.extra.span.t1 - (2 + 24 * 416e-6)) < 1e-12);
});

/** An OOK capture of NRZ bytes: the carrier on for a one. */
async function nrzEngine() {
  const seconds = 1, n = FS * seconds, buf = new Uint8Array(n * 2);
  const bits = '10101010'.repeat(4) + '1100111000101101001110100110001011100101'.repeat(6);
  const at = 0.2;
  for (let i = 0; i < n; i++) {
    const k = Math.floor((i / FS - at) / SYM_S);
    const on = k >= 0 && k < bits.length && bits[k] === '1';
    buf[i * 2] = on ? 230 : 128; buf[i * 2 + 1] = 128;
  }
  const e = new MockEngine({ latency: false });
  await e.createSession();
  await e.openCapture(new Capture({ buffer: buf.buffer, format: 'cu8', sampleRate: FS, centerHz: 433.92e6, label: 'nrz' }));
  const am = await e.addNode({ parent: e.root.id, op: 'core.am_envelope' });
  const sl = await e.addNode({ parent: am.id, op: 'core.nrz_slicer' });
  return { e, sl: e.node(sl.id) };
}

test('a hand value lands on the slicer as manual, with its note, and a typed one clears it', async () => {
  const { e, sl } = await nrzEngine();
  const h = G.handoff({ start: 0.2, period: 417e-6, count: 24, mode: 'hand' });
  await e.setParam(sl.id, 'symbolUs', h.value, h.mode, h.extra);
  assert.equal(e.node(sl.id).params.symbolUs.mode, 'manual');
  assert.equal(e.node(sl.id).params.symbolUs.note, 'set by hand: 24 symbols over 10.01 ms');
  await e.setParam(sl.id, 'symbolUs', 400);
  assert.equal(e.node(sl.id).params.symbolUs.note, undefined);
});

test('an auto value keeps the slicer auto, and it measures over the box', async () => {
  const { e, sl } = await nrzEngine();
  await e.setParam(sl.id, 'symbolUs', 410, 'auto', { from: 'the symbol grid', span: { t0: 0.2, t1: 0.25 } });
  const out = await e.sliceBytes(sl.id);
  const p = e.node(sl.id).params.symbolUs;
  assert.ok(out);
  assert.equal(p.mode, 'auto');
  assert.ok(Math.abs(p.value - 417) < 3, `measured ${p.value} µs`);
  assert.match(p.auto.from, /^the box 0\.200–0\.250 s: \d+% of the edges agree on 41\d\.\d µs/);
  // and switching it back to plain auto measures the whole capture again
  await e.setMode(sl.id, 'symbolUs', 'auto');
  assert.equal(e.node(sl.id).params.symbolUs.span, undefined);
});

test('an IQ channel reads against time as amplitude or frequency', async () => {
  const { e } = await nrzEngine();
  const amp = e.frame(e.root.id, { spanS: 0.05, trigger: 'auto', quantity: 'amplitude', at: 0.28 });
  assert.equal(amp.kind, 'timeseries');
  assert.ok(amp.triggered);
  assert.ok(Math.abs(amp.spanS - 0.05) < 1e-3);
  const fr = e.frame(e.root.id, { spanS: 0.05, trigger: 'free', quantity: 'frequency', at: 0.28 });
  let gaps = 0, on = 0;
  for (const v of fr.data) { if (Number.isNaN(v)) gaps++; else { on++; assert.ok(Math.abs(v) < 1, 'an unmodulated carrier sits at 0 Hz'); } }
  assert.ok(gaps > 0 && on > 0, 'the off symbols are left out');
});

test('zoomed in, each sample is drawn where its time falls, so a line can be read against it', async () => {
  globalThis.window ??= { devicePixelRatio: 1 };
  globalThis.document ??= { documentElement: {} };
  globalThis.getComputedStyle ??= () => ({ getPropertyValue: () => '' });
  const { TimeSeries } = await import('../src/views.js');
  const pts = [];
  const ctx = new Proxy({}, { get: (_, k) => k === 'moveTo' || k === 'lineTo' ? (x, y) => pts.push([x, y]) : () => {}, set: () => true });
  const ts = new TimeSeries({ clientWidth: 1000, clientHeight: 200, width: 0, height: 0, getContext: () => ctx });
  const data = new Float32Array(2000).map((_, i) => (i % 40 < 20 ? 1 : 0));
  const view = { lo: 0.25, hi: 0.275 };                                      // 50 samples on 1000 px
  ts.draw(data, 0.02, view);
  // sample 520 is at fraction 0.26 of the frame, so 40% of the way across the view
  const x520 = pts.find(([x]) => Math.abs(x - ((520 / 2000 - view.lo) / (view.hi - view.lo)) * 1000) < 1e-6);
  assert.ok(x520, 'sample 520 is drawn at x = 400');
  assert.ok(pts.every(([x]) => x > -40 && x < 1040), 'only the samples in view, and their neighbors');
});

test('zoomed in amplitude, a level sits where the view puts it, and the scale is labeled', async () => {
  globalThis.window ??= { devicePixelRatio: 1 };
  globalThis.document ??= { documentElement: {} };
  globalThis.getComputedStyle ??= () => ({ getPropertyValue: () => '' });
  const { TimeSeries } = await import('../src/views.js');
  const pts = [], text = [];
  const ctx = new Proxy({}, { get: (_, k) => k === 'moveTo' || k === 'lineTo' ? (x, y) => pts.push([x, y])
    : k === 'fillText' ? (t) => text.push(t) : k === 'measureText' ? () => ({ width: 30 }) : () => {}, set: () => true });
  const ts = new TimeSeries({ clientWidth: 100, clientHeight: 210, width: 0, height: 0, getContext: () => ctx });
  const data = new Float32Array(400).fill(0.5); data[0] = 1;                // the automatic range is 0 to 1.15
  ts.draw(data, 0.01, { lo: 0, hi: 1, ylo: 0.25, yhi: 0.75 });
  // 0.5 is 43.5% up the automatic range, so 37% up the view: H - 4 - 0.37 * (H - 10)
  const want = 206 - ((0.5 / 1.15 - 0.25) / 0.5) * 200;
  assert.ok(pts.some(([, y]) => Math.abs(y - want) < 1e-6), `0.5 drawn at y = ${want.toFixed(1)}`);
  assert.equal(text.length, 5, 'five labels down the side');
  assert.ok(+text[0] < +text[4], 'they count up the pane');
});

/** Runs of high and low, in symbols, as an envelope at `sps` samples a symbol. */
function fromRuns(runs, sps = 40) {
  const out = [];
  let hi = false;
  for (const n of [6, ...runs, 6]) { for (let i = 0; i < Math.round(n * sps); i++) out.push(hi ? 1 : 0); hi = !hi; }
  return Float32Array.from(out);
}

test('the grid guesses the slicer from the runs in the box, and says why', () => {
  // PWM as the scene sends it: a one is 2 high and 1 low, a zero 1 high and 2 low
  const pwm = fromRuns([...'1011001110100101'].flatMap((b) => (b === '1' ? [2, 1] : [1, 2])).slice(0, -1));
  const a = G.guessCoding(pwm, 0.5, 40);
  assert.equal(a.op, 'core.pwm_slicer');
  assert.match(a.why, /a pulse with its gap is always 3\.00/);
  // NRZ: runs of any length
  const b = G.guessCoding(fromRuns([1, 3, 2, 1, 1, 4, 2, 1, 3, 1, 2, 2]), 0.5, 40);
  assert.equal(b.op, 'core.nrz_slicer');
  assert.match(b.why, /runs of 1 to 4 symbols/);
  // Manchester at half a symbol a line: each bit is 1-0 or 0-1, so long runs span a middle
  const bits = '1101000111010010';
  const halves = [...bits].flatMap((x) => (x === '1' ? [1, 0] : [0, 1]));
  const runs = []; let last = null;
  for (const h of halves) { if (h === last) runs[runs.length - 1]++; else { runs.push(1); last = h; } }
  if (halves[0] === 0) runs.unshift(0.0001);       // fromRuns starts low
  const m = G.guessCoding(fromRuns(runs.filter((n) => n >= 1)), 0.5, 40);
  assert.equal(m.op, 'core.manchester');
  assert.ok(m.half);
  assert.equal(G.guessCoding(fromRuns([1, 1]), 0.5, 40), null, 'too little to go on');
});

test('a grid at half a symbol hands a Manchester slicer twice its period', () => {
  const g = { start: 0, period: 208e-6, count: 40, mode: 'hand', kind: 'nrz' };
  assert.equal(G.scaleFor(g, 'core.manchester'), 2);
  assert.equal(G.scaleFor({ ...g, kind: 'manchester' }, 'core.manchester'), 1);
  assert.equal(G.scaleFor(g, 'core.nrz_slicer'), 1);
  assert.equal(G.handoff(g, 2).value, 416);
});

test('slice as: an AM demod and a PWM slicer built from the grid read the burst', async () => {
  const { MESSAGE } = await import('../src/scene.js');
  const e = new MockEngine({ latency: false });
  await e.createSession();
  const c = e.root.out.centerHz;
  e.t = 1.0;
  const tu = await e.addNode({ parent: e.root.id, op: 'core.tuner', at: 1.0, selection: { f0: c - 50_000, f1: c } });
  const f = e.frame(tu.id, { spanS: 0.05, trigger: 'auto', quantity: 'amplitude' });
  const g = G.fitGrid(f.data, f.sampleRate, f.t0, 0, f.data.length);
  assert.equal(g.coding && g.coding.op, 'core.pwm_slicer', g.coding && g.coding.why);
  const am = await e.addNode({ parent: tu.id, op: 'core.am_envelope' });
  const sl = await e.addNode({ parent: am.id, op: g.coding.op });
  const h = G.handoff(g, G.scaleFor(g, g.coding.op));
  await e.setParam(sl.id, 'symbolUs', h.value, h.mode, h.extra);
  e.t = 2.0;
  const bits = e.frame(sl.id, {});
  const text = bits.groups.map((gr) => {
    const bytes = [];
    for (let i = 0; i + 8 <= gr.bits.length; i += 8) bytes.push(parseInt(gr.bits.slice(i, i + 8).join(''), 2));
    return String.fromCharCode(...bytes.slice(2));
  });
  assert.ok(text.includes(MESSAGE), `read ${JSON.stringify(text)}`);
});
