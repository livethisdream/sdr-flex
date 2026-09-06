// Signal processing for the M0 mock engine.
//
// Everything here is honest DSP on real samples — the toy decodes an actual
// bit pattern out of an actual OOK burst. It is small and unoptimised because
// the mock exists to test how the workflow feels, not to be fast (ADR-0021).

// ── FFT ────────────────────────────────────────────────────────────────────
const twiddleCache = new Map();

function twiddles(n) {
  let t = twiddleCache.get(n);
  if (t) return t;
  const cos = new Float32Array(n / 2);
  const sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n);
    sin[i] = Math.sin((-2 * Math.PI * i) / n);
  }
  t = { cos, sin };
  twiddleCache.set(n, t);
  return t;
}

/** In-place iterative radix-2 FFT over interleaved [re, im, re, im, ...]. */
export function fft(buf) {
  const n = buf.length / 2;
  const { cos, sin } = twiddles(n);

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let a = i * 2, b = j * 2;
      let tr = buf[a], ti = buf[a + 1];
      buf[a] = buf[b]; buf[a + 1] = buf[b + 1];
      buf[b] = tr; buf[b + 1] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wi = k * step;
        const wr = cos[wi], wim = sin[wi];
        const a = (i + k) * 2;
        const b = (i + k + len / 2) * 2;
        const xr = buf[b] * wr - buf[b + 1] * wim;
        const xi = buf[b] * wim + buf[b + 1] * wr;
        buf[b] = buf[a] - xr;
        buf[b + 1] = buf[a + 1] - xi;
        buf[a] += xr;
        buf[a + 1] += xi;
      }
    }
  }
  return buf;
}

// ── Windows ────────────────────────────────────────────────────────────────
export const WINDOWS = ['Hann', 'Hamming', 'Blackman', 'Rect'];
const windowCache = new Map();

export function windowFn(name, n) {
  const key = name + ':' + n;
  let w = windowCache.get(key);
  if (w) return w;
  w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (2 * Math.PI * i) / (n - 1);
    switch (name) {
      case 'Hamming':  w[i] = 0.54 - 0.46 * Math.cos(x); break;
      case 'Blackman': w[i] = 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x); break;
      case 'Rect':     w[i] = 1; break;
      default:         w[i] = 0.5 * (1 - Math.cos(x)); break; // Hann
    }
  }
  windowCache.set(key, w);
  return w;
}

/**
 * Power spectrum in dBFS, DC-centered, of interleaved IQ.
 * Returns Float32Array(bins).
 */
export function spectrum(iq, bins, windowName, out) {
  const w = windowFn(windowName, bins);
  const buf = new Float32Array(bins * 2);
  for (let i = 0; i < bins; i++) {
    buf[i * 2] = iq[i * 2] * w[i];
    buf[i * 2 + 1] = iq[i * 2 + 1] * w[i];
  }
  fft(buf);

  const res = out && out.length === bins ? out : new Float32Array(bins);
  const half = bins / 2;
  const norm = 1 / bins;
  for (let i = 0; i < bins; i++) {
    // fftshift: negative frequencies first
    const src = i < half ? i + half : i - half;
    const re = buf[src * 2] * norm;
    const im = buf[src * 2 + 1] * norm;
    const p = re * re + im * im;
    res[i] = 10 * Math.log10(p + 1e-20);
  }
  return res;
}

// ── Filter design ──────────────────────────────────────────────────────────
/** Windowed-sinc low-pass. cutoff and fs in Hz. */
export function lowPassTaps(numTaps, cutoffHz, fs) {
  if (numTaps % 2 === 0) numTaps += 1;
  const taps = new Float32Array(numTaps);
  const fc = cutoffHz / fs;              // normalized, cycles/sample
  const mid = (numTaps - 1) / 2;
  const w = windowFn('Hann', numTaps);
  let sum = 0;
  for (let i = 0; i < numTaps; i++) {
    const k = i - mid;
    const sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    taps[i] = sinc * w[i];
    sum += taps[i];
  }
  for (let i = 0; i < numTaps; i++) taps[i] /= sum;   // unity DC gain
  return taps;
}

/**
 * Frequency-translating FIR filter + decimator — the Tuner, in one function.
 * Mixes `offsetHz` down to DC, low-pass filters, and keeps every `decim`th sample.
 *
 * `iq` must contain (count * decim + taps.length) input samples.
 * `startPhase` keeps the mixer continuous across calls.
 */
