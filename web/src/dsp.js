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

/**
 * Power spectrum in dBFS of a real-valued stream: 0 to fs/2, DC on the left.
 *
 * A demodulator's output is real, and a real signal's spectrum is its own mirror
 * image about DC — so half of the two-sided picture is the other half again, and
 * showing both would spend half the screen on a reflection. This returns the
 * positive half only, `bins` values from `bins * 2` samples, which keeps "bins" the
 * number of columns on screen in either domain.
 *
 * What it is for: an FM discriminator hands back the whole composite — mono at the
 * bottom, the 19 kHz pilot, L-R on a 38 kHz subcarrier, RDS at 57 kHz — and a
 * waveform cannot show you which of those are present. This can.
 */
export function realSpectrum(x, bins, windowName, out) {
  const n = bins * 2;
  const w = windowFn(windowName, n);
  const buf = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) buf[i * 2] = x[i] * w[i];   // imaginary part stays zero
  fft(buf);

  const res = out && out.length === bins ? out : new Float32Array(bins);
  for (let i = 0; i < bins; i++) {
    // The mirrored half carries half the energy, so folding it back in is what makes
    // a full-scale sine read 0 dBFS here, the same as it does in the IQ view. DC has
    // no mirror image to fold in, so it is the one bin that is not doubled.
    const norm = i === 0 ? 1 / n : 2 / n;
    const re = buf[i * 2] * norm;
    const im = buf[i * 2 + 1] * norm;
    res[i] = 10 * Math.log10(re * re + im * im + 1e-20);
  }
  return res;
}

// ── Filter design ──────────────────────────────────────────────────────────
/**
 * A real FIR, centered: the output lines up with the input rather than lagging it by
 * half the filter.
 *
 * Every filter in this file until now was complex — a channelizer mixing, filtering and
 * decimating in one pass. A stereo decoder needs the plain real version several times
 * over, and it needs the alignment, because two of the filtered signals get multiplied
 * together and half a filter of skew between them is a phase error in the product.
 */
export function fir(x, taps, out) {
  const n = x.length, m = taps.length, half = (m - 1) >> 1;
  const y = out && out.length === n ? out : new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    // clamped rather than wrapped or zero-padded per tap: the ends of the span are the
    // only samples this gets wrong, and something upstream always read a little extra
    const k0 = i + half - n + 1 > 0 ? i + half - n + 1 : 0;
    const k1 = i + half < m - 1 ? i + half : m - 1;
    for (let k = k0; k <= k1; k++) s += x[i + half - k] * taps[k];
    y[i] = s;
  }
  return y;
}

/**
 * Move a signal by a possibly-fractional number of samples.
 *
 * A whole number is an index offset. The fraction is the part that matters and the part
 * that is easy to drop: half a sample at 160 kS/s is three microseconds, which is forty
 * degrees of phase at 38 kHz — so a merge that rounded its alignment to an integer would
 * line two branches up and still lose a coherent decode (ADR-0038).
 *
 * The fractional part is a windowed sinc evaluated at the offset, which is the same
 * filter `resample` builds, at one phase instead of a table of them. Sixteen taps either
 * side is far more than the sub-sample corrections this exists for need, and the cost is
 * a sixteenth of what the channel filter upstream already paid.
 *
 * Positive `by` moves the signal later: `out[i]` is `x[i - by]`.
 */
export function shiftBy(x, by, { stride = 1, halfWidth = 16 } = {}) {
  const n = Math.floor(x.length / stride);
  const out = new Float32Array(x.length);
  const whole = Math.round(by);
  const frac = by - whole;

  if (Math.abs(frac) < 1e-9) {
    for (let i = 0; i < n; i++) {
      const j = i - whole;
      if (j < 0 || j >= n) continue;
      for (let c = 0; c < stride; c++) out[i * stride + c] = x[j * stride + c];
    }
    return out;
  }

  // sinc(k - frac) windowed by a Hann of the same support, normalized so a constant
  // survives unchanged — an interpolator with gain ≠ 1 is a gain error that moves with
  // the fraction, which is worse than the delay it is fixing
  // `sinc(k + frac)`, not `sinc(k - frac)`. Reconstruction is x(t) = Σ x[m]·sinc(t - m),
  // and with m = i - whole + k and t = i - whole - frac that is sinc(-frac - k). The other
  // sign builds a perfectly good interpolator that shifts the wrong way — a whole sample
  // out, which at 38 kHz is eighty-five degrees, and the only way to see it is to compare
  // against an analytically shifted signal rather than to read the loop.
  const taps = new Float32Array(halfWidth * 2 + 1);
  let sum = 0;
  for (let k = -halfWidth; k <= halfWidth; k++) {
    const t = k + frac;
    const sinc = Math.abs(t) < 1e-9 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
    const w = 0.5 * (1 + Math.cos((Math.PI * k) / (halfWidth + 1)));
    const v = sinc * w;
    taps[k + halfWidth] = v;
    sum += v;
  }
  for (let k = 0; k < taps.length; k++) taps[k] /= sum;

  for (let i = 0; i < n; i++) {
    for (let c = 0; c < stride; c++) {
      let acc = 0;
      for (let k = -halfWidth; k <= halfWidth; k++) {
        const j = i - whole + k;
        if (j < 0 || j >= n) continue;
        acc += x[j * stride + c] * taps[k + halfWidth];
      }
      out[i * stride + c] = acc;
    }
  }
  return out;
}

/**
 * A band-pass and its quadrature: the two halves of an analytic filter.
 *
 * A low-pass shifted up to `centerHz` gives the in-phase half; the same low-pass shifted
 * with a sine gives the half a quarter-cycle behind it. Filtering a real signal with both
 * gives `p + jq` — the analytic signal of whatever is in that band — with no Hilbert
 * transformer and, more usefully, with both halves delayed by exactly the same amount.
 * That alignment is the whole point: the phase of `p + jq` is the thing being measured.
 */
export function bandPassTaps(numTaps, centerHz, widthHz, fs) {
  const lp = lowPassTaps(numTaps, widthHz / 2, fs);
  const m = lp.length, half = (m - 1) >> 1;
  const i = new Float32Array(m), q = new Float32Array(m);
  for (let k = 0; k < m; k++) {
    const a = (2 * Math.PI * centerHz * (k - half)) / fs;
    i[k] = 2 * lp[k] * Math.cos(a);
    q[k] = 2 * lp[k] * Math.sin(a);
  }
  return { i, q };
}


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
 * How much of the rest of the band folds into this channel, in dB.
 *
 * Decimating by D makes every band around a multiple of the output rate land on top of
 * the channel: content at `k·rate ± cutoff` arrives inside the passband and is
 * indistinguishable from signal once it is there. So the number that matters is not the
 * filter's cutoff, it is the worst gain anywhere in those bands — and that is what this
 * measures, by evaluating the response rather than estimating it from a rule.
 *
 * Negative and large is good. Zero means a neighbouring channel arrives at full strength
 * in the middle of this one.
 */
export function aliasRejectionDb(taps, fs, cutoffHz, decim) {
  if (decim <= 1) return -Infinity;              // nothing folds when nothing is dropped
  const rate = fs / decim;
  const gainAt = (hz) => {
    let re = 0, im = 0;
    for (let i = 0; i < taps.length; i++) {
      const a = (-2 * Math.PI * hz * i) / fs;
      re += taps[i] * Math.cos(a);
      im += taps[i] * Math.sin(a);
    }
    return Math.hypot(re, im);
  };
  let worst = 0;
  for (let k = 1; k * rate - cutoffHz < fs / 2; k++) {
    for (let j = 0; j <= 8; j++) {
      const hz = k * rate - cutoffHz + (2 * cutoffHz * j) / 8;
      if (hz > fs / 2) break;
      worst = Math.max(worst, gainAt(hz));
    }
  }
  return 20 * Math.log10(worst + 1e-12);
}

