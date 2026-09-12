// Signal processing for the M0 mock engine.
//
// Everything here is honest DSP on real samples — the toy decodes an actual
// bit pattern out of an actual OOK burst. It is small and unoptimized because
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
 * FM: the instantaneous frequency, in hertz, as the phase advance per sample.
 *
 * The cross-product form — Im{x[n] · conj(x[n-1])} over |x|² — is the same quantity
 * atan2 would give for small excursions, without an atan2 per sample. Narrowband FM
 * never leaves the small-angle region, and the arctangent version's advantage
 * (correctness near ±π) is only reachable when the deviation approaches half the
 * channel rate, which would mean the tuner was set wrong.
 */
export function fmDiscriminate(iq, count, sampleRate) {
  const out = new Float32Array(count);
  const k = sampleRate / (2 * Math.PI);
  let pr = iq[0], pi = iq[1];
  for (let i = 1; i < count; i++) {
    const re = iq[i * 2], im = iq[i * 2 + 1];
    const cr = re * pr + im * pi;          // real part of x[n]·conj(x[n-1])
    const ci = im * pr - re * pi;          // imaginary part
    const mag = cr * cr + ci * ci;
    out[i] = mag > 1e-20 ? k * Math.atan2(ci, cr) : 0;
    pr = re; pi = im;
  }
  out[0] = out[1] || 0;
  return out;
}

/**
 * Hilbert transformer taps: odd length, antisymmetric, windowed. The companion
 * path has to be delayed by (n-1)/2 to line up, which `ssbDemod` does.
 */
export function hilbertTaps(numTaps) {
  const n = numTaps | 1;                    // must be odd for a centered delay
  const mid = (n - 1) / 2;
  const h = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const k = i - mid;
    if (k === 0 || k % 2 === 0) { h[i] = 0; continue; }
    // Hamming, so the passband ripple does not put a tilt across the audio
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
    h[i] = (2 / (Math.PI * k)) * w;
  }
  return h;
}

/**
 * SSB by the phasing method: audio = I ∓ H{Q}, minus for upper sideband and plus
 * for lower. The tuner ahead of this passes both sides symmetrically, so choosing a
 * sideband is a step of its own rather than something the filter already did.
 *
 * `bfoHz` shifts the passband before the decision, which is what the tuning knob on
 * an SSB receiver actually does — get it wrong and voices sound like ducks.
 */
export function ssbDemod(iq, count, sampleRate, sideband = 'usb', bfoHz = 0, taps = null) {
  const h = taps || hilbertTaps(65);
  const n = h.length, mid = (n - 1) / 2;
  const sign = sideband === 'lsb' ? 1 : -1;
  const out = new Float32Array(count);

  // mix first, so the Hilbert transformer always sees the band it was designed for
  const dphi = (-2 * Math.PI * bfoHz) / sampleRate;
  const rc = Math.cos(dphi), rs = Math.sin(dphi);
  let pc = 1, ps = 0;
  const I = new Float32Array(count), Q = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const re = iq[i * 2], im = iq[i * 2 + 1];
    I[i] = re * pc - im * ps;
    Q[i] = re * ps + im * pc;
    const npc = pc * rc - ps * rs;
    ps = pc * rs + ps * rc; pc = npc;
    if ((i & 4095) === 4095) { const m = Math.hypot(pc, ps) || 1; pc /= m; ps /= m; }
  }

  for (let i = 0; i < count; i++) {
    let hq = 0;
    const base = i - n + 1;
    if (base >= 0) for (let t = 0; t < n; t++) hq += Q[base + t] * h[n - 1 - t];
    const di = i - mid;
    out[i] = (di >= 0 ? I[di] : 0) + sign * hq;
  }
  return out;
}

/**
 * CW: there is nothing to demodulate. A keyed carrier is inaudible on its own, so a
 * receiver beats it against a local oscillator and you listen to the difference.
 * `offsetHz` is where the carrier actually sits (rarely dead center); `pitchHz` is
 * where you want to hear it, which is a preference, not a measurement.
 */
export function cwBeat(iq, count, sampleRate, offsetHz, pitchHz) {
  const out = new Float32Array(count);
  const dphi = (2 * Math.PI * (pitchHz - offsetHz)) / sampleRate;
  const rc = Math.cos(dphi), rs = Math.sin(dphi);
  let pc = 1, ps = 0;
  for (let i = 0; i < count; i++) {
    const re = iq[i * 2], im = iq[i * 2 + 1];
    out[i] = re * pc - im * ps;              // real part of x · e^{jΔω n}
    const npc = pc * rc - ps * rs;
    ps = pc * rs + ps * rc; pc = npc;
    if ((i & 4095) === 4095) { const m = Math.hypot(pc, ps) || 1; pc /= m; ps /= m; }
  }
  return out;
}

// ── Estimators for the detectors ───────────────────────────────────────────

/**
 * Peak deviation, straight off the discriminator rather than out of Carson's rule.
 *
 * Carson runs backwards from occupied bandwidth and needs the modulating frequency,
 * which is the thing you do not know. The instantaneous frequency is already in
 * hand; a high percentile of its magnitude is the deviation, and a percentile rather
 * than the maximum because one noisy sample should not set the scale.
 */
export function estimateDeviation(iq, count, sampleRate) {
  const f = fmDiscriminate(iq, count, sampleRate);
  const mag = Array.from(f.subarray(1), Math.abs).sort((a, b) => a - b);
  if (!mag.length) return { value: 3000, confident: false };
  const p98 = mag[Math.min(mag.length - 1, Math.floor(mag.length * 0.98))];
  const med = mag[mag.length >> 1];

  // What separates a modulated carrier from noise is that its excursion is
  // *bounded*: the instantaneous frequency stays in a narrow band, while noise
  // sprays across the whole channel and drags a long tail behind it.
  //
  // The tempting test — peak well above the median — is exactly backwards. A single
  // tone at full deviation gives a ratio of about 1/0.64, because the mean of |sin|
  // is 2/π; noise gives a much larger one. Anything demanding a big ratio rejects
  // the clean signals and accepts the noise.
  const nyquist = sampleRate / 2;
  return {
    value: p98,
    medianHz: med,
    confident: p98 > 200 && p98 < nyquist * 0.4 && p98 < med * 4,
  };
}