export function xlateFilterDecimate(iq, taps, offsetHz, fs, decim, count, startPhase = 0) {
  const nt = taps.length;
  const out = new Float32Array(count * 2);
  const dphi = (-2 * Math.PI * offsetHz) / fs;

  // Mix by rotating a running phasor rather than calling cos/sin per sample. A
  // narrow channel needs count*decim input samples — half a million for a 1 kHz
  // channel off a 480 kS/s source — and two transcendentals apiece locked the
  // page solid. The recurrence is one complex multiply; drift is corrected every
  // few thousand samples, which is far more often than it needs.
  const need = count * decim + nt;
  const mixed = new Float32Array(need * 2);
  const rc = Math.cos(dphi), rs = Math.sin(dphi);
  let pc = Math.cos(startPhase), ps = Math.sin(startPhase);
  for (let i = 0; i < need; i++) {
    const re = iq[i * 2], im = iq[i * 2 + 1];
    mixed[i * 2] = re * pc - im * ps;
    mixed[i * 2 + 1] = re * ps + im * pc;
    const npc = pc * rc - ps * rs;
    ps = pc * rs + ps * rc;
    pc = npc;
    if ((i & 4095) === 4095) {
      const m = Math.hypot(pc, ps) || 1;    // renormalize away accumulated drift
      pc /= m; ps /= m;
    }
  }

  for (let o = 0; o < count; o++) {
    const base = o * decim;
    let ar = 0, ai = 0;
    for (let t = 0; t < nt; t++) {
      const k = (base + t) * 2;
      ar += mixed[k] * taps[t];
      ai += mixed[k + 1] * taps[t];
    }
    out[o * 2] = ar;
    out[o * 2 + 1] = ai;
  }
  return { samples: out, phase: startPhase + dphi * (count * decim) };
}

/** Pick a decimation that lands at or below the target rate, favouring small factors. */
/**
 * Work per display frame scales with `bins * decim`, so decimation is capped.
 * Past this the toy would read a million input samples to draw one row; a real
 * engine would cascade half-band stages instead of one long filter.
 */
export const MAX_DECIM = 96;

export function chooseDecimation(fs, targetRate) {
  const max = Math.max(1, Math.min(MAX_DECIM, Math.floor(fs / targetRate)));
  for (let d = max; d >= 1; d--) {
    let n = d, ok = true;
    for (const p of [2, 3, 5, 7]) while (n % p === 0) n /= p;
    if (n === 1) { ok = true; } else { ok = false; }
    if (ok) return d;
  }
  return Math.max(1, max);
}

// ── Demodulation ───────────────────────────────────────────────────────────
export function amEnvelope(iq, count) {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const re = iq[i * 2], im = iq[i * 2 + 1];
    out[i] = Math.sqrt(re * re + im * im);
  }
  return out;
}

/**
 * Post-detection low-pass — the filter every real AM demodulator has after the
 * rectifier. Without it the envelope rattles across the slice threshold and every
 * run-length measurement is noise.
 */
export function smooth(x, win) {
  const n = x.length;
  const w = Math.max(1, Math.min(win | 0, n));
  const out = new Float32Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += x[i];
    if (i >= w) acc -= x[i - w];
    out[i] = acc / Math.min(i + 1, w);
  }
  // undo the half-window group delay so edges stay where they were
  const shift = (w / 2) | 0;
  if (shift > 0) {
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) s[i] = out[Math.min(n - 1, i + shift)];
    return s;
  }
  return out;
}

/** Default post-detection window: 40 µs, well below any symbol period we care about. */
export function envelopeWindow(sampleRate) {
  return Math.max(2, Math.round(sampleRate * 40e-6));
}

/** Otsu threshold over a real envelope — the `⟲ auto` estimator for a slicer. */
export function otsuThreshold(x) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < x.length; i++) { if (x[i] < lo) lo = x[i]; if (x[i] > hi) hi = x[i]; }
  if (!(hi > lo)) return { value: 0.5, hist: new Float32Array(48), lo: 0, hi: 1 };

  const nb = 48;
  const hist = new Float32Array(nb);
  for (let i = 0; i < x.length; i++) {
    let b = Math.floor(((x[i] - lo) / (hi - lo)) * (nb - 1));
    hist[b] += 1;
  }
  let total = x.length, sum = 0;
  for (let i = 0; i < nb; i++) sum += i * hist[i];

  let sumB = 0, wB = 0, best = -1, bestT = nb / 2;
  for (let i = 0; i < nb; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; bestT = i; }
  }
  return { value: lo + ((bestT + 0.5) / nb) * (hi - lo), hist, lo, hi };
}