/** Tap counts the tuner will consider, shortest first. Odd, so the filter is linear phase. */
const TAP_CHOICES = [65, 97, 129, 161, 193, 225, 255];

/**
 * How long the channel filter has to be, measured rather than assumed.
 *
 * The old answer was 65, always, with an `auto` badge and the words "transition width"
 * underneath — which was not a derivation, it was a constant wearing one. It is fine for
 * a wide channel and it is nowhere near enough for a narrow one: at 200 kS/s decimated
 * by 80, sixty-five taps put a carrier 4 kHz away only 10 dB down, and sixteen carriers
 * 4 kHz apart decoded three times out of sixteen. At 129 taps that neighbour is 38 dB
 * down and all sixteen read.
 *
 * So: try the candidates shortest first and take the first that puts everything which
 * folds below `targetDb`. Filtering costs time proportional to the tap count and every
 * frame pays it, so a channel that does not need a long filter does not get one.
 *
 * **It cannot always be met, and then it says so rather than pretending.** A single-stage
 * FIR decimating by eighty has a transition band a thousandth of the input rate wide;
 * no tap count inside any sane budget makes that brick-walled, and the honest report is
 * the number achieved. `met: false` is the tuner's cue to say the channel is narrow
 * enough that neighbours will leak, which is a thing to know and not a thing to hide.
 */
export function chooseTaps(fs, widthHz, decim, { targetDb = 60, choices = TAP_CHOICES } = {}) {
  const cutoff = Math.max(1, widthHz / 2);
  let last = { taps: choices[0], rejectionDb: 0, met: false };
  for (const n of choices) {
    const db = aliasRejectionDb(lowPassTaps(n, cutoff, fs), fs, cutoff, decim);
    last = { taps: n, rejectionDb: db, met: db <= -targetDb };
    if (last.met) return last;
  }
  return last;
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
 * The real part of an IQ stream.
 *
 * Not a detector — a detector answers a question about a signal, and this answers none.
 * It is what turns the end of a chain of tuners and arithmetic back into something a
 * speaker can take, and it is `complex_to_real` in anybody else's vocabulary.
 */
export function realPart(iq, count) {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = iq[i * 2];
  return out;
}

// ── FM stereo ──────────────────────────────────────────────────────────────
//
// The composite an FM broadcast discriminator hands back is three things stacked in
// frequency: L+R at the bottom, a 19 kHz pilot, and L-R on a suppressed subcarrier at
// 38 kHz. Recovering L and R is one coherent demodulation and one two-by-two matrix —
// and the only part with a trap in it is where the 38 kHz reference comes from.

export const PILOT_HZ = 19_000;
export const STEREO_SUBCARRIER_HZ = 2 * PILOT_HZ;
/** The top of the audio band, and so the cutoff on both the sum and the difference. */
export const STEREO_AUDIO_HZ = 15_000;
/**
 * How long the filters are, which is a trade rather than a constant.
 *
 * Measured against a synthetic composite with a different tone in each channel: 63 taps
 * separates the channels by 63 dB, 127 by 77, and 255 by no more than 127 does. Four of
 * these run over every sample of audio, so the cost is real — 127 taps is about 27 ms
 * per 200 ms of audio at 160 kS/s — and 77 dB is about forty more than a good receiver
 * achieves off the air. Past this, longer filters buy nothing and cost linearly.
 */
const STEREO_TAPS = 127;

/**
 * Is there a pilot, and how far above the floor?
 *
 * The pilot is unusually good evidence and that is the reason to look for it rather than
 * for the subcarrier itself: it is a bare tone at a frequency fixed by the standard, at
 * about 10% injection, and it is present when and only when the station is transmitting
 * in stereo. The subcarrier is suppressed, so on quiet passages there is nothing at
 * 38 kHz to find even on a station that is.
 */
export function estimatePilot(x, count, fs, { bins = 2048 } = {}) {
  const need = bins * 2;
  if (count < need || fs / 2 <= PILOT_HZ) {
    return { value: PILOT_HZ, snrDb: 0, confident: false };
  }
  // Off the middle of the span rather than the start: a window that lands on the run-up
  // of a filter measures the filter.
  const from = Math.max(0, Math.min(count - need, ((count - need) >> 1)));
  const sp = realSpectrum(x.subarray(from, from + need), bins, 'Hann');
  const binHz = fs / (2 * bins);
  const at = Math.round(PILOT_HZ / binHz);
  const guard = Math.max(2, Math.round(600 / binHz));
  if (at + guard >= bins) return { value: PILOT_HZ, snrDb: 0, confident: false };

  let peak = -Infinity, peakAt = at;
  for (let i = at - guard; i <= at + guard; i++) {
    if (i >= 0 && sp[i] > peak) { peak = sp[i]; peakAt = i; }
  }
  // The floor is measured in the guard band the pilot sits in, not across the whole
  // spectrum. Broadcast FM leaves 15 to 23 kHz empty by design — audio stops below it
  // and L-R starts above it — so the pilot is the only thing that belongs there, and
  // "stands above its own neighbourhood" is a much sharper question than "stands above
  // the average of everything".
  //
  // Measured against the whole spectrum instead, a mono station carrying one clean tone
  // reported a confident pilot at 13 dB: with nothing else transmitting, the median of
  // the spectrum is the FFT's own leakage skirt, and any bin at all clears it. The guard
  // band contains that same leakage, so comparing like with like takes it back out.
  const rest = [];
  for (let i = 1; i < bins; i++) {
    const hz = i * binHz;
    if (hz < 15_800 || hz > 22_200) continue;
    if (Math.abs(hz - PILOT_HZ) < 900) continue;
    rest.push(sp[i]);
  }
  rest.sort((a, b) => a - b);
  const floor = rest.length ? rest[rest.length >> 1] : -120;
  const snrDb = peak - floor;
  return {
    value: peakAt * binHz,
    snrDb,
    // Fifteen decibels over its own guard band, and landing where the standard says it
    // will. A wide gate rather than a fine one, because what it has to separate is "a
    // tone" from "no tone" — a station in mono has nothing here at all.
    confident: snrDb > 15 && Math.abs(peakAt * binHz - PILOT_HZ) < 400,
  };
}

/** One-pole de-emphasis with unity gain at DC. `tauS` is 75 µs or 50 µs. */
export function deemphasis(x, fs, tauS, out) {
  const y = out && out.length === x.length ? out : new Float32Array(x.length);
  if (!(tauS > 0)) { y.set(x); return y; }
  const a = 1 - Math.exp(-1 / (fs * tauS));
  let acc = x[0] || 0;
  for (let i = 0; i < x.length; i++) { acc += a * (x[i] - acc); y[i] = acc; }
  return y;
}

/**
 * The composite to L and R, interleaved.
 *
 * **Where the 38 kHz comes from is the whole problem.** The standard's claim is not that
 * the subcarrier sits at 38 kHz — it is that the subcarrier's phase is exactly *twice*
 * the pilot's. Where t = 0 happens to be is arbitrary and a receiver never learns it, so
 * an oscillator running free at a nominally correct 38 kHz is at an unknown and drifting
 * phase against L-R, and a coherent demodulator at the wrong phase recovers nothing at
 * all. Doubling the pilot is not an optimization; it is the only way to know the phase.
 *
 * So: band-pass the pilot with an analytic pair to get `p + jq` at phase ψ, and the
 * reference is cos(2ψ) = (p² - q²)/(p² + q²) — the doubled angle, normalized so the
 * pilot's own amplitude drops out. This is right for any phase origin, which is the
 * property being relied on, and the test asserts it across several.
 *
 * The tempting shortcut — square the pilot and band-pass the result at 38 kHz — gives
 * cos(2ψ) too, and appears to work. It is the same thing with the normalization thrown
 * away, so its amplitude rides on the pilot's, and on a weak signal the recovered L-R
 * fades with it while L+R does not. The channels then wander toward mono.
 */
export function stereoDecode(x, count, fs, { deemphasisUs = 75, stereo = 'auto',
                                            taps = STEREO_TAPS } = {}) {
  const n = Math.min(count, x.length);
  const out = new Float32Array(n * 2);
  const both = (note) => {
    for (let i = 0; i < n; i++) { out[i * 2] = x[i]; out[i * 2 + 1] = x[i]; }
    return { data: out, quadRejectionDb: 0, note };
  };
  if (fs / 2 <= STEREO_SUBCARRIER_HZ + 1000) {
    // Not an error and not a silent half-decode: a composite this narrow does not
    // contain 38 kHz, so there is no difference signal in it to recover.
    return both('no 38 kHz in a stream this narrow — this is the mono sum, twice');
  }
  // Without a pilot there is no phase reference, and a difference demodulated against a
  // band-pass full of noise is not a quiet decode — it is two channels of nonsense that
  // sound like a broken stereo rather than like a mono station. So the absence is
  // reported and the sum goes out on both channels (ADR-0031). `stereo: true` forces it
  // anyway, which is for a pilot too weak to measure rather than for one that is absent.
  if (stereo !== true) {
    const pilot = stereo === false ? { confident: false, snrDb: 0 } : estimatePilot(x, n, fs);
    if (!pilot.confident) {
      return both(stereo === false ? 'decoding as mono, because you asked'
                                   : 'no 19 kHz pilot — this station is in mono');
    }
  }
  const span = x.subarray(0, n);
  const bp = bandPassTaps(taps, PILOT_HZ, 1600, fs);
  const p = fir(span, bp.i), q = fir(span, bp.q);

  const mixI = new Float32Array(n), mixQ = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const m2 = p[i] * p[i] + q[i] * q[i] || 1e-20;
    const ref = (p[i] * p[i] - q[i] * q[i]) / m2;       // cos 2ψ
    const quad = (2 * p[i] * q[i]) / m2;                // sin 2ψ, which should be empty
    mixI[i] = span[i] * 2 * ref;
    mixQ[i] = span[i] * 2 * quad;
  }

  const lp = lowPassTaps(taps, STEREO_AUDIO_HZ, fs);
  const sum = fir(span, lp);
  const diff = fir(mixI, lp);
  // Not used to decode anything — it is the evidence that the reference is locked.
  // A demodulator at the right phase puts everything in one quadrature and nothing in
  // the other, so how much less is in the other one is a measurement of the lock
  // (ADR-0017), and it is the number that goes bad first when a pilot is weak.
  const quadrature = fir(mixQ, lp);
  let ps = 0, pq = 0;
  const edge = Math.min(taps * 2, n >> 2);
  for (let i = edge; i < n - edge; i++) { ps += diff[i] * diff[i]; pq += quadrature[i] * quadrature[i]; }
  const quadRejectionDb = 10 * Math.log10((ps + 1e-20) / (pq + 1e-20));

  const tau = deemphasisUs > 0 ? deemphasisUs * 1e-6 : 0;
  const left = new Float32Array(n), right = new Float32Array(n);
  for (let i = 0; i < n; i++) { left[i] = sum[i] + diff[i]; right[i] = sum[i] - diff[i]; }
  // After the matrix, never before. The time constant applies to each recovered channel,
  // and de-emphasizing the composite would take 27 dB off the 57 kHz subcarrier that
  // something downstream may still want to read (ADR-0037).
  const dl = deemphasis(left, fs, tau), dr = deemphasis(right, fs, tau);
  for (let i = 0; i < n; i++) { out[i * 2] = dl[i]; out[i * 2 + 1] = dr[i]; }
  return { data: out, quadRejectionDb };
}

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
 * Is this a spectrum, or a node that has not produced samples yet?
 *
 * A channel whose buffers are still empty answers with a frame of zeros. That is a
 * perfectly valid spectrum of silence and reads as about -200 dBFS in every bin, and
 * anything that ranges a display to it puts the floor somewhere no signal will ever
 * reach — after which an auto-range has to crawl all the way back up.
 *
 * That crawl is what "the auto scale takes a while to dial in" actually was. Not a slow
 * filter: one empty frame poisoning it, and every frame after that spent recovering from
 * a number that was never a measurement.
 *
 * Flatness is the tell, and it is a strong one. Real data — even pure noise — has several
 * dB between its floor and its peak, because a periodogram of noise is itself noisy. A
 * placeholder has exactly none, every bin holding the same number.
 */
