// The symbol grid (ADR-0046): lines one symbol period apart, laid over a waveform.
//
// It measures itself first and can then be moved by hand, the way Inspectrum's cursors are.
// A grid is three numbers in absolute time — where its first line is, how far apart the
// lines are, and how many symbols it spans — and a mode saying which of the two put them
// there. Everything here is pure, so the tests can reach it without a canvas.

import * as dsp from './dsp.js';

/** Which estimator a grid uses, by the slicer it would feed: they have to agree. */
export function estimatorFor(op) {
  if (op === 'core.pwm_slicer') return 'pwm';
  if (op === 'core.manchester') return 'manchester';
  return 'nrz';
}

/** Samples, with the gaps a frequency trace leaves (NaN) filled from the last good sample. */
function finite(x) {
  const out = new Float32Array(x.length);
  let last = 0;
  for (let i = 0; i < x.length; i++) if (Number.isFinite(x[i])) { last = x[i]; break; }
  for (let i = 0; i < x.length; i++) { if (Number.isFinite(x[i])) last = x[i]; out[i] = last; }
  return out;
}

export const edgesOf = dsp.edgesOf;

/**
 * Fit a grid to the samples `data[a, b)` of a frame that starts at `t0` (s) and runs at `fs`.
 *
 * The period comes from the estimator the downstream slicer uses, over the box only, so the
 * grid and the slicer measure the same thing the same way. The phase is the circular mean of
 * where the edges fall within a period: the lines go where the transitions are.
 */
export function fitGrid(data, fs, t0, a, b, kind = 'nrz') {
  a = Math.max(0, Math.floor(a)); b = Math.min(data.length, Math.ceil(b));
  const box = finite(data.subarray(a, b));
  if (box.length < 16) return { error: 'the box is too narrow to measure' };
  const thr = dsp.otsuThreshold(box).value;
  const sym = kind === 'pwm' ? dsp.estimateSymbolPeriod(box, thr, fs)
    : kind === 'manchester' ? dsp.estimateManchesterSymbol(box, thr, fs)
    : dsp.estimateNrzSymbol(box, thr, fs);
  const edges = edgesOf(box, thr);
  if (!(sym.value > 0) || edges.length < 3) {
    return { error: `${edges.length} edge${edges.length === 1 ? '' : 's'} in the box — too few to measure a period` };
  }
  const best = dsp.refineSymbol(edges, fs, sym.value, { half: kind === 'manchester' });
  const P = (best.value * 1e-6) * fs, phase = best.phase;
  const first = phase + P * Math.ceil((0 - phase) / P - 1e-9);       // first line in the box
  const count = Math.max(1, Math.floor((box.length - first) / P));
  const g = {
    start: t0 + (a + first) / fs, period: P / fs, count, mode: 'auto', kind,
    threshold: thr, confident: best.agreement > 0.6, agreement: best.agreement,
    coding: guessCoding(box, thr, P, phase),
  };
  const r = residual(g, edges.map((e) => t0 + (a + e) / fs));
  g.from = `${edges.length} edges in the box agree on ${fmtUs(g.period)} (${Math.round(best.agreement * 100)}%)` +
    (r != null ? `, within ±${fmtUs(r)} of the lines` : '') +
    (g.confident ? '' : ' — they do not agree well, so this is a guess');
  return g;
}

/**
 * Which slicer the box looks like it wants, from its runs measured in grid periods `P`
 * (samples), with the lines at `phase`. Returns `{ op, why }`, `half` when the lines are half
 * symbols, or null with too little to go on. It is a guess, and `why` says what it rests on.
 *
 * - PWM: pulses of two widths, one and two periods, and every pulse with the gap after it
 *   the same length, because each bit takes the same time.
 * - Manchester, fitted at half a symbol (its edges come every half): every run one or two
 *   periods, and the long runs all start on alternate lines, because they span a symbol's
 *   middle.
 * - NRZ: otherwise; runs of one to several periods, with no fixed pulse shape.
 */