/**
 * Estimate the symbol period from run lengths in a sliced envelope.
 * Returns microseconds plus the run-length histogram that justifies it —
 * auto has to be able to show its work (ADR-0017).
 */
export function highRuns(env, threshold, minLen = 3) {
  const runs = [];
  let len = 0;
  for (let i = 0; i < env.length; i++) {
    if (env[i] > threshold) { len++; }
    else { if (len >= minLen) runs.push(len); len = 0; }
  }
  if (len >= minLen) runs.push(len);
  return runs;
}

/**
 * Symbol period from the distribution of *pulse* lengths.
 *
 * In OOK/PWM a high pulse is either one symbol (a zero) or two (a one), so the
 * lengths form two clusters and the lower one is the symbol. A low percentile of
 * the high runs finds it robustly; the histogram is returned because auto has to
 * be able to show its work (ADR-0017).
 */
export function estimateSymbolPeriod(env, threshold, sampleRate) {
  const runs = highRuns(env, threshold, Math.max(3, Math.round(sampleRate * 20e-6)));
  const nb = 40;
  if (runs.length < 4) return { value: 0, hist: new Float32Array(nb), runs: [], confident: false };

  const sorted = [...runs].sort((a, b) => a - b);
  // rough guess, then average the cluster around it — a flat percentile lands on
  // the short edge of the cluster and reads a few percent low
  const guess = sorted[Math.floor(sorted.length * 0.2)];
  let acc = 0, n = 0;
  for (const r of sorted) if (r > guess * 0.6 && r < guess * 1.4) { acc += r; n++; }
  const short = n ? acc / n : guess;
  const us = (short / sampleRate) * 1e6;

  const maxRun = sorted[sorted.length - 1];
  const hist = new Float32Array(nb);
  for (const r of sorted) hist[Math.min(nb - 1, Math.floor((r / maxRun) * (nb - 1)))] += 1;

  // two clean clusters ⇒ trust it; one blurred cluster ⇒ say so
  const longer = sorted[Math.floor(sorted.length * 0.85)];
  const ratio = longer / Math.max(1, short);
  return {
    value: us, hist, runs: sorted, confident: ratio > 1.5 && ratio < 3.2,
    maxRunUs: (maxRun / sampleRate) * 1e6,
  };
}

/** PWM/OOK slicer: one symbol period per bit, long pulse = 1. */
/**
 * Slice an envelope into bursts of bits, each located in the sample stream so the
 * display can say *when* it happened rather than just what it said.
 * Returns [{ bits, start, end }].
 */
export function pwmSlice(env, threshold, sampleRate, symbolUs) {
  const sps = Math.max(2, Math.round((symbolUs * 1e-6) * sampleRate));
  const minRun = Math.max(2, Math.round(sps * 0.35));
  const gapEnd = sps * 5;
  const groups = [];
  let cur = null;
  let i = 0;

  // a window that opens mid-pulse caught a burst already in progress; that group
  // is partial by construction, so skip to the first clean gap
  if (env[0] > threshold) {
    while (i < env.length && env[i] > threshold) i++;
  }

  while (i < env.length) {
    if (env[i] > threshold) {
      const pulseStart = i;
      let run = 0;
      while (i + run < env.length && env[i + run] > threshold) run++;
      i += run;
      if (run < minRun) continue;                      // noise blip, not a pulse
      if (!cur) cur = { bits: [], start: pulseStart, end: i };
      cur.bits.push(run > sps * 1.5 ? 1 : 0);
      cur.end = i;
      let gap = 0;
      while (i + gap < env.length && env[i + gap] <= threshold) gap++;
      i += gap;
      if (gap > gapEnd) { groups.push(cur); cur = null; }
    } else { i++; }
  }
  if (cur && cur.bits.length) groups.push(cur);
  return groups;
}

/**
 * Find the most recent burst in an envelope — the trigger every oscilloscope has.
 * Without one the display free-runs and a 40 ms burst is gone before you can read it.
 */
export function findLastBurst(env, sampleRate) {
  let hi = 0;
  for (let i = 0; i < env.length; i++) if (env[i] > hi) hi = env[i];
  if (hi <= 0) return null;
  const thr = hi * 0.3;
  const quiet = Math.round(sampleRate * 0.01);         // 10 ms of silence ends a burst

  let end = -1;
  for (let i = env.length - 1; i >= 0; i--) if (env[i] > thr) { end = i; break; }
  if (end < 0) return null;

  let start = end, run = 0;
  for (let i = end; i >= 0; i--) {
    if (env[i] > thr) { start = i; run = 0; }
    else if (++run > quiet) break;
  }
  return { start, end };
}