export function spectrumHasSignal(data) {
  if (!data || !data.length) return false;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return hi - lo > 3 && hi > -150;
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
 * An autocorrelation, by FFT, normalized so that lag zero is 1.
 *
 * Done directly this is one multiply-add per sample per lag, and a raster search wants
 * forty thousand lags over half a million samples: eighty-six seconds, measured, on the
 * capture this was written for. Through the FFT it is three transforms regardless of how
 * many lags are asked for — the same numbers to four decimal places in about a second.
 *
 * The transform runs forward twice rather than forward-then-inverse. The power spectrum
 * is real and non-negative, so what comes back from it is real and *even*, and a second
 * forward transform of an even sequence gives that sequence reversed and scaled by N.
 * Reversed does not matter when it is even, and the scale cancels in the normalization.
 *
 * `smoothWin` averages the signal on its way in. That is not a detail: on a real leak the
 * envelope carries the pixel clock folded back into the passband, which correlates far
 * more strongly with itself than the line structure does and buries it. See
 * `estimateRaster`, which is where the window gets its size.
 */
export function autocorrelate(x, count, { maxSamples = 1 << 21, smoothWin = 1 } = {}) {
  const n = Math.min(count, maxSamples);
  let fftN = 1;
  while (fftN < n * 2) fftN <<= 1;
  const w = Math.max(1, Math.min(smoothWin | 0, n));

  // Smoothed and mean-removed in one pass, straight into the transform buffer. A video
  // signal sits on a pedestal, and correlating a pedestal with itself is a large number
  // that says nothing.
  const buf = new Float32Array(fftN * 2);
  let acc = 0, mean = 0;
  const half = (w / 2) | 0;
  for (let i = 0; i < n + half; i++) {
    acc += i < n ? x[i] : 0;
    if (i >= w) acc -= x[i - w];
    const at = i - half;
    if (at >= 0) {
      const v = acc / Math.min(i + 1, w);
      buf[at * 2] = v;
      mean += v;
    }
  }
  mean /= n || 1;
  for (let i = 0; i < n; i++) buf[i * 2] -= mean;

  fft(buf);
  for (let i = 0; i < fftN; i++) {
    const re = buf[i * 2], im = buf[i * 2 + 1];
    buf[i * 2] = re * re + im * im;
    buf[i * 2 + 1] = 0;
  }
  fft(buf);

  const r0 = buf[0];
  const maxLag = fftN >> 1;
  const r = new Float32Array(maxLag);
  if (!(r0 > 0)) return { r, n, maxLag, flat: true };
  // Each lag averaged over the n-lag terms that exist, rather than over all n: without
  // this every correlation tapers towards zero as the lag grows, and a frame — which is
  // hundreds of lines out — loses to a line for no reason but its distance.
  for (let lag = 0; lag < maxLag; lag++) r[lag] = (buf[lag * 2] / r0) / ((n - lag) / n);
  return { r, n, maxLag, flat: false };
}

/** The sub-sample position of a correlation peak, through the parabola at its top. */
function refinePeak(r, lag) {
  const a = r[lag - 1], b = r[lag], c = r[lag + 1];
  const denom = a - 2 * b + c;
  return lag + (denom !== 0 ? Math.max(-1, Math.min(1, (0.5 * (a - c)) / denom)) : 0);
}

/**
 * The period a signal repeats at, found by correlating it with itself.
 *
 * Normalized, so the answer does not depend on the level, and refined by a parabola
 * through the peak and its neighbors — a raster line is rarely a whole number of samples,
 * and a period rounded to the nearest sample shears the picture a little more with every
 * line until it is unreadable halfway down.
 */
export function estimatePeriod(x, { minLag, maxLag, maxSamples = 1 << 21, smoothWin = 1, acf = null }) {
  const a = acf || autocorrelate(x, x.length, { maxSamples, smoothWin });
  const n = a.n;
  const hi = Math.min(maxLag, a.maxLag - 2, Math.floor(n / 3));
  if (hi <= minLag + 2) return { value: 0, confident: false, reason: 'nothing to correlate over' };
  if (a.flat) return { value: 0, confident: false, reason: 'a flat signal has no period' };

  const score = a.r;
  let best = -Infinity, bestLag = 0;
  for (let lag = minLag; lag <= hi; lag++) if (score[lag] > best) { best = score[lag]; bestLag = lag; }
  if (bestLag <= minLag || bestLag >= hi) {
    return { value: bestLag, confident: false, reason: 'the best match is at the edge of the search' };
  }

  // How much it stands out. A signal with no period still has a highest correlation
  // somewhere, and reporting that as a period is how a picture of noise gets drawn.
  let sum = 0, k = 0;
  for (let i = minLag; i <= hi; i++) { sum += score[i]; k++; }
  const mean2 = sum / (k || 1);
  return { value: refinePeak(score, bestLag), peak: best, background: mean2, contrast: best - mean2,
           confident: best > 0.3 && best - mean2 > 0.15, score, minLag, maxLag: hi, acf: a };
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
 * Every frame in a capture, added on top of one another.
 *
 * A still screen sends the same frame over and over, so adding them up is free signal —
 * that is the whole reason for finding the frame period at all. What it is not is free of
 * conditions: the monitor's clock is not the receiver's, and on the 0.667 s leak this was
 * written against the frames walked nine samples apart from first to last. Stacked where
 * they were predicted to be, forty of them came out *ninety times* less sharp than the
 * same forty aligned, and worse than seven frames on their own — more averaging making a
 * worse picture, which is the trap.
 *
 * So each frame can be measured against what is already in the stack before it is added.
 * The measurement is a correlation of column sums: hundreds of rows summed down each
 * column leave the vertical structure of the screen and very little noise, and the offset
 * that lines two of those up is the offset that lines the frames up. Then the frame is
 * folded again from its corrected place, so the correction is applied where it belongs —
 * in the resampling — rather than by sliding whole columns around afterwards.
 *
 * Can, not does. Aligning is not free either: where what leaks folds back into the
 * passband near two samples a cycle, the column correlation has a peak every two samples
 * and picking the wrong one is worse than not having looked. On the synthetic leak in
 * `fixtures/tempest-leak` that is exactly what happens, and stacking the frames where
 * they were predicted to be gives a picture half again as sharp.
 *
 * Neither of those is knowable in advance, so both are built and the sharper one is kept.
 * Horizontal detail is the measure because it is the first thing a misaligned stack
 * loses, and doubling the work is worth not having to guess — the whole failure this
 * guards against is a stack that looks like more signal and is less.
 */
export function stackFrames(x, count, period, lines, { cols = 0, maxShift = 0 } = {}) {
  const width = cols || Math.max(2, Math.round(period));
  const frameLen = lines * period;
  const frames = Math.floor(count / frameLen);
  if (frames < 1) {
    return { rows: 0, cols: width, data: new Float32Array(0), frames: 0, shifts: [], aligned: false, walked: 0 };
  }
  const search = Math.max(2, Math.round(maxShift || width / 8));
  const fold = (from) => foldRaster(x, count, period, { cols: width, maxRows: lines, from }).data;

  // Where they are predicted to be, which is what aligning has to beat.
  const blind = fold(0);
  for (let f = 1; f < frames; f++) {
    const g = fold(f * frameLen);
    for (let k = 0; k < blind.length; k++) blind[k] += g[k];
  }
  if (frames < 2) {
    return { rows: lines, cols: width, data: blind, frames, shifts: [0], aligned: false, walked: 0 };
  }

  // Column sums, mean removed: what the screen looks like from above.
  const profile = (a) => {
    const c = new Float32Array(width);
    for (let y = 0; y < lines; y++) {
      const row = y * width;
      for (let i = 0; i < width; i++) c[i] += a[row + i];
    }
    let m = 0;
    for (let i = 0; i < width; i++) m += c[i];
    m /= width;
    for (let i = 0; i < width; i++) c[i] -= m;
    return c;
  };

  const acc = fold(0);
  const shifts = [0];
  for (let f = 1; f < frames; f++) {
    const here = profile(fold(f * frameLen));
    const there = profile(acc);
    let best = -Infinity, at = 0;
    const score = new Float32Array(2 * search + 1);
    for (let sh = -search; sh <= search; sh++) {
      let a = 0;
      for (let i = 0; i < width; i++) a += there[i] * here[(i + sh + width) % width];
      score[sh + search] = a;
      if (a > best) { best = a; at = sh; }
    }
    // Between columns, through the parabola, because a frame rarely walks a whole one.
    const i = at + search;
    let shift = at;
    if (i > 0 && i < 2 * search) {
      const d = score[i - 1] - 2 * score[i] + score[i + 1];
      if (d !== 0) shift = at + Math.max(-1, Math.min(1, (0.5 * (score[i - 1] - score[i + 1])) / d));
    }
    const g = fold(f * frameLen + shift * (period / width));
    for (let k = 0; k < acc.length; k++) acc[k] += g[k];
    shifts.push(shift);
  }

  // Horizontal detail: the first thing a stack that did not line up loses.
  const detail = (a) => {
    let s = 0;
    for (let y = 0; y < lines; y++) {
      const row = y * width;
      for (let i = 1; i < width; i++) { const d = a[row + i] - a[row + i - 1]; s += d * d; }
    }
    return s;
  };
  const aligned = detail(acc) > detail(blind);
  const out = aligned ? acc : blind;
  for (let k = 0; k < out.length; k++) out[k] /= frames;
  return { rows: lines, cols: width, data: out, frames, aligned,
           shifts: aligned ? shifts : shifts.map(() => 0),
           walked: aligned ? Math.max(...shifts.map(Math.abs)) : 0 };
}

/**
 * A raster: how long a line is, and how many lines make a frame.
 *
 * Three steps, because the obvious two do not survive a real leak.
 *
 * First the signal is smoothed. A leak is a harmonic of the pixel clock, and at any
 * sensible sample rate that clock folds back into the passband — on the 20 Msps capture
 * this was written against, 25.175 MHz landed at 5.175 MHz, four samples a cycle. The
 * envelope correlates with *that* at 0.7 and with its own line structure at 0.37, so the
 * line period came out exactly twice too long and the frame search settled on two lines.
 * Averaging over a quarter of the shortest line the search will consider removes it and
 * keeps everything the search is actually for: four samples per line is already far below
 * anything that could distinguish one line period from another.
 *
 * Then the line period, straight out of the autocorrelation.
 *
 * Then the frame — a *whole number of lines*, so rather than search the autocorrelation
 * again and risk landing on a lag that is not a multiple, only multiples of the line
 * period are scored, each at the best lag within an eighth of a line of where it is
 * predicted so that a line period slightly off does not walk off the peak by the
 * hundredth multiple.
 *
 * And then the line period is taken back *out* of the frame lag. One correlation peak
 * locates a period to about a tenth of a sample; the same peak five hundred lines out
 * locates it five hundred times better. On that capture it is the difference between 180
 * ppm and 2 ppm — between a frame that shears sixty samples from top to bottom and one
 * that shears less than one.
 *
 * Averaging the frames is the point of finding the second period. A leak is a weak signal
 * and a still picture is the same frame over and over; adding them up is free signal.
 */
export function estimateRaster(x, count, sampleRate, {
  minLineUs = 4, maxLineUs = 2000, maxLines = 2048, maxSamples = 1 << 21,
} = {}) {
  const minLag = Math.max(4, Math.round((minLineUs * 1e-6) * sampleRate));
  const maxLag = Math.round((maxLineUs * 1e-6) * sampleRate);
  const smoothWin = Math.max(1, Math.round(minLag / 4));
  const acf = autocorrelate(x, count, { maxSamples, smoothWin });
  const line = estimatePeriod(x, { minLag, maxLag, acf });
  if (!line.value) return { ...line, smoothWin, lineSamples: 0, linesPerFrame: 0 };

  const P0 = line.value;
  const r = acf.r;
  const room = Math.min(acf.maxLag - 2, Math.floor(acf.n / 2));
  const window = Math.max(2, P0 / 8);
  let bestLines = 0, bestScore = -Infinity, bestLag = 0;
  const top = Math.min(maxLines, Math.floor(room / P0));
  for (let k = 2; k <= top; k++) {
    const from = Math.max(1, Math.round(k * P0 - window));
    const to = Math.min(room, Math.round(k * P0 + window));
    for (let lag = from; lag <= to; lag++) {
      if (r[lag] > bestScore) { bestScore = r[lag]; bestLines = k; bestLag = lag; }
    }
  }

  // A frame is only worth claiming if the whole frame repeats about as well as a line
  // does. A still picture does; a signal that happens to be periodic at a line does not.
  const frameConfident = bestLines > 2 && bestScore > 0.25;
  // Refine off the frame only when there are enough lines in it for that to be the more
  // precise of the two. Below about eight the parabola on the line peak is still better.
  const P = frameConfident && bestLines >= 8 ? refinePeak(r, bestLag) / bestLines : P0;

  return {
    ...line,
    smoothWin,
    lineSamples: P,
    lineUs: (P / sampleRate) * 1e6,
    linesPerFrame: bestLines,
    frameScore: bestScore,
    frameLag: bestLag,
    refined: P !== P0,
    frameConfident,
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

// ── Direct-sequence spread spectrum ────────────────────────────────────────
//
// A spread signal is wide, flat and nearly invisible until you know its code, at which
// point it collapses to a narrow one and reads like anything else. So the whole problem
// is three numbers and a name: the chip rate, where the chips start, and which code.
//
// Those are found in that order, because each one narrows the next. The chip rate comes
// from the transitions, which are visible without knowing anything; the chip phase falls
// out of the same transitions; and the code is then a correlation search over a chip
// stream rather than over samples, which is what makes searching several hundred codes
// something that finishes.

/**
 * The polarity of a BPSK signal, without recovering its carrier.
 *
 * `Re(x[i] · conj(x[i-1]))` is positive while the chip holds and negative where it
 * flips, and a frequency offset small compared with the sample rate only tilts it. So
 * the sign of that, accumulated, is a ±1 waveform that follows the chips — which is
 * exactly the shape the NRZ symbol estimator already knows how to read.
 *
 * The threshold is a fraction of the running signal power rather than zero: at zero,
 * every noise sample that happens to land the wrong way is a chip transition, and the
 * estimate comes back as one sample per chip no matter what the signal is doing.
 */
export function bpskPolarity(iq, count) {
  const out = new Float32Array(count);
  let power = 0;
  for (let i = 0; i < count; i++) power += iq[2 * i] * iq[2 * i] + iq[2 * i + 1] * iq[2 * i + 1];
  power /= Math.max(1, count);
  const floor = -0.3 * power;
  let s = 1;
  out[0] = s;
  for (let i = 1; i < count; i++) {
    const ar = iq[2 * i], ai = iq[2 * i + 1];
    const br = iq[2 * (i - 1)], bi = iq[2 * (i - 1) + 1];
    if (ar * br + ai * bi < floor) s = -s;
    out[i] = s;
  }
  return out;
}

/**
 * How long a chip is, and where the first one starts.
 *
 * The period is the NRZ estimator's problem and it is the same problem — runs of a ±1
 * waveform, and the answer is the longest period that explains all of them. The phase is
 * then the circular mean of where the transitions fell within that period, which is a
 * mean of angles rather than of numbers because a transition at 0.01 chips and one at
 * 0.99 chips are a hundredth of a chip apart and not most of one.
 */
export function estimateChip(iq, count, sampleRate) {
  const pol = bpskPolarity(iq, count);
  const est = estimateNrzSymbol(pol, 0, sampleRate);
  if (!(est.value > 0)) {
    return { samplesPerChip: 0, chipRate: 0, phase: 0, confident: false,
             reason: 'no chip transitions to measure', agreement: est.agreement || 0 };
  }
  const sps = (est.value * 1e-6) * sampleRate;
  if (sps < 2) {
    return { samplesPerChip: sps, chipRate: sampleRate / sps, phase: 0, confident: false,
             reason: 'fewer than two samples per chip — the capture is too slow for this signal',
             agreement: est.agreement };
  }

  let sx = 0, sy = 0, n = 0;
  for (let i = 1; i < count; i++) {
    if (pol[i] === pol[i - 1]) continue;
    const a = (2 * Math.PI * (i % sps)) / sps;
    sx += Math.cos(a); sy += Math.sin(a); n++;
  }
  let phase = 0;
  if (n > 0) {
    // `atan2` returns the offset nearest zero, in (-sps/2, sps/2], which is what is
    // wanted: a mean transition instant a hair *before* the start of the window is the
    // same boundary as one at zero, not one a whole chip later. Rotating it up into
    // [0, sps) instead — the obvious way to make a phase positive — starts the chip
    // stream one chip in, and that costs the first bit of the message.
    //
    // Which is not an abstract loss. The bits after it still decode perfectly, so the
    // symptom is a clean-looking decode of a message shifted by one bit: every byte is
    // the tail of one character and the head of the next, and nothing reports an error.
    phase = (Math.atan2(sy, sx) / (2 * Math.PI)) * sps;
    if (phase < 0) phase = 0;                   // there is nothing before the window
  }

  return {
    samplesPerChip: sps,
    chipRate: sampleRate / sps,
    phase,
    transitions: n,
    agreement: est.agreement,
    confident: est.confident && n > 20,
    reason: est.confident ? '' : 'the runs do not agree on one chip length',
  };
}

/**
 * Samples to chips: integrate and dump, one complex value per chip.
 *
 * Integrating the whole chip rather than sampling its middle is the matched filter for a
 * rectangular chip, and it is worth about 3 dB over a point sample — which for a code
 * search is the difference between the right code standing out and the top twenty being
 * a coin toss.
 */
export function chipStream(iq, count, samplesPerChip, phase, maxChips = 1 << 18) {
  const n = Math.max(0, Math.min(maxChips, Math.floor((count - phase) / samplesPerChip)));
  const re = new Float32Array(n), im = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const a = Math.round(phase + k * samplesPerChip);
    const b = Math.round(phase + (k + 1) * samplesPerChip);
    let sr = 0, si = 0;
    for (let i = a; i < b; i++) { sr += iq[2 * i]; si += iq[2 * i + 1]; }
    const m = Math.max(1, b - a);
    re[k] = sr / m; im[k] = si / m;
  }
  return { re, im, n };
}

/**
 * The carrier offset of a BPSK signal, without knowing its data.
 *
 * Squaring doubles the phase, and (±1 · e^{jφ})² is e^{j2φ} either way — so the data
 * disappears and what is left is a tone at twice the offset. The angle the squared
 * signal advances per sample is then the whole estimate, and it needs no transform.
 *
 * This has to happen *before* the code search, not after it. A correlation over one code
 * period is a coherent integration over that whole period, and a 900 Hz offset at 60
 * kchip/s turns a 127-chip integration into two full rotations that sum to nothing. The
 * right code then scores no better than the wrong ones, and the search reports — quite
 * correctly, and quite uselessly — that this is not any code it knows.
 */
export function estimateBpskOffset(iq, count, sampleRate) {
  if (count < 3) return { hz: 0, confident: false, reason: 'not enough samples' };
  let ax = 0, ay = 0, mag = 0;
  let pr = iq[0] * iq[0] - iq[1] * iq[1], pi = 2 * iq[0] * iq[1];
  for (let i = 1; i < count; i++) {
    const xr = iq[2 * i], xi = iq[2 * i + 1];
    const qr = xr * xr - xi * xi, qi = 2 * xr * xi;
    ax += qr * pr + qi * pi;
    ay += qi * pr - qr * pi;
    mag += Math.sqrt(qr * qr + qi * qi);
    pr = qr; pi = qi;
  }
  const norm = Math.sqrt(ax * ax + ay * ay) / (mag * mag / (count - 1) || 1);
  return {
    hz: (Math.atan2(ay, ax) * sampleRate) / (4 * Math.PI),
    // How nearly the squared signal is one tone rather than a cloud. Low means either
    // there is no carrier to find or this is not BPSK.
    coherence: Math.min(1, norm),
    confident: norm > 0.2,
  };
}

/** Spin a chip stream back by a fixed angle per chip, in place. */
export function derotateChips(chips, radiansPerChip) {
  for (let k = 0; k < chips.n; k++) {
    const a = -radiansPerChip * k;
    const c = Math.cos(a), s = Math.sin(a);
    const re = chips.re[k], im = chips.im[k];
    chips.re[k] = re * c - im * s;
    chips.im[k] = re * s + im * c;
  }
  return chips;
}

function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

/** The inverse transform, by conjugating either side of the forward one. */
function ifft(buf) {
  for (let i = 1; i < buf.length; i += 2) buf[i] = -buf[i];
  fft(buf);
  const n = buf.length / 2;
  for (let i = 0; i < buf.length; i += 2) { buf[i] /= n; buf[i + 1] = -buf[i + 1] / n; }
  return buf;
}

/**
 * Correlate a chip stream against one code at every offset, in one transform.
 *
 * Done directly this costs L² per code per period, which for a length-1023 code and
 * twenty periods is twenty million multiply-accumulates — per candidate, and there are
 * hundreds of candidates. Through the transform it is three passes of N log N, the
 * forward transform of the data is shared by every code of the same length, and the
 * whole search finishes in about the time it takes to notice it started.
 */
function correlateCode(Y, N, code, useChips) {
  const L = code.length;
  const C = new Float32Array(2 * N);
  for (let i = 0; i < L; i++) C[2 * i] = code[i];
  fft(C);
  const R = new Float32Array(2 * N);
  for (let i = 0; i < N; i++) {
    const yr = Y[2 * i], yi = Y[2 * i + 1];
    const cr = C[2 * i], ci = -C[2 * i + 1];      // conjugate: correlation, not convolution
    R[2 * i] = yr * cr - yi * ci;
    R[2 * i + 1] = yr * ci + yi * cr;
  }
  ifft(R);
  return R;
}

/**
 * Which code this is, and where it starts.
 *
 * A code that is right gives a correlation of L every code period; a code that is wrong
 * gives about √L, wherever you put it. So the score is the mean correlation magnitude
 * over the periods in hand, divided by what a perfect match would give — near 1 for the
 * right code, near 1/√L for every other one — and the gap between the best and the
 * runner-up is the evidence, not the score by itself (ADR-0017). One code scoring 0.9
 * where the next scores 0.1 is an answer. Two codes scoring 0.4 is not.
 */
export function searchCodes(chips, candidates, { periods = 12, minPeriods = 8, top = 6 } = {}) {
  if (!chips.n || !candidates.length) return { ranked: [], reason: 'nothing to search' };

  let energy = 0;
  for (let i = 0; i < chips.n; i++) energy += chips.re[i] * chips.re[i] + chips.im[i] * chips.im[i];
  const rms = Math.sqrt(energy / chips.n) || 1;

  // Grouped by length so the forward transform of the chip stream is computed once for
  // each distinct length rather than once per candidate.
  const byLength = new Map();
  for (const c of candidates) {
    if (!byLength.has(c.length)) byLength.set(c.length, []);
    byLength.get(c.length).push(c);
  }

  const ranked = [];
  const skipped = [];
  for (const [L, group] of byLength) {
    const use = Math.min(chips.n, periods * L + L);
    // A code long enough to reach across the whole capture is a code that cannot be
    // wrong: the peak is then the best of L offsets averaged over two or three values,
    // and the best of two thousand noisy numbers is always a big one. A length-2047
    // m-sequence scored 6 against a 4,608-chip capture of something else entirely and
    // beat the code that was actually there.
    //
    // So a candidate has to fit several times over or it is not tried, and the report
    // says which ones were left out. "Nothing matched" and "nothing long enough to
    // match was tried" are different answers (ADR-0031).
    if (Math.floor(chips.n / L) < minPeriods) {
      skipped.push({ length: L, count: group.length, have: Math.floor(chips.n / L),
                     need: minPeriods });
      continue;
    }
    const N = nextPow2(use + L);
    const Y = new Float32Array(2 * N);
    for (let i = 0; i < use; i++) { Y[2 * i] = chips.re[i]; Y[2 * i + 1] = chips.im[i]; }
    fft(Y);

    for (const cand of group) {
      const R = correlateCode(Y, N, cand.chips, use);
      const mean = new Float64Array(L);
      let bestOffset = 0, total = 0;
      for (let off = 0; off < L; off++) {
        let acc = 0, k = 0;
        for (let p = off; p + L <= use; p += L) {
          const re = R[2 * p], im = R[2 * p + 1];
          acc += Math.sqrt(re * re + im * im);
          k++;
        }
        mean[off] = k ? acc / k : 0;
        total += mean[off];
        if (mean[off] > mean[bestOffset]) bestOffset = off;
      }
      // Peak against the rest of the same code's own offsets. That is the statistic that
      // means the same thing for a 7-chip word and a 1023-chip one: a wrong code has no
      // offset it likes, so its peak sits about where its average does. A raw
      // correlation score does not compare across lengths at all — a Barker 7 correlates
      // with noise at 1/√7, which is 0.38, and next to a noisy 127-chip hit at 0.35 it
      // wins and is wrong.
      const background = L > 1 ? (total - mean[bestOffset]) / (L - 1) : mean[bestOffset];
      ranked.push({
        code: cand, offset: bestOffset,
        score: mean[bestOffset] / (L * rms),
        psr: mean[bestOffset] / (background || 1e-12),
        periods: Math.floor(use / L),
      });
    }
  }

  ranked.sort((a, b) => b.psr - a.psr);
  const best = ranked[0];
  // The runner-up has to be a *different* code. A Gold set contains rotations of the
  // same sequence, and the second-place entry is routinely the right answer read at a
  // different offset — reporting that as "no clear winner" would throw away every hit.
  const rival = ranked.find((r) => r.code.id !== best?.code.id);
  return {
    ranked: ranked.slice(0, top),
    best: best || null,
    margin: best && rival ? best.psr / (rival.psr || 1e-9) : Infinity,
    rival: rival || null,
    tried: ranked.length,
    skipped,
  };
}

/**
 * The bits, once the code is known.
 *
 * One correlation per code period is one soft symbol, and it arrives with whatever phase
 * the carrier happened to have. Squaring removes the data — (±1·e^{jθ})² is e^{j2θ}
 * either way — so the residual frequency offset can be measured from the symbols
 * themselves without a training sequence, and then divided out.
 *
 * What squaring cannot resolve is the sign of the whole stream, because it was thrown
 * away to get the frequency. That is not a flaw to be engineered around: a BPSK signal
 * with no known preamble genuinely does not say which polarity is a one, and the honest
 * thing is to hand back both and let something downstream — a CRC, a sync word, or a
 * human reading text — decide. `invert` is that decision.
 */
export function despread(chips, code, offset, { invert = false } = {}) {
  const L = code.length;
  const K = Math.max(0, Math.floor((chips.n - offset) / L));
  const sr = new Float32Array(K), si = new Float32Array(K);
  for (let k = 0; k < K; k++) {
    const base = offset + k * L;
    let ar = 0, ai = 0;
    for (let i = 0; i < L; i++) {
      const c = code[i];
      ar += chips.re[base + i] * c;
      ai += chips.im[base + i] * c;
    }
    sr[k] = ar / L; si[k] = ai / L;
  }
  if (K < 2) return { bits: new Uint8Array(0), symbols: K, eye: 0, offsetHz: 0 };

  // Frequency, from the squared symbols: the angle each one advances on the last.
  let dx = 0, dy = 0;
  let px = sr[0] * sr[0] - si[0] * si[0], py = 2 * sr[0] * si[0];
  for (let k = 1; k < K; k++) {
    const qx = sr[k] * sr[k] - si[k] * si[k], qy = 2 * sr[k] * si[k];
    dx += qx * px + qy * py;
    dy += qy * px - qx * py;
    px = qx; py = qy;
  }
  const step = Math.atan2(dy, dx) / 2;           // radians per symbol

  // Then the starting phase, from the same squared symbols with the rotation taken out.
  let ax = 0, ay = 0;
  for (let k = 0; k < K; k++) {
    const qx = sr[k] * sr[k] - si[k] * si[k], qy = 2 * sr[k] * si[k];
    const a = -2 * step * k;
    const c = Math.cos(a), s = Math.sin(a);
    ax += qx * c - qy * s;
    ay += qx * s + qy * c;
  }
  const theta0 = Math.atan2(ay, ax) / 2;

  const bits = new Uint8Array(K);
  let on = 0, off = 0;
  for (let k = 0; k < K; k++) {
    const a = -(theta0 + step * k);
    const c = Math.cos(a), s = Math.sin(a);
    const re = sr[k] * c - si[k] * s;
    const im = sr[k] * s + si[k] * c;
    bits[k] = (re > 0) !== invert ? 1 : 0;
    on += Math.abs(re); off += Math.abs(im);
  }
  return {
    bits, symbols: K,
    // How much of each symbol landed on the axis it was supposed to. One is a clean
    // decision; a half is a coin toss dressed as a decode.
    eye: on / (on + off || 1),
    radiansPerSymbol: step,
  };
}

/**
 * Root-raised-cosine taps, `span` symbols long at `sps` samples per symbol.
 *
 * The matched half of the pair. A shaped transmitter sends root-raised-cosine and the
 * receiver applies the same filter, because RRC × RRC is raised cosine, and raised
 * cosine is the pulse that is zero at every symbol instant but its own. Either half
 * alone is not — which is why sampling a transmitter's output straight off the wire
 * decodes anyway on a clean signal and falls apart on a dirty one.
 *
 * The three cases are the singularities of the closed form: `k = 0`, and `|4αk| = 1`
 * where the denominator vanishes. Normalized by `sqrt(sps)` so a symbol comes through
 * at unit scale, which is what M17's own tap table does — `libm17/math/rrc.c` agrees
 * with this to six decimal places at α = 0.5, span 8, sps 10, and that agreement is the
 * evidence that the formula is the same one.
 */
export function rrcTaps(alpha, span, sps) {
  // An even `n` means an odd number of taps, which means the pulse peaks exactly on a
  // tap and `fir`'s centring is exact. Rounded to the nearest even rather than truncated
  // because `sps` need not be a whole number: a tuner picks its own decimation from the
  // channel width (ADR-0017), so 4800 symbols a second arrives at 32 kS/s about as often
  // as at 48, and 6.667 samples per symbol is an ordinary thing to be handed.
  const n = 2 * Math.round((span * sps) / 2), t = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const k = (i - n / 2) / sps;
    let v;
    if (Math.abs(k) < 1e-8) {
      v = 1 - alpha + (4 * alpha) / Math.PI;
    } else if (alpha > 0 && Math.abs(Math.abs(4 * alpha * k) - 1) < 1e-8) {
      v = (alpha / Math.SQRT2) * ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * alpha)) +
                                  (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * alpha)));
    } else {
      v = (Math.sin(Math.PI * k * (1 - alpha)) + 4 * alpha * k * Math.cos(Math.PI * k * (1 + alpha))) /
          (Math.PI * k * (1 - (4 * alpha * k) ** 2));
    }
    t[i] = v / Math.sqrt(sps);
  }
  return t;
}