export function guessCoding(x, threshold, P, phase = 0) {
  const runs = [];
  let hi = x[0] > threshold, start = 0;
  for (let i = 1; i <= x.length; i++) {
    const h = i < x.length ? x[i] > threshold : !hi;
    if (h !== hi) { runs.push({ hi, n: (i - start) / P, at: (start - phase) / P }); hi = h; start = i; }
  }
  runs.shift(); runs.pop();                                      // cut off by the box
  const GAP = 4.5;                                               // longer lows are between bursts
  const sym = runs.filter((r) => r.hi || r.n < GAP);
  if (sym.length < 6) return null;
  const near = (v, k) => Math.abs(v - k) < 0.3;
  const highs = sym.filter((r) => r.hi).map((r) => r.n);
  const sums = [];
  for (let k = 0; k + 1 < runs.length; k++) {
    if (runs[k].hi && !runs[k + 1].hi && runs[k + 1].n < GAP) sums.push(runs[k].n + runs[k + 1].n);
  }
  const mean = sums.reduce((a, v) => a + v, 0) / Math.max(1, sums.length);
  const sd = Math.sqrt(sums.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(1, sums.length));
  const one = highs.filter((v) => near(v, 1)).length, two = highs.filter((v) => near(v, 2)).length;
  if (sums.length >= 4 && sd < 0.25 && one && two && one + two >= 0.9 * highs.length) {
    return { op: 'core.pwm_slicer',
             why: `pulses are 1 or 2 symbols long, and a pulse with its gap is always ${mean.toFixed(2)}` };
  }
  const twos = sym.filter((r) => near(r.n, 2)).map((r) => ((Math.round(r.at) % 2) + 2) % 2);
  if (sym.every((r) => near(r.n, 1) || near(r.n, 2)) && twos.length >= 4) {
    const odd = twos.filter((p) => p === 1).length;
    if (Math.max(odd, twos.length - odd) >= 0.9 * twos.length) {
      return { op: 'core.manchester', half: true,
               why: 'runs are 1 or 2 lines long and the long ones all start on alternate lines, so a symbol is 2 lines' };
    }
  }
  const longest = Math.round(Math.max(...sym.map((r) => r.n)));
  return { op: 'core.nrz_slicer', why: `runs of 1 to ${longest} symbols, with no fixed pulse shape` };
}

/** RMS distance, in seconds, from each edge inside the grid to its nearest line. */
export function residual(g, edgeTimes) {
  let acc = 0, n = 0;
  const end = g.start + g.count * g.period;
  for (const t of edgeTimes) {
    if (t < g.start - g.period / 2 || t > end + g.period / 2) continue;
    const k = Math.round((t - g.start) / g.period);
    const d = t - (g.start + k * g.period);
    acc += d * d; n++;
  }
  return n ? Math.sqrt(acc / n) : null;
}

/** Every line's time, first to last: `count` symbols have `count + 1` boundaries. */
export function lines(g) {
  const out = [];
  for (let k = 0; k <= g.count; k++) out.push(g.start + k * g.period);
  return out;
}

/** Slide the whole grid by `dt` seconds. Moving it by hand makes it a hand grid. */
export function move(g, dt) { return { ...g, start: g.start + dt, mode: 'hand' }; }

/** Drag the last line to `end`, keeping the first where it is and the count the same. */
export function stretch(g, end) {
  const width = Math.max(g.count * 1e-9, end - g.start);
  return { ...g, period: width / g.count, mode: 'hand' };
}

/** A different number of symbols over the same width: the scroll wheel and the pinch. */
export function setCount(g, count) {
  const n = Math.max(1, Math.min(4096, Math.round(count)));
  return { ...g, count: n, period: (g.count * g.period) / n, mode: 'hand' };
}

/** A hand grid with `count` symbols across a box, for when there was nothing to measure. */
export function handGrid(t0, t1, count = 8) {
  return { start: t0, period: (t1 - t0) / count, count, mode: 'hand' };
}

export function fmtUs(s) {
  const us = s * 1e6;
  return us >= 1000 ? `${(us / 1e3).toFixed(us >= 1e5 ? 1 : 2)} ms` : `${us.toFixed(us >= 100 ? 1 : 2)} µs`;
}

/** "24 symbols · 416.0 µs · 2404 Bd" */
export function describe(g) {
  const bd = 1 / g.period;
  return `${g.count} symbol${g.count === 1 ? '' : 's'} · ${fmtUs(g.period)} · ` +
    `${bd >= 1e4 ? `${(bd / 1e3).toFixed(1)} kBd` : `${bd.toFixed(bd >= 100 ? 0 : 1)} Bd`}`;
}

/**
 * How many grid periods make one of `op`'s symbols: two for Manchester when the grid was
 * fitted to its edges, which come every half symbol.
 */
export function scaleFor(g, op) {
  return op === 'core.manchester' && g.kind !== 'manchester' ? 2 : 1;
}

/**
 * What "use this" writes into a slicer's symbol period: the value, its mode, and where it
 * came from. A hand grid pins the value; an auto grid leaves the slicer auto but points it
 * at the box, so it measures there with its own estimator.
 */
export function handoff(g, scale = 1) {
  const us = +(g.period * scale * 1e6).toFixed(2);
  const width = g.count * g.period;
  if (g.mode === 'hand') {
    return { value: us, mode: 'manual',
             extra: { from: `set by hand: ${g.count / scale} symbols over ${fmtUs(width)}` } };
  }
  return { value: us, mode: 'auto',
           extra: { from: `the symbol grid — ${g.from}`, span: { t0: g.start, t1: g.start + width } } };
}