/**
 * Which sideband a channel is carrying, by comparing the energy above and below its
 * center. A sideband is not a setting you can derive from first principles — but an
 * 8 dB asymmetry is not an accident either, and saying which way it leans and by how
 * much is more useful than defaulting to USB and staying quiet about it.
 */
export function estimateSideband(iq, count, bins = 1024) {
  const n = Math.min(count, bins);
  const sp = spectrum(iq, n, 'Hann');
  let lo = 0, hi = 0;
  const half = n / 2;
  const guard = Math.max(1, Math.round(n * 0.01));       // ignore DC and its skirt
  for (let i = 0; i < half - guard; i++) lo += Math.pow(10, sp[i] / 10);
  for (let i = half + guard; i < n; i++) hi += Math.pow(10, sp[i] / 10);
  const ratioDb = 10 * Math.log10((hi + 1e-20) / (lo + 1e-20));
  return { value: ratioDb >= 0 ? 'usb' : 'lsb', ratioDb, confident: Math.abs(ratioDb) > 3 };
}

/**
 * How far the strongest thing in the channel sits from its center. For CW this is
 * the carrier, and knowing it is what lets the beat note land on the pitch asked for
 * instead of wherever the tuner happened to leave it.
 */
export function estimateCarrierOffset(iq, count, sampleRate, bins = 1024) {
  const n = Math.min(count, bins);
  const sp = spectrum(iq, n, 'Hann');
  let best = -Infinity, at = n / 2;
  for (let i = 0; i < n; i++) if (sp[i] > best) { best = sp[i]; at = i; }
  // parabolic interpolation, so the answer is not quantized to a bin
  const l = sp[Math.max(0, at - 1)], r = sp[Math.min(n - 1, at + 1)];
  const denom = l - 2 * best + r;
  const frac = denom !== 0 ? (0.5 * (l - r)) / denom : 0;
  const offsetHz = ((at + frac) - n / 2) * (sampleRate / n);
  // a carrier stands out; noise does not
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.pow(10, sp[i] / 10);
  const meanDb = 10 * Math.log10(sum / n + 1e-20);
  return { value: offsetHz, confident: best - meanDb > 12, snrDb: best - meanDb };
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

/**
 * The range a histogram should cover: the bulk of the data, not its extremes.
 *
 * Half a percent trimmed from each end, estimated from a subsample so this stays cheap on
 * a span of millions. A distribution with genuine outliers keeps them — they are simply
 * not allowed to set the scale.
 */
function robustRange(x, trim = 0.005) {
  const n = x.length;
  if (!n) return { lo: 0, hi: 1 };
  const want = Math.min(n, 1 << 16);
  const stride = Math.max(1, Math.floor(n / want));
  const sample = new Float64Array(Math.ceil(n / stride));
  for (let i = 0, k = 0; i < n; i += stride, k++) sample[k] = x[i];
  sample.sort();
  const a = Math.floor(sample.length * trim);
  const b = Math.max(a, sample.length - 1 - a);
  let lo = sample[a], hi = sample[b];
  if (!(hi > lo)) { lo = sample[0]; hi = sample[sample.length - 1]; }
  return { lo, hi };
}

/**
 * Where the energy is, over time and frequency.
 *
 * One FFT per step, keeping only the strongest bin and how far above the floor it is.
 * That is a deliberate reduction: a hopper puts everything in one channel at a time, so
 * the peak *is* the signal, and keeping the whole spectrogram to find it would be a
 * hundred times the memory for the same answer.
 */
export function peakTrack(iq, count, sampleRate, { bins = 256, step = 128 } = {}) {
  const steps = Math.max(0, Math.floor((count - bins) / step) + 1);
  const hz = new Float32Array(steps);
  const db = new Float32Array(steps);
  const snr = new Float32Array(steps);
  const win = new Float32Array(bins * 2);
  const scratch = new Float32Array(bins);
  for (let s = 0; s < steps; s++) {
    const at = s * step;
    win.set(iq.subarray(at * 2, (at + bins) * 2));
    const sp = spectrum(win, bins, 'Hann');
    scratch.set(sp.subarray(0, bins));
    let best = -Infinity, bi = 0;
    for (let i = 0; i < bins; i++) if (sp[i] > best) { best = sp[i]; bi = i; }
    hz[s] = (bi - bins / 2) * (sampleRate / bins);
    db[s] = best;
    // How far the peak stands above the rest of its own step. This, and not the absolute
    // level, is what says whether there is a signal here: it does not care what the
    // receiver's gain was, and — the part that matters — it still works when the
    // transmitter never stops. A hopper that dwells back to back has no quiet steps to
    // compare against, and a threshold derived from the level distribution alone then
    // splits a single population down the middle and calls half of it noise.
    snr[s] = best - medianOf(scratch);
  }
  return { hz, db, snr, steps, stepS: step / sampleRate, binHz: sampleRate / bins };
}

/**
 * A frequency hopper's dwells, and the channel set it is walking.
 *
 * Runs of consecutive time steps whose peak sits in the same place. Everything the node
 * shows is derived here and comes with the evidence for it (ADR-0017): the dwell is the
 * median run length, the spacing is the median gap between the channels actually used,
 * and the confidence is how much of the signal agrees with those two numbers. A hopper
 * whose dwells are all different lengths is not a hopper, and saying so is the useful
 * answer.
 */
export function findHops(iq, count, sampleRate, { bins = 256, step = 128, minSteps = 2 } = {}) {
  const track = peakTrack(iq, count, sampleRate, { bins, step });
  if (track.steps < 4) return { hops: [], channels: [], confident: false, reason: 'too short to look at' };

  // Is there a signal in this step? Six decibels above the median bin of the same step.
  // A fixed number rather than a derived one, on purpose: the alternative is deriving a
  // threshold from a distribution that has only one population in it whenever the
  // transmitter never stops, and Otsu will always find somewhere to cut.
  const SNR_DB = 6;
  const lit = [];
  for (let i = 0; i < track.steps; i++) if (track.snr[i] > SNR_DB) lit.push(i);
  if (lit.length < 4) return { hops: [], channels: [], confident: false, reason: 'almost nothing above the noise' };

  // The channel set comes first, before any grouping in time — and that ordering is the
  // whole trick. Grouping by "the peak has not moved much" looks obvious and is wrong:
  // the modulation inside a channel moves the peak too. An FSK payload with a 2.4 kHz
  // shift broke every dwell into pieces at each bit transition, turning 24 dwells into 65.
  //
  // So: cluster the peak frequencies, decide what a channel *is*, and only then ask which
  // consecutive steps are in the same one.
  const channels = clusterChannels(lit.map((i) => track.hz[i]), track.binHz);
  if (channels.length < 1) return { hops: [], channels: [], confident: false, reason: 'no channel stood out' };

  const nearest = (hz) => {
    let best = 0;
    for (let c = 1; c < channels.length; c++) {
      if (Math.abs(hz - channels[c]) < Math.abs(hz - channels[best])) best = c;
    }
    return best;
  };
  const chan = new Int16Array(track.steps).fill(-1);
  for (const i of lit) chan[i] = nearest(track.hz[i]);

  const hops = [];
  let i = 0;
  while (i < track.steps) {
    if (chan[i] < 0) { i++; continue; }
    const c = chan[i];
    let j = i, peak = -Infinity;
    while (j < track.steps && chan[j] === c) { peak = Math.max(peak, track.db[j]); j++; }
    if (j - i >= minSteps) {
      hops.push({ t0: i * track.stepS, t1: j * track.stepS, hz: channels[c], channel: c,
                  db: peak, steps: j - i });
    }
    i = j;
  }
  if (hops.length < 2) return { hops, channels, confident: false, reason: 'fewer than two dwells' };

  // A hop sequence visits the same channel twice in a row sooner or later, and back to
  // back those two dwells are one unbroken stretch of the same frequency — there is
  // nothing in the signal to tell them apart until you know how long a dwell is. So:
  // measure the dwell from the runs that are not merged, then split the ones that are.
  let dwell0 = median(hops.map((h) => h.t1 - h.t0));
  for (let i = hops.length - 1; i >= 0; i--) {
    const h = hops[i];
    const parts = Math.round((h.t1 - h.t0) / dwell0);
    if (parts < 2) continue;
    const each = (h.t1 - h.t0) / parts;
    const split = [];
    for (let k = 0; k < parts; k++) {
      split.push({ ...h, t0: h.t0 + k * each, t1: h.t0 + (k + 1) * each, steps: h.steps / parts });
    }
    hops.splice(i, 1, ...split);
  }

  // And close the seams. One analysis step straddles every boundary and belongs to
  // neither channel cleanly; left as a gap it is a symbol or two of signal that de-hopping
  // would not correct, which is a hole in the middle of the payload.
  for (let i = 1; i < hops.length; i++) {
    const gap = hops[i].t0 - hops[i - 1].t1;
    if (gap > 0 && gap <= track.stepS * 2.5) {
      const mid = (hops[i - 1].t1 + hops[i].t0) / 2;
      hops[i - 1].t1 = mid;
      hops[i].t0 = mid;
    }
  }

  // The boundaries so far are only known to one analysis step, and that is not good
  // enough to de-hop with. A step is a symbol or two; correcting those samples by the
  // wrong channel's frequency is a 25 kHz error against a 2.4 kHz deviation, which does
  // not degrade the symbols so much as obliterate them — 650 samples of the payload came
  // back at twenty times full scale before this existed.
  //
  // The instantaneous frequency finds the edge to within a few samples. It is the channel
  // offset plus the modulation, and the modulation is an order of magnitude smaller than
  // the channel spacing, so the midpoint between two channels is a threshold nothing else
  // goes near.
  refineEdges(iq, count, sampleRate, hops, track.stepS);

  const dwellS = median(hops.map((h) => h.t1 - h.t0));
  const spacingHz = channels.length > 1
    ? median(channels.slice(1).map((c, k) => c - channels[k])) : 0;
  // How much of it agrees. Two dwells that happen to be the same length prove nothing;
  // forty that agree to within a quarter are a dwell time.
  const agree = hops.filter((h) => Math.abs((h.t1 - h.t0) - dwellS) <= dwellS * 0.25).length / hops.length;
  return {
    hops, channels, dwellS, spacingHz,
    agreement: agree,
    confident: hops.length >= 6 && agree > 0.8 && channels.length > 1,
    stepS: track.stepS, binHz: track.binHz, snrDb: SNR_DB,
  };
}

/**
 * The period a signal repeats at, found by correlating it with itself.
 *
 * Normalized, so the answer does not depend on the level, and refined by a parabola
 * through the peak and its neighbors — a raster line is rarely a whole number of samples,
 * and a period rounded to the nearest sample shears the picture a little more with every
 * line until it is unreadable halfway down.
 */
export function estimatePeriod(x, { minLag, maxLag, maxSamples = 1 << 19 }) {
  const n = Math.min(x.length, maxSamples);
  const hi = Math.min(maxLag, Math.floor(n / 3));
  if (hi <= minLag + 2) return { value: 0, confident: false, reason: 'nothing to correlate over' };

  // Mean removed: a video signal sits on a pedestal, and correlating the pedestal with
  // itself is a large number that says nothing.
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n;

  let e0 = 0;
  for (let i = 0; i < n; i++) { const v = x[i] - mean; e0 += v * v; }
  if (!(e0 > 0)) return { value: 0, confident: false, reason: 'a flat signal has no period' };

  const score = new Float32Array(hi + 1);
  let best = -Infinity, bestLag = 0;
  for (let lag = minLag; lag <= hi; lag++) {
    let acc = 0;
    const m = n - lag;
    for (let i = 0; i < m; i++) acc += (x[i] - mean) * (x[i + lag] - mean);
    const v = acc / (e0 * (m / n));
    score[lag] = v;
    if (v > best) { best = v; bestLag = lag; }
  }
  if (bestLag <= minLag || bestLag >= hi) {
    return { value: bestLag, confident: false, reason: 'the best match is at the edge of the search' };
  }

  // Sub-sample, through the peak and its two neighbors.
  const a = score[bestLag - 1], b = score[bestLag], c = score[bestLag + 1];
  const denom = a - 2 * b + c;
  const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  const lag = bestLag + Math.max(-1, Math.min(1, shift));

  // How much it stands out. A signal with no period still has a highest correlation
  // somewhere, and reporting that as a period is how a picture of noise gets drawn.
  let sum = 0, k = 0;
  for (let i = minLag; i <= hi; i++) { sum += score[i]; k++; }
  const mean2 = sum / (k || 1);
  return { value: lag, peak: best, background: mean2, contrast: best - mean2,
           confident: best > 0.3 && best - mean2 > 0.15, score, minLag, maxLag: hi };
}

/**
 * Fold a signal into a picture, one row per period.
 *
 * Each row is resampled onto `cols` columns at its own fractional start, because the
 * period is fractional: taking `round(period)` samples per row accumulates a fraction of
 * a sample every line and the image shears.
 */
export function foldRaster(x, count, period, { cols = 0, maxRows = 1024, from = 0 } = {}) {
  const width = cols || Math.max(2, Math.round(period));
  const rows = Math.min(maxRows, Math.floor((count - from) / period));
  if (rows < 1) return { rows: 0, cols: width, data: new Float32Array(0) };
  const data = new Float32Array(rows * width);
  for (let r = 0; r < rows; r++) {
    const base = from + r * period;
    for (let c = 0; c < width; c++) {
      const at = base + (c / width) * period;
      const i0 = Math.floor(at);
      const f = at - i0;
      const a = i0 >= 0 && i0 < count ? x[i0] : 0;
      const b = i0 + 1 >= 0 && i0 + 1 < count ? x[i0 + 1] : 0;
      data[r * width + c] = a * (1 - f) + b * f;
    }
  }
  return { rows, cols: width, data };
}

/**
 * A raster: how long a line is, and how many lines make a frame.
 *
 * Two periods, found one after the other, because they are found differently. The line
 * period is the shortest thing the signal repeats at and falls straight out of an
 * autocorrelation. The frame is a *whole number of lines* — so rather than search the
 * autocorrelation again and risk landing on a lag that is not a multiple, only multiples
 * of the line period are scored.
 *
 * Averaging the frames is the point of finding the second one. A leak is a weak signal
 * and a still picture is the same frame over and over; adding them up is free signal.
 */
export function estimateRaster(x, count, sampleRate, {
  minLineUs = 4, maxLineUs = 2000, maxLines = 2048,
} = {}) {
  const minLag = Math.max(4, Math.round((minLineUs * 1e-6) * sampleRate));
  const maxLag = Math.round((maxLineUs * 1e-6) * sampleRate);
  const line = estimatePeriod(x, { minLag, maxLag });
  if (!line.value) return { ...line, lineSamples: 0, linesPerFrame: 0 };

  // Frames: score every whole number of lines, and keep the best that is not trivial.
  const P = line.value;
  let mean = 0;
  for (let i = 0; i < count; i++) mean += x[i];
  mean /= count || 1;
  let e0 = 0;
  for (let i = 0; i < count; i++) { const v = x[i] - mean; e0 += v * v; }

  let bestLines = 0, bestScore = -Infinity;
  const top = Math.min(maxLines, Math.floor(count / (P * 2)));
  for (let k = 2; k <= top; k++) {
    const lag = Math.round(k * P);
    if (lag >= count - 16) break;
    let acc = 0;
    const m = count - lag;
    for (let i = 0; i < m; i += 2) acc += (x[i] - mean) * (x[i + lag] - mean);
    const v = (acc * 2) / (e0 * (m / count));
    if (v > bestScore) { bestScore = v; bestLines = k; }
  }
  return {
    ...line,
    lineSamples: P,
    lineUs: (P / sampleRate) * 1e6,
    linesPerFrame: bestLines,
    frameScore: bestScore,
    // A frame is only worth claiming if the whole frame repeats about as well as a line
    // does. A still picture does; a signal that happens to be periodic at a line does not.
    frameConfident: bestLines > 2 && bestScore > 0.25,
  };
}

/**
 * OFDM's own structure, found without being told any of it.
 *
 * Every OFDM symbol carries a cyclic prefix: a copy of its own tail pasted in front. That
 * exists to absorb multipath, and it has a side effect that makes the whole scheme
 * findable — a stretch of samples that is identical to another stretch exactly one FFT
 * length later, recurring once per symbol. Nothing else in a signal does that.
 *
 * So: for each plausible FFT size, correlate the signal against itself at that lag, and
 * see whether the correlation peaks regularly. The lag that works is the FFT size, the
 * width of the peak is the prefix, and the spacing between peaks is the symbol period.
 * The subcarrier spacing and the symbol rate follow from those two numbers.
 */
export function estimateOfdm(iq, count, sampleRate, {
  sizes = [32, 64, 128, 256, 512, 1024, 2048], maxSamples = 1 << 18,
} = {}) {
  const n = Math.min(count, maxSamples);
  let best = null;
  for (const fftN of sizes) {
    if (n < fftN * 6) continue;                    // too few symbols to say anything
    const lim = n - fftN;
    // r[i] · conj(r[i + fftN]), and the energy of both, once per candidate size.
    const cr = new Float64Array(lim), ci = new Float64Array(lim), en = new Float64Array(lim);
    for (let i = 0; i < lim; i++) {
      const ar = iq[i * 2], ai = iq[i * 2 + 1];
      const br = iq[(i + fftN) * 2], bi = iq[(i + fftN) * 2 + 1];
      cr[i] = ar * br + ai * bi;
      ci[i] = ai * br - ar * bi;
      en[i] = ar * ar + ai * ai + br * br + bi * bi;
    }
    for (const div of [4, 8, 16, 32]) {
      const cpN = Math.round(fftN / div);
      if (cpN < 2) continue;
      const period = fftN + cpN;
      if (lim < period * 4) continue;

      // A sliding window the length of the prefix. Where it sits over the prefix the
      // correlation is coherent and the metric approaches one; anywhere else the phases
      // are unrelated and it falls to nothing.
      const m = new Float32Array(lim - cpN + 1);
      let sr = 0, si = 0, se = 0;
      for (let i = 0; i < cpN; i++) { sr += cr[i]; si += ci[i]; se += en[i]; }
      for (let i = 0; i + cpN <= lim; i++) {
        m[i] = se > 0 ? (2 * Math.hypot(sr, si)) / se : 0;
        if (i + cpN < lim) {
          sr += cr[i + cpN] - cr[i]; si += ci[i + cpN] - ci[i]; se += en[i + cpN] - en[i];
        }
      }

      // Does it peak once per symbol? Score every phase and keep the best.
      let bestPhase = 0, bestScore = -1;
      for (let p = 0; p < period; p++) {
        let acc = 0, k = 0;
        for (let i = p; i < m.length; i += period) { acc += m[i]; k++; }
        if (k >= 4 && acc / k > bestScore) { bestScore = acc / k; bestPhase = p; }
      }
      // Against the background: a candidate that scores well everywhere has found the
      // signal's average, not its structure.
      let mean = 0;
      for (let i = 0; i < m.length; i++) mean += m[i];
      mean /= m.length || 1;
      const contrast = bestScore - mean;
      if (!best || contrast > best.contrast) {
        best = { fftN, cpN, period, phase: bestPhase, peak: bestScore, mean, contrast };
      }
    }
  }
  if (!best) return { confident: false, reason: 'not enough signal to find a symbol in' };
  return {
    ...best,
    symbolS: best.period / sampleRate,
    spacingHz: sampleRate / best.fftN,
    symbols: Math.floor((count - best.phase) / best.period),
    // A real prefix correlates near one and the gaps between near zero. Half is generous
    // and still a long way from what an unstructured signal produces.
    confident: best.peak > 0.55 && best.contrast > 0.2,
  };
}

/**
 * The resource grid: one row per symbol, one column per subcarrier.
 *
 * Skip the prefix, transform what is left, and the amplitudes that come out are the
 * subcarriers as they were sent. In frequency order rather than FFT order, because a
 * person reading a grid expects the lowest frequency at one end.
 */
export function ofdmGrid(iq, count, est, { maxSymbols = 512 } = {}) {
  const { fftN, cpN, period, phase } = est;
  const symbols = Math.min(maxSymbols, Math.floor((count - phase - cpN) / period));
  if (symbols < 1) return { rows: 0, cols: fftN, data: new Float32Array(0) };
  const data = new Float32Array(symbols * fftN);
  const buf = new Float32Array(fftN * 2);
  const half = fftN / 2;
  for (let s = 0; s < symbols; s++) {
    // The prefix is a copy of the tail; the symbol proper starts after it.
    const at = phase + s * period + cpN;
    for (let i = 0; i < fftN; i++) {
      buf[i * 2] = iq[(at + i) * 2];
      buf[i * 2 + 1] = iq[(at + i) * 2 + 1];
    }
    fft(buf);
    for (let k = 0; k < fftN; k++) {
      const src = k < half ? k + half : k - half;     // fftshift into frequency order
      data[s * fftN + k] = Math.hypot(buf[src * 2], buf[src * 2 + 1]) / fftN;
    }
  }
  return { rows: symbols, cols: fftN, data };
}

/**
 * Move each dwell boundary to where the frequency actually changes.
 *
 * Only where two dwells meet: an edge with silence on one side of it is where the
 * transmitter stopped, which the energy detector already located as well as anything can.
 */
function refineEdges(iq, count, sampleRate, hops, stepS) {
  if (hops.length < 2) return;
  const inst = smooth(fmDiscriminate(iq, count, sampleRate), 8);
  const win = Math.ceil(stepS * sampleRate * 1.5);
  for (let i = 1; i < hops.length; i++) {
    const a = hops[i - 1], b = hops[i];
    if (Math.abs(b.t0 - a.t1) > 1e-9) continue;        // not touching: real dead air
    if (a.channel === b.channel) continue;             // a split, not an edge
    const mid = (a.hz + b.hz) / 2;
    const at = Math.round(a.t1 * sampleRate);
    const rising = b.hz > a.hz;
    let best = -1, bestD = Infinity;
    for (let k = Math.max(1, at - win); k < Math.min(count, at + win); k++) {
      const was = inst[k - 1] < mid, now = inst[k] < mid;
      if (was === now) continue;
      if ((rising && was && !now) || (!rising && !was && now)) {
        const d = Math.abs(k - at);
        if (d < bestD) { bestD = d; best = k; }
      }
    }
    if (best > 0) { a.t1 = best / sampleRate; b.t0 = a.t1; }
  }
}

/**
 * Which frequencies are the same channel, without being told how many there are.
 *
 * Sort them and look at the gaps. Within a channel the gaps are tiny — the same bin over
 * and over, give or take the modulation. Between channels there is one large gap per
 * boundary. Those are two populations, so Otsu separates them the same way it separates
 * a signal from a floor, and nobody has to supply a channel count or a spacing.
 */
export function clusterChannels(freqs, binHz) {
  if (!freqs.length) return [];
  const sorted = Float64Array.from(freqs).sort();
  if (sorted.length < 3) return [mean(sorted)];

  const gaps = new Float32Array(sorted.length - 1);
  for (let i = 1; i < sorted.length; i++) gaps[i - 1] = sorted[i] - sorted[i - 1];
  const split = otsuThreshold(gaps);
  // A floor under it, because a single channel has no large gaps at all and Otsu will
  // still find a threshold somewhere in the noise if you let it.
  const cut = Math.max(split.value, binHz * 2);

  const out = [];
  let start = 0;
  for (let i = 0; i < gaps.length; i++) {
    if (gaps[i] > cut) { out.push(mean(sorted.subarray(start, i + 1))); start = i + 1; }
  }
  out.push(mean(sorted.subarray(start)));
  return out;
}

const mean = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / (a.length || 1); };