/** Linear interpolation into a real array, for a symbol instant between two samples. */
function lerp(x, at) {
  const i = Math.floor(at), f = at - i;
  if (i < 0) return x[0] || 0;
  if (i + 1 >= x.length) return x[x.length - 1] || 0;
  return x[i] * (1 - f) + x[i + 1] * f;
}

/**
 * How well a run of samples sits on a set of levels, once centered and scaled to fit.
 *
 * Both the center and the scale come from the data, and both have to, for reasons that
 * are not symmetric. The scale because a discriminator's output is in whatever units the
 * capture happened to be in. The center because an FM discriminator carries the tuning
 * error as a DC term, and a DC term turns a four-level decision into a three-and-a-bit
 * one.
 *
 * Percentiles rather than the mean and the maximum, and that is the whole trick here.
 * Measured on `m17-packet-encode`'s own baseband: the mean of the span is 0.43 where the
 * signal's actual center is 0, because the symbol alphabet is not used evenly. Subtracting
 * that mean cost 12% of the eye and turned a symmetric ±9.49 preamble into 2.25 against
 * −3.00. The 5th and 95th percentiles are the outer levels, whatever the distribution
 * between them does.
 */
function levelFit(sym, levels, quantile = 0.05) {
  const outer = levels[levels.length - 1];
  const pick = (sorted, q) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))];

  // Which of these symbols are signal, decided among the symbols themselves.
  //
  // This is the second of two gates and they catch different things. `candidates` splits
  // the *span* into loud and quiet stretches, which is what finds a burst inside seconds
  // of something else. This one works within whatever it is handed: a run that is mostly
  // signal with a little silence in it still wants the silence kept out of its
  // percentiles, and there is no block structure left to use by then.
  const all = Float64Array.from(sym).sort();
  const rest = pick(all, 0.5);
  const dev = Float64Array.from(sym, (v) => Math.abs(v - rest)).sort();
  const gate = 0.3 * pick(dev, 0.99);
  const active = [];
  for (const v of sym) if (Math.abs(v - rest) > gate) active.push(v);
  // Under a fiftieth of what was handed over is not a gate any more, it is a guess.
  const use = active.length >= Math.max(16, sym.length * 0.02) ? active : sym;

  const sorted = Float64Array.from(use).sort();
  const hi = pick(sorted, 1 - quantile), lo = pick(sorted, quantile);
  const center = (hi + lo) / 2;
  const gain = outer / Math.max(1e-12, (hi - lo) / 2);
  let err = 0;
  for (let i = 0; i < use.length; i++) {
    const v = (use[i] - center) * gain;
    let best = Infinity;
    for (const L of levels) { const d = Math.abs(v - L); if (d < best) best = d; }
    err += best;
  }
  // 0 is every symbol dead on a level; 1 is every symbol as far from one as it can get,
  // which for evenly spaced levels is half the spacing.
  const halfStep = levels.length > 1 ? Math.abs(levels[1] - levels[0]) / 2 : 1;
  return { center, gain, err: err / (use.length || 1) / halfStep };
}

// Where to read the outer levels off the sorted symbols. See the note at the call site:
// which one is right depends on how much of what is being scored is actually the burst,
// and that is measured rather than assumed.
const QUANTILES = [0.05, 0.25];

function candidates(x, count, sampleRate, blockSeconds = 0.02) {
  const blk = Math.max(8, Math.round(blockSeconds * sampleRate));
  const nb = Math.floor(count / blk);
  // Under a handful of blocks there are no two populations to find, only one short burst.
  if (nb < 8) return { blk, nb: 0, masks: [null] };

  const level = new Float32Array(nb);
  for (let b = 0; b < nb; b++) {
    let m = 0;
    for (let k = 0; k < blk; k++) m += x[b * blk + k];
    m /= blk;
    let v = 0;
    for (let k = 0; k < blk; k++) { const d = x[b * blk + k] - m; v += d * d; }
    level[b] = Math.sqrt(v / blk);
  }

  const cut = otsuThreshold(level).value;
  const side = (want) => {
    const mask = new Uint8Array(nb);
    let kept = 0;
    for (let b = 0; b < nb; b++) if ((level[b] <= cut) === want) { mask[b] = 1; kept++; }
    return kept && kept < nb ? mask : null;
  };
  // `null` means "every symbol counts", which is the right answer when there is only one
  // population and the wrong one to arrive at by splitting it anyway.
  return { blk, nb, masks: [null, side(true), side(false)].filter((m, i) => i === 0 || m) };
}