/** The median of a spectrum slice, used as "what everything else in this step looks like". */
function medianOf(a) {
  const c = Float32Array.from(a).sort();
  const m = c.length >> 1;
  return c.length % 2 ? c[m] : (c[m - 1] + c[m]) / 2;
}

function median(xs) {
  if (!xs.length) return 0;
  const a = Float64Array.from(xs).sort();
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Otsu threshold over a real envelope — the `⟲ auto` estimator for a slicer. */
export function otsuThreshold(x) {
  // The histogram is ranged by percentile, not by minimum and maximum.
  //
  // Min and max are the obvious choice and one outlier ruins them. A de-hopped stream
  // with seven bad samples in eighteen thousand — a couple of samples either side of a
  // hop, corrected by the wrong channel — stretched the range twentyfold, packed every
  // real sample into two bins, and returned a threshold below everything in the signal.
  // The slicer then read the whole capture as ones. Any capture with a click in it has
  // the same shape, so this is not a special case, it is the ordinary one.
  const { lo, hi } = robustRange(x);
  if (!(hi > lo)) return { value: 0.5, hist: new Float32Array(48), lo: 0, hi: 1 };

  const nb = 48;
  const hist = new Float32Array(nb);
  for (let i = 0; i < x.length; i++) {
    // Outside the range still counts, at the end it falls off: a sample that is far
    // above everything is still above the threshold, it just does not get to decide
    // where the threshold is.
    const b = Math.max(0, Math.min(nb - 1, Math.floor(((x[i] - lo) / (hi - lo)) * (nb - 1))));
    hist[b] += 1;
  }
  let total = x.length, sum = 0;
  for (let i = 0; i < nb; i++) sum += i * hist[i];

  // Score every split, then take the MIDDLE of the best plateau rather than its
  // first bin. On a clean two-level signal the classes are separated by an empty
  // gap, every threshold inside that gap separates them equally well, and keeping
  // the first one puts the threshold at the bottom of the gap — hard against the
  // noise floor, where every wiggle crosses it. The center of the gap is the answer
  // a person would point at, and on noisy data where there is no plateau it is the
  // same bin the naive version picks.
  const score = new Float64Array(nb).fill(-1);
  let sumB = 0, wB = 0, best = -1;
  for (let i = 0; i < nb; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    score[i] = between;
    if (between > best) best = between;
  }
  if (!(best > 0)) return { value: (lo + hi) / 2, hist, lo, hi };

  const eps = best * 1e-9;
  let first = -1, last = -1;
  for (let i = 0; i < nb; i++) {
    if (score[i] < best - eps) { if (first >= 0) break; continue; }
    if (first < 0) first = i;
    last = i;
  }
  const bestT = (first + last) / 2;
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
 * NRZ slicing: a fixed-rate on/off stream to bytes.
 *
 * The PWM slicer above reads *pulse widths* — a long mark is a one, a short mark a
 * zero — which is how cheap remotes encode and is useless here. This is the other
 * half: sample the envelope once per symbol on a regular grid and take each sample
 * as one bit. Most real protocols are this one.
 *
 * Three things have to be right and only one of them is the threshold:
 *
 *   - the symbol period, or the grid drifts off the data;
 *   - the phase of the grid, so samples land mid-symbol rather than on edges;
 *   - where the byte boundary falls, which no amount of correct bit slicing tells
 *     you — that is what a sync word is for.
 */
export function nrzSlice(env, threshold, sampleRate, symbolUs, opts = {}) {
  const sps = (symbolUs * 1e-6) * sampleRate;
  if (!(sps >= 1) || !env.length) return { bytes: new Uint8Array(0), bits: 0, phase: 0, syncAt: -1, sps };
  const msbFirst = opts.msbFirst !== false;

  // Grid phase, by trying every offset within one symbol and keeping the one whose
  // samples land furthest from the threshold. A sample taken mid-symbol is
  // unambiguous; one taken on an edge is a coin toss, and a packet of coin tosses
  // is what "it almost decodes" looks like.
  const tries = Math.max(4, Math.min(32, Math.round(sps)));
  let bestPhase = 0, bestScore = -Infinity;
  for (let k = 0; k < tries; k++) {
    const off = (k / tries) * sps;
    let score = 0, n = 0;
    for (let i = off; i < env.length && n < 4000; i += sps) {
      score += Math.abs(env[Math.round(i)] - threshold);
      n++;
    }
    if (n && score / n > bestScore) { bestScore = score / n; bestPhase = off; }
  }

  const bits = [];
  for (let i = bestPhase; i < env.length; i += sps) bits.push(env[Math.round(i)] > threshold ? 1 : 0);

  // Byte alignment. The sync word is searched for rather than assumed at the start,
  // because a capture rarely begins where the packet does.
  let start = 0, syncAt = -1;
  const sync = opts.syncBits;
  if (sync && sync.length) {
    outer: for (let i = 0; i + sync.length <= bits.length; i++) {
      for (let j = 0; j < sync.length; j++) if (bits[i + j] !== sync[j]) continue outer;
      syncAt = i;
      start = i + sync.length;
      break;
    }
  }

  const out = new Uint8Array(Math.floor((bits.length - start) / 8));
  for (let b = 0; b < out.length; b++) {
    let v = 0;
    for (let k = 0; k < 8; k++) {
      const bit = bits[start + b * 8 + k];
      v |= msbFirst ? (bit << (7 - k)) : (bit << k);
    }
    out[b] = v;
  }
  return { bytes: out, bits: bits.length, phase: bestPhase, syncAt, sps };
}

/** A hex string like "aa aa ff ff" to the bits a slicer looks for. */
export function syncBitsOf(hex, msbFirst = true) {
  const clean = String(hex).replace(/[^0-9a-fA-F]/g, '');
  const bits = [];
  for (let i = 0; i + 1 < clean.length; i += 2) {
    const v = parseInt(clean.slice(i, i + 2), 16);
    for (let k = 0; k < 8; k++) bits.push(msbFirst ? (v >> (7 - k)) & 1 : (v >> k) & 1);
  }
  return bits;
}

/**
 * Symbol rate for a fixed-rate stream, from the shortest run in it.
 *
 * `estimateSymbolPeriod` clusters pulse *lengths*, which is right for pulse-width
 * encoding and wrong here: in NRZ every run is a whole multiple of one symbol, so
 * the answer is the greatest common divisor of the run lengths — approximated by
 * the shortest run, which is a single symbol as soon as the data contains one
 * isolated bit. A preamble of alternating bits guarantees that, which is one of
 * the reasons preambles exist.
 */
export function estimateNrzSymbol(env, threshold, sampleRate) {
  const runs = [];
  let cur = env[0] > threshold, len = 0;
  for (let i = 0; i < env.length; i++) {
    const on = env[i] > threshold;
    if (on === cur) { len++; continue; }
    runs.push(len); cur = on; len = 1;
  }
  runs.push(len);
  if (runs.length < 8) return { value: 0, confident: false, runs: runs.length };
  // The first and last runs are cut off by the window rather than by the data.
  const inner = runs.slice(1, -1);
  if (inner.length < 6) return { value: 0, confident: false, runs: runs.length };

  // Find the period that explains every run, rather than assuming the shortest run is
  // one symbol.
  //
  // The shortest run is a tempting definition and a fragile one: it is whatever the
  // worst glitch in the capture happens to be. Taking a low percentile instead of the
  // minimum helps until there are a handful of glitches, and then it fails the same way
  // — a de-hopped capture with seven bad samples in eighteen thousand reported 100 µs
  // for a 417 µs symbol, and the slicer dutifully read every byte four times over.
  //
  // So: score each candidate period by how nearly every run is a whole number of them,
  // weighted by how long each run is. A glitch twenty samples long contributes twenty
  // out of eighteen thousand and cannot move the answer; the payload decides it.
  const maxRun = Math.max(...inner);
  const hi = Math.min(maxRun, Math.floor(env.length / 8));
  if (hi < 2) return { value: 0, confident: false, runs: runs.length };

  let weight = 0;
  for (const r of inner) weight += r;
  const score = (t) => {
    let acc = 0;
    for (const r of inner) acc += r * Math.cos((2 * Math.PI * r) / t);
    return acc / weight;
  };

  let best = -Infinity;
  const step = 0.25;
  const scores = [];
  for (let t = 2; t <= hi; t += step) {
    const v = score(t);
    scores.push({ t, v });
    if (v > best) best = v;
  }
  if (!(best > 0.2)) return { value: 0, confident: false, runs: runs.length, agreement: 0 };

  // Every submultiple of the right period scores just as well — if every run is a whole
  // number of T, it is also a whole number of T/2. The answer is the *longest* period
  // that still explains the data, so take the last one near the best rather than the
  // best one.
  let chosen = scores[0].t;
  for (const { t, v } of scores) if (v >= best * 0.97) chosen = t;

  // Then refine against the runs it just classified.
  //
  // The sweep only has to land close enough to get every run onto the right integer; it
  // does not have to be accurate, and it is not — a quarter-sample grid picked 423.8 µs
  // for a 416.7 µs symbol. Under two percent, which sounds like nothing and is three bits
  // of drift across two hundred: the preamble decoded perfectly and everything after it
  // was mush.
  //
  // Once each run has an integer attached, the period is the least-squares fit through
  // them — every run votes, the long ones loudest, and the answer is good to a fraction
  // of a sample. The Manchester estimator needed the same correction for the same reason.
  // Total elapsed samples over total symbols, which is how you measure a clock: the two
  // long-baseline numbers, not a weighted average of short ones. A least-squares fit
  // through the same classified runs was three times worse — it lets every run pull
  // independently, and the quantization of a run to whole samples then averages in as
  // noise instead of cancelling over the length of the capture.
  for (let pass = 0; pass < 8; pass++) {
    let elapsed = 0, symbols = 0;
    for (const r of inner) {
      // A run far shorter than a symbol is a glitch, not a symbol — a threshold crossing
      // in the noise, or the edge of a gap. Rounding it up to one symbol and letting it
      // vote is how the estimate came out 0.14% high, which is a sixth of a symbol of
      // drift across two hundred bits and turns the back half of a packet to mush.
      if (r < chosen * 0.4) continue;
      const m = Math.round(r / chosen);
      // A tight window, because this is a refinement and not a search: anything that is
      // not already very nearly a whole number of symbols is something else.
      if (m < 1 || Math.abs(r / chosen - m) > 0.15) continue;
      elapsed += r; symbols += m;
    }
    if (symbols > 0) chosen = elapsed / symbols;
  }

  let hits = 0, hitWeight = 0;
  for (const r of inner) {
    const m = r / chosen;
    if (Math.abs(m - Math.round(m)) < 0.2) { hits++; hitWeight += r; }
  }
  const agreement = hitWeight / weight;
  return {
    value: (chosen / sampleRate) * 1e6,
    confident: agreement > 0.9 && inner.length > 20,
    agreement, runs: runs.length, hits,
  };
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

// ── wave 2: line codes ───────────────────────────────────────────────────
//
// NRZ says what a bit *is*; these say how a bit was *drawn*. A slicer gets you from
// amplitude to symbols, and then there is usually one more layer between the symbols
// and the bits — a layer that exists because a radio link needs transitions to stay
// synchronized and cannot afford a run of two hundred zeros.

/**
 * Manchester: every bit is a transition in the middle of its symbol.
 *
 * Which transition means which bit is a convention, and the two conventions are exact
 * inverses — so nothing in the signal can tell them apart. That is not a limitation to
 * paper over with a guess: it is decided by what the packet says, and the honest way to
 * decide it is a sync word appearing under one convention and not the other.
 *
 * What the signal *can* tell you is whether the symbol rate and phase are right, and
 * it says so loudly: a correct Manchester decode has a transition in every symbol, so
 * counting the symbols that do not is a direct measure of how wrong you are.
 */
export function manchesterSlice(env, threshold, sampleRate, symbolUs, opts = {}) {
  const sps = (symbolUs * 1e-6) * sampleRate;
  const half = sps / 2;
  const empty = { bytes: new Uint8Array(0), bits: 0, violations: 0, symbols: 0,
                  phase: 0, syncAt: -1, sps, polarity: opts.polarity || 'ieee' };
  if (!(half >= 1) || !env.length) return empty;

  const ieee0 = (opts.polarity || 'ieee') === 'ieee';
  const sample = (i) => env[Math.max(0, Math.min(env.length - 1, Math.round(i)))] > threshold ? 1 : 0;

  /** Decode on a grid starting at `off`, and count the symbols that broke the rule. */
  const tryPhase = (off) => {
    const bits = [];
    let violations = 0;
    for (let pos = off; pos + sps <= env.length; pos += sps) {
      const a = sample(pos + half * 0.5), b = sample(pos + half * 1.5);
      if (a === b) { violations++; bits.push(a); continue; }
      bits.push(ieee0 ? (a === 0 ? 1 : 0) : (a === 0 ? 0 : 1));
    }
    return { bits, violations };
  };

  // Phase, chosen by counting violations rather than by how far the samples land from
  // the threshold.
  //
  // There are two grids a half-symbol apart, and they are not equivalent: the wrong one
  // pairs the back half of each symbol with the front half of the next, which decodes
  // to nonsense. Scoring by distance from the threshold cannot tell them apart, because
  // both sample the middle of a half-symbol either way — so it picked between them
  // essentially at random, and the symptom was a decoder that recovered a packet at 30%
  // noise and lost it at 10%.
  //
  // Violations *can* tell them apart, and decisively: the right grid has a transition
  // in every symbol by construction, and the wrong one violates whenever consecutive
  // bits differ — which is every symbol of an alternating preamble. Searching the full
  // symbol period rather than half of it is the other half of the same bug.
  const tries = Math.max(8, Math.min(64, Math.round(sps)));
  let bestPhase = 0, best = null;
  for (let k = 0; k < tries; k++) {
    const off = (k / tries) * sps;
    const got = tryPhase(off);
    if (!got.bits.length) continue;
    if (!best || got.violations < best.violations) { best = got; bestPhase = off; }
  }
  if (!best) return empty;

  // Sampled in the middle of each half-symbol, on a fixed grid.
  //
  // A tracking loop was tried here and removed, and the removal is worth recording
  // because the reasoning was wrong on the way in. The decoder was erratic — it
  // recovered a payload at 30% noise and lost it at 10% — which looked like a timing
  // problem, so an early-late gate went in. It did not help, because the fault was the
  // phase search above choosing between two inequivalent grids at random. With that
  // fixed the plain grid is stable from clean signal through 30% noise and survives a
  // transmitter one percent fast; the loop was never needed and was never re-tried.
  //
  // Three percent fast still loses byte alignment. Real transmitters are crystal-locked
  // to tens of parts per million, so that is a long way outside what hardware does; if
  // it ever matters, the answer is a Gardner detector with tests that pin it down.
  //
  // The fixed grid is only as good as the symbol period it is given, which is why the
  // estimator above refines rather than guesses: a percentile is biased low by exactly
  // the clipping it was chosen to survive, and one sample in fifty is a two percent
  // error that walks the sampling point out of the symbol within a hundred of them.
  const bits = best.bits;
  const violations = best.violations;

  return { ...packBits(bits, opts), violations, symbols: bits.length,
           phase: bestPhase, sps, polarity: ieee0 ? 'ieee' : 'thomas' };
}

/**
 * The symbol period of a Manchester signal, from the fact that it has no long runs.
 *
 * A transition every symbol means a run is one half-symbol or two and never three, so
 * the shortest run *is* the half-symbol and the distribution says whether you are
 * looking at Manchester at all. A signal whose runs come in five different lengths is
 * telling you it is something else.
 */
export function estimateManchesterSymbol(env, threshold, sampleRate) {
  const runs = [];
  let i = 0;
  while (i < env.length) {
    const high = env[i] > threshold;
    let j = i;
    while (j < env.length && (env[j] > threshold) === high) j++;
    runs.push(j - i);
    i = j;
  }
  // drop the first and last, which are clipped by where the window happened to start
  const body = runs.slice(1, -1).filter((r) => r > 0);
  if (body.length < 8) return { value: 0, confident: false, runs: body.length, agreement: 0 };

  const sorted = body.slice().sort((a, b) => a - b);
  // A first guess at the half-symbol: the 10th percentile rather than the single
  // minimum, which one clipped edge would otherwise decide.
  let unit = sorted[Math.floor(sorted.length * 0.1)];
  if (!(unit > 0)) return { value: 0, confident: false, runs: body.length, agreement: 0 };

  // Then refine it, because a percentile is biased low by exactly the clipping it was
  // chosen to survive, and "low by one sample in fifty" is a two percent rate error —
  // which over a hundred symbols walks the sampling point clean out of the symbol.
  // The mean of the runs that *are* single units is unbiased and costs one more pass.
  for (let pass = 0; pass < 3; pass++) {
    let sum = 0, n = 0, sum2 = 0, n2 = 0;
    const tol = Math.max(1, unit * 0.35);
    for (const r of body) {
      if (Math.abs(r - unit) <= tol) { sum += r; n++; }
      else if (Math.abs(r - 2 * unit) <= 2 * tol) { sum2 += r; n2++; }
    }
    if (!n && !n2) break;
    // Doubles carry the same information about the unit and there are usually plenty
    // of them, so both populations vote.
    unit = (sum + sum2 / 2) / (n + n2);
  }

  // Manchester's whole signature: every run is one unit or two, and nothing else.
  let ones = 0, twos = 0;
  for (const r of body) {
    if (Math.abs(r - unit) <= Math.max(1, unit * 0.35)) ones++;
    else if (Math.abs(r - 2 * unit) <= Math.max(1, unit * 0.35)) twos++;
  }
  const agreement = (ones + twos) / body.length;
  return {
    value: (2 * unit / sampleRate) * 1e6,      // two half-symbols, in microseconds
    confident: agreement > 0.9 && twos > body.length * 0.05,
    runs: body.length, agreement, unitSamples: unit,
  };
}

/**
 * Differential decoding: the bit is whether the line changed, not what it is.
 *
 * NRZ-M marks a 1 with a transition, NRZ-S marks a 0 with one. Either way the receiver
 * stops caring which way round the wires are, which is exactly why it is used and
 * exactly why a stream that decodes to noise sometimes decodes perfectly after this.
 */
export function differentialDecode(bytes, mode = 'nrz-m', opts = {}) {
  const msbFirst = opts.msbFirst !== false;
  const bits = unpackBits(bytes, msbFirst);
  const out = new Array(bits.length);
  let prev = opts.initial != null ? opts.initial : 0;
  for (let i = 0; i < bits.length; i++) {
    const changed = bits[i] !== prev;
    out[i] = (mode === 'nrz-s') ? (changed ? 0 : 1) : (changed ? 1 : 0);
    prev = bits[i];
  }
  return packBits(out, { msbFirst });
}

function unpackBits(bytes, msbFirst = true) {
  const bits = new Array(bytes.length * 8);
  for (let b = 0; b < bytes.length; b++) {
    for (let k = 0; k < 8; k++) {
      bits[b * 8 + k] = msbFirst ? (bytes[b] >> (7 - k)) & 1 : (bytes[b] >> k) & 1;
    }
  }
  return bits;
}

/** Bits to bytes, finding a sync word first if one was given. Shared by the slicers. */
function packBits(bits, opts = {}) {
  const msbFirst = opts.msbFirst !== false;
  let start = 0, syncAt = -1;
  const sync = opts.syncBits;
  if (sync && sync.length) {
    outer: for (let i = 0; i + sync.length <= bits.length; i++) {
      for (let j = 0; j < sync.length; j++) if (bits[i + j] !== sync[j]) continue outer;
      syncAt = i;
      start = i + sync.length;
      break;
    }
  }
  const out = new Uint8Array(Math.max(0, Math.floor((bits.length - start) / 8)));
  for (let b = 0; b < out.length; b++) {
    let v = 0;
    for (let k = 0; k < 8; k++) {
      const bit = bits[start + b * 8 + k];
      v |= msbFirst ? (bit << (7 - k)) : (bit << k);
    }
    out[b] = v;
  }
  return { bytes: out, bits: bits.length, syncAt };
}

export { unpackBits, packBits };