export function softSymbols(x, count, sampleRate, symbolRate, opts = {}) {
  const { alpha = 0.5, span = 8, levels = [-3, -1, 1, 3], steps = 32, matched = true } = opts;
  const sps = sampleRate / symbolRate;
  const none = { symbols: new Float32Array(0), n: 0, offset: 0, center: 0, gain: 1, eye: 0, sps };
  if (!(sps >= 2) || !(count > 0)) return none;

  // No DC removal before the filter: the filter is linear, so whatever DC is there comes
  // through scaled and `levelFit` takes it out where it can see all four levels at once.
  // Filtered once, here — every candidate below reads the same samples, and only differs
  // in which of them it is allowed to score.
  const y = matched ? fir(x.subarray ? x.subarray(0, count) : x, rrcTaps(alpha, span, sps)) : x;
  // Only whole symbols, and only ones the filter did not truncate: `fir` clamps its taps
  // at the ends rather than zero-padding, so the first and last half-span of samples are
  // filtered with part of the filter and are not symbols yet.
  const guard = matched ? Math.ceil(span / 2) : 0;
  const n = Math.max(0, Math.floor(count / sps) - 2 * guard);
  if (!n) return none;

  // Masks rather than copied samples, which matters and is easy to get wrong: lifting the
  // kept blocks into a new array and fitting that would break the symbol grid, because a
  // block is a whole number of *samples* and almost never a whole number of symbols. The
  // phase measured on the copy would then be a phase into the copy.
  const { blk, masks } = candidates(x, count, sampleRate, opts.blockSeconds);

  const probe = new Float32Array(n);
  const score = new Float32Array(n);
  let best = null;
  for (const mask of masks) {
    for (let s = 0; s < steps; s++) {
      const off = guard * sps + (s / steps) * sps;
      let m = 0;
      for (let k = 0; k < n; k++) {
        const at = off + k * sps;
        probe[k] = lerp(y, at);
        if (!mask || mask[Math.floor(at / blk)]) score[m++] = probe[k];
      }
      if (m < 16) continue;
      // Two readings of the same symbols, because where the outer levels are is itself a
      // guess when part of the span is not signal. The 5th/95th percentile is right when
      // most of what is scored is the burst; the 25th/75th is right when it is not, and
      // the wider one quietly puts the outer level out among whatever else is in the span.
      for (const q of QUANTILES) {
        const fit = levelFit(score.subarray(0, m), levels, q);
        if (!best || fit.err < best.err) best = { err: fit.err, off, center: fit.center, gain: fit.gain };
      }
    }
  }
  if (!best) return none;

  // The winning fit's numbers, applied to the span as it actually is — a mask was only
  // ever a way to measure the instant, the center and the gain.
  const symbols = new Float32Array(n);
  for (let k = 0; k < n; k++) symbols[k] = (lerp(y, best.off + k * sps) - best.center) * best.gain;
  return { symbols, n, offset: best.off, center: best.center, gain: best.gain,
           eye: 1 - best.err, sps };
}

/**
 * The same read, with the instant, the center and the gain already decided.
 *
 * `softSymbols` measures those three from a window; this applies them. The split is what
 * keeps a live view from jittering: measuring per frame would move the sampling instant
 * every time the window slid, so the measurement happens once, lands on the node as
 * evidence anybody can read (ADR-0017), and every frame after that is arithmetic.
 *
 * `first` is the absolute index, in parent samples, of the symbol this window starts on —
 * so consecutive windows land on the same symbol grid rather than each on their own.
 */
export function softSymbolsAt(x, count, sampleRate, symbolRate, at) {
  const { phase = 0, center = 0, gain = 1, alpha = 0.5, span = 8, matched = true,
          first = 0, symbols: want = 0, invert = false } = at;
  const sps = sampleRate / symbolRate;
  const n = Math.max(0, want || Math.floor(count / sps));
  const out = new Float32Array(n);
  if (!(sps >= 2) || !(count > 0) || !n) return out;
  const y = matched ? fir(x.subarray ? x.subarray(0, count) : x, rrcTaps(alpha, span, sps)) : x;
  const sign = invert ? -1 : 1;
  for (let k = 0; k < n; k++) {
    out[k] = sign * (lerp(y, (first + k) * sps + phase) - center) * gain;
  }
  return out;
}
