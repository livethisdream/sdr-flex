// A deterministic synthetic RF scene, generated lazily from absolute sample index.
//
// Nothing is stored: read(n, count) synthesises exactly the window asked for. That
// makes all history scrubbable for free, which is the promise ADR-0005 makes about
// real sources — here it costs nothing because the scene is a pure function of time.

import { voice, VOICE_RATE } from './voice.js';
import { rdsGroups, RDS_BPS, RDS_SUBCARRIER } from './rds.js';
import { fft } from './dsp.js';

export const SOURCE = {
  centerHz: 433_920_000,
  sampleRate: 480_000,
  name: 'synthetic · 433.92 MHz',
};

// The burst payload the PWM slicer should recover: 0xAAAA preamble, then text. Two bytes
// of nothing in particular taught nobody anything; a word says the decode worked.
export const MESSAGE = 'SDR FLEX';
export const PAYLOAD = [0xaa, 0xaa, ...Array.from(MESSAGE, (c) => c.charCodeAt(0))];
export const SYMBOL_US = 417;
export const BURST_PERIOD_S = 0.9;

/**
 * What is in the band, and what each thing is there to be caught with. The
 * detectors need targets, and a scene with only an OOK burst in it can only ever
 * demonstrate one detector.
 */
export const SIGNALS = [
  { offsetHz: -180_000, widthHz:   2_000, kind: 'cw',   label: 'CW, Morse call' },
  { offsetHz: -140_000, widthHz:  16_000, kind: 'nbfm', label: 'NBFM, touch-tones' },
  // A sideband is all on one side of its carrier, so its mark starts at the carrier.
  { offsetHz:  -90_000, widthHz:   3_000, kind: 'ssb',  label: 'USB, two tones', side: 'upper' },
  { offsetHz:  -25_000, widthHz:  50_000, kind: 'ook',  label: 'OOK, "SDR FLEX"' },
  { offsetHz:  130_000, widthHz: 180_000, kind: 'wbfm', label: 'WBFM, voice + RDS' },
];

// NBFM: touch-tone digits at ±3 kHz deviation, which the DTMF decoder that ships with
// the client reads back. 7373539 is SDRFLEX on a phone keypad. Each digit is two tones
// for 120 ms, then 50 ms of carrier, and the number repeats after 250 ms: dialer speed,
// and tones more than half the time, so a 2 s look at it reads as modulated.
const FM_OFF = -140_000, FM_DEV = 3_000;
export const DIGITS = '7373539';
const DTMF_ROWS = { 1: 697, 2: 697, 3: 697, 4: 770, 5: 770, 6: 770, 7: 852, 8: 852, 9: 852, 0: 941 };
const DTMF_COLS = { 1: 1209, 4: 1209, 7: 1209, 2: 1336, 5: 1336, 8: 1336, 0: 1336, 3: 1477, 6: 1477, 9: 1477 };
const TONE_S = 0.12, DIGIT_S = 0.17, DTMF_GAP_S = 0.25;
const DTMF_PERIOD_S = DIGITS.length * DIGIT_S + DTMF_GAP_S;
const DTMF = Array.from(DIGITS, (d) => [DTMF_ROWS[d], DTMF_COLS[d]]);
// Each tone deviates the carrier by half the total, so the pair peaks at ±3 kHz. Its phase
// is (dev/f) sin(2πf(t - start)) while it sounds and holds where it stopped afterwards, so
// the carrier never jumps; the held phase after each digit is summed here once.
const DTMF_HOLD = DTMF.map((fs) => fs.reduce((a, f) => a + (FM_DEV / 2 / f) * Math.sin(2 * Math.PI * f * TONE_S), 0));
const DTMF_PERIOD_HOLD = DTMF_HOLD.reduce((a, b) => a + b, 0);

/** The NBFM carrier's phase offset from its message at time t, in radians. */
export function dtmfPhase(t) {
  const k = Math.floor(t / DTMF_PERIOD_S);
  const phase = t - k * DTMF_PERIOD_S;
  let held = k * DTMF_PERIOD_HOLD;
  const d = Math.floor(phase / DIGIT_S);
  for (let i = 0; i < Math.min(d, DTMF.length); i++) held += DTMF_HOLD[i];
  if (d >= DTMF.length) return held;
  const on = phase - d * DIGIT_S;
  if (on >= TONE_S) return held + DTMF_HOLD[d];
  const [f1, f2] = DTMF[d];
  return held + (FM_DEV / 2 / f1) * Math.sin(2 * Math.PI * f1 * on) + (FM_DEV / 2 / f2) * Math.sin(2 * Math.PI * f2 * on);
}

// WBFM: the wideband half of the FM pair — a station that speaks and names itself.
//
// What used to sit at this end of the band was a comb of sixteen static phasors called
// a "wideband hump", and after that two test tones. Now it is a broadcast: a spoken line
// (voice.js), the 19 kHz pilot, and RDS on the 57 kHz subcarrier naming the station, which
// redsea reads on a box.
//
// The voice is **pre-emphasized**, as a broadcast transmitter does: treble lifted by
// 1 + j2πfτ with τ = 75 µs, which the receiver is supposed to undo. The demod hands the
// composite on as sent and Listen undoes it; `web/test/detectors.test.mjs` checks that the
// voice comes back with its own balance of treble to bass.
//
// **Broadcast-shaped rather than broadcast.** A real ±75 kHz stereo signal is a quarter
// of a megahertz of composite baseband, which is most of this 480 kHz band and would
// leave nowhere for the other four. ±65 kHz, mono, with the pilot and RDS, keeps the
// signal's energy inside about ±90 kHz; only RDS's own thin sidebands reach further.
//
// Every piece is a closed form in time, so the scene stays a pure function of the sample
// index: the voice is a Catmull-Rom curve through its samples, whose integral is a
// polynomial per segment, and RDS's half-bits start on zeros of sin(2π·57 kHz·t) (57 000 /
// 2 375 is 24), so its phase never accumulates. The whole broadcast repeats every 6.656 s:
// 76 RDS groups, a whole number of 57 kHz and 19 kHz cycles, and 106 496 voice samples.
const WFM_OFF = 130_000, WFM_DEV = 65_000;
const WFM_PILOT = 19_000;
const PREEMPH_S = 75e-6;                             // the US time constant; 50 µs in Europe
// Shares of the deviation: the standard's 10% pilot, a few percent for RDS as stations run
// it, and the rest for the voice.
const WFM_AUDIO_DEV = 0.80 * WFM_DEV, WFM_RDS_DEV = 0.04 * WFM_DEV;
const WFM_PILOT_BETA = (0.10 * WFM_DEV) / WFM_PILOT;
const WFM_LOOP_S = 6.656;
const WFM_LEAD_S = 0.3;                              // silence before the voice starts
export const STATION = { ps: 'SDR FLEX', radiotext: 'Synthetic broadcast from SDR Flex' };

/**
 * What a station's audio processor does to a voice before it goes on the air: a compressor
 * that holds speech near full deviation. Raw speech is mostly quiet between rare peaks, and
 * measured that way it deviated this carrier by 14 kHz, which reads as narrowband. Gain
 * follows a smoothed envelope, 4:1 above a threshold 20 dB under the peak, so the curve
 * through the samples stays smooth.
 */
function compress(x) {
  const attack = 1 - Math.exp(-1 / (0.005 * VOICE_RATE)), release = 1 - Math.exp(-1 / (0.15 * VOICE_RATE));
  const thr = 0.1, ratio = 4;
  const env = new Float64Array(x.length);
  for (let pass = 0, e = 0; pass < 2; pass++) {
    for (let i = 0; i < x.length; i++) {
      const v = Math.abs(x[i]);
      e += (v > e ? attack : release) * (v - e);
      env[i] = e;
    }
  }
  for (let i = 0; i < x.length; i++) {
    const e = Math.max(env[i], 1e-4);
    x[i] *= e > thr ? Math.pow(e / thr, 1 / ratio - 1) : 1;
  }
}

/** Catmull-Rom coefficients per segment of a looped series, and its integral at each knot. */
function curve(x) {
  const n = x.length, a = new Float64Array(n * 4), P = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const p0 = x[(i - 1 + n) % n], p1 = x[i], p2 = x[(i + 1) % n], p3 = x[(i + 2) % n];
    const a1 = 0.5 * (p2 - p0), a2 = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3, a3 = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
    a[i * 4] = p1; a[i * 4 + 1] = a1; a[i * 4 + 2] = a2; a[i * 4 + 3] = a3;
    P[i + 1] = P[i] + (p1 + a1 / 2 + a2 / 3 + a3 / 4) / VOICE_RATE;
  }
  return { a, P };
}

// The voice as spoken (compressed, as a station's processor leaves it), and as sent: pre-
// emphasized, set so its 99.5th-percentile peak is full deviation, and soft-limited above
// 80% the way a station's final limiter keeps the rare treble spike from overdeviating.
// Leveled by the single highest spike instead, typical speech sat at a third of full
// deviation and read as narrowband.
const VOICE = (() => {
  const clip = voice();
  const n = Math.round(WFM_LOOP_S * VOICE_RATE);
  const lead = Math.round(WFM_LEAD_S * VOICE_RATE);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = i >= lead && i - lead < clip.length ? clip[i - lead] : 0;
  compress(x);
  // Exactly 1 + j2πfτ, in the frequency domain: a difference of neighboring samples at
  // 16 kHz lifts 4 kHz by 2 dB less than the curve does. The voice has silence at both
  // ends, so padding to a power of two and cutting back changes nothing.
  const N = 1 << Math.ceil(Math.log2(n)), buf = new Float32Array(N * 2);
  for (let i = 0; i < n; i++) buf[i * 2] = x[i];
  fft(buf);
  for (let k = 0; k < N; k++) {
    const w = 2 * Math.PI * PREEMPH_S * VOICE_RATE * (k < N / 2 ? k : k - N) / N;
    const re = buf[k * 2], im = buf[k * 2 + 1];
    buf[k * 2] = re - w * im;
    buf[k * 2 + 1] = -(im + w * re);                 // conjugated, so a second forward FFT inverts
  }
  fft(buf);
  const pe = new Float64Array(n);
  for (let i = 0; i < n; i++) pe[i] = buf[i * 2] / N;
  const level = Float64Array.from(pe, Math.abs).sort()[Math.floor(n * 0.995)];
  let mean = 0;
  for (let i = 0; i < n; i++) {
    const v = pe[i] / level, m = Math.abs(v);
    pe[i] = m < 0.8 ? v : Math.sign(v) * (0.8 + 0.2 * Math.tanh((m - 0.8) / 0.2));
    mean += pe[i];
  }
  mean /= n;
  for (let i = 0; i < n; i++) pe[i] -= mean;          // so its integral over the loop is zero
  return { n, x, sent: curve(pe) };
})();

/** The voice as spoken, before pre-emphasis, at time t: what a receiver should give back. */
export function broadcastAudio(t) {
  const { n, x } = VOICE;
  const u0 = (t - Math.floor(t / WFM_LOOP_S) * WFM_LOOP_S) * VOICE_RATE;
  const i = Math.min(n - 1, Math.floor(u0)), u = u0 - i;
  const p0 = x[(i - 1 + n) % n], p1 = x[i], p2 = x[(i + 1) % n], p3 = x[(i + 2) % n];
  return p1 + u * (0.5 * (p2 - p0) + u * ((p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3) + u * (-0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3)));
}

// The scene's rate is 30 voice samples to one, and the loop a whole number of scene samples,
// so the per-sample work below is integer indexing rather than floating-point time.
const PER_VOICE = SOURCE.sampleRate / VOICE_RATE;
const LOOP_N = Math.round(WFM_LOOP_S * SOURCE.sampleRate);

/** The FM phase the voice as sent puts on the carrier at scene sample m of the loop. */
function voicePhase(m) {
  const { a, P } = VOICE.sent;
  const i = (m / PER_VOICE) | 0, u = (m - i * PER_VOICE) / PER_VOICE, k = i * 4;
  const integral = P[i] + u * (a[k] + u * (a[k + 1] / 2 + u * (a[k + 2] / 3 + u * a[k + 3] / 4))) / VOICE_RATE;
  return 2 * Math.PI * WFM_AUDIO_DEV * integral;
}

// RDS: the groups for one loop, differentially encoded once; biphase is applied per half-bit.
const RDS_HALF = (() => {
  const bits = rdsGroups({ ps: STATION.ps, radiotext: `${STATION.radiotext}\r`, groups: Math.round(WFM_LOOP_S * RDS_BPS / 104) });
  const half = new Int8Array(bits.length * 2);
  let prev = 0;
  for (let i = 0; i < bits.length; i++) {
    prev ^= bits[i];
    half[2 * i] = prev ? 1 : -1;
    half[2 * i + 1] = prev ? -1 : 1;
  }
  return half;
})();

export const WFM_INFO = { offsetHz: WFM_OFF, devHz: WFM_DEV, pilotHz: WFM_PILOT, deemphasisUs: PREEMPH_S * 1e6 };
// USB: two audio tones above a suppressed carrier. Two, because one tone is
// indistinguishable from a carrier and would prove nothing about sideband choice.
const SSB_OFF = -90_000, SSB_TONES = [700, 1_150];
// CW: a real call in Morse at about 11 words a minute, which a Morse decoder can read
// and a person can copy by ear.
const CW_OFF = -180_000, CW_DIT_S = 0.11;
export const CALL = 'CQ CQ DE SDRFLEX';
const MORSE = {
  C: '-.-.', Q: '--.-', D: '-..', E: '.', S: '...', R: '.-.', F: '..-.', L: '.-..', X: '-..-',
};
// One entry per dit of time: a dah is three on, a gap inside a letter one off, between
// letters three, between words seven — and seven more after the call before it repeats.
const KEYING = (() => {
  const units = [];
  for (const word of CALL.split(' ')) {
    for (const ch of word) {
      for (const el of MORSE[ch]) units.push(...(el === '-' ? [1, 1, 1] : [1]), 0);
      units.push(0, 0);
    }
    units.push(0, 0, 0, 0);
  }
  units.push(0, 0, 0, 0, 0, 0, 0);
  return Uint8Array.from(units);
})();

/** The CW carrier's on/off state at time t. */
export function cwKey(t) {
  const u = Math.floor(t / CW_DIT_S);
  return KEYING[((u % KEYING.length) + KEYING.length) % KEYING.length];
}

function bitsOf(bytes) {
  const out = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) out.push((b >> i) & 1);
  return out;
}
const BITS = bitsOf(PAYLOAD);

// deterministic per-sample noise
function hash(n) {
  let x = Math.imul(n, 2654435761) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 2246822519);
  x ^= x >>> 13; x = Math.imul(x, 3266489917);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** Envelope of the OOK burst train at time t (seconds): 0..1. */
export function burstEnvelope(t) {
  const symbol = SYMBOL_US * 1e-6;
  const bitLen = symbol * 3;                 // '1' = 2 high + 1 low, '0' = 1 high + 2 low
  const burstLen = BITS.length * bitLen;

  const phase = t - Math.floor(t / BURST_PERIOD_S) * BURST_PERIOD_S;
  if (phase < 0 || phase >= burstLen) return 0;

  const bitIndex = Math.floor(phase / bitLen);
  if (bitIndex >= BITS.length) return 0;
  const inBit = phase - bitIndex * bitLen;
  const highFor = BITS[bitIndex] ? 2 * symbol : symbol;
  if (inBit >= highFor) return 0;

  // soft edges so the spectrum does not splatter across the whole span
  const edge = symbol * 0.03;
  const rise = Math.min(1, inBit / edge);
  const fall = Math.min(1, (highFor - inBit) / edge);
  return Math.min(rise, fall);
}

// A contiguous window of already-generated scene, reused across reads.
//
// Drawing one waterfall row of a narrow channel needs bins × decimation source
// samples, and consecutive rows slide that window forward by a fraction of its
// length — so better than nine tenths of every read had just been generated for the
// row before. Regenerating it each time was the actual cost of the freeze; the
// per-sample trig was only the visible half.
const cache = { start: 0, len: 0, data: null };

function fill(start, count) {
  const fs = SOURCE.sampleRate;
  const out = new Float32Array(count * 2);

  const OOK_OFF = -25_000;
  const rot = (hz) => { const w = (2 * Math.PI * hz) / fs; return { rc: Math.cos(w), rs: Math.sin(w) }; };
  const at = (hz, phase) => { const a = (2 * Math.PI * hz * start) / fs + phase; return { c: Math.cos(a), s: Math.sin(a) }; };

  const cwR = rot(CW_OFF), cw = at(CW_OFF, 0);
  const ookR = rot(OOK_OFF), ook = at(OOK_OFF, 0);

  // SSB is two ordinary tones offset from a suppressed carrier, so it costs two
  // more phasors and nothing else.
  const sR = SSB_TONES.map((f) => rot(SSB_OFF + f));
  const sP = SSB_TONES.map((f, i) => at(SSB_OFF + f, hash(4400 + i) * Math.PI * 2));

  // FM is the one signal a fixed-rate phasor cannot make: its rotation rate is the
  // message. The carrier pays for a cos and a sin per sample, and a digit for two
  // sines while it sounds.
  const fmW = (2 * Math.PI * FM_OFF) / fs;

  // WBFM: the voice's phase in closed form, and the pilot and the RDS subcarrier as phasors.
  // The pilot's phase is -β cos so its deviation is a sine, with RDS's carrier a cosine at
  // three times it, as the rds-fm fixture that redsea reads has them.
  const pR = rot(WFM_PILOT), pP = at(WFM_PILOT, 0);
  const rR = rot(RDS_SUBCARRIER), rP = at(RDS_SUBCARRIER, 0);
  const wfmW = (2 * Math.PI * WFM_OFF) / fs;
  const rdsK = WFM_RDS_DEV / RDS_SUBCARRIER;

  for (let i = 0; i < count; i++) {
    const n = start + i;
    let re = (hash(n * 2) + hash(n * 2 + 7919) - 1) * 0.030;
    let im = (hash(n * 2 + 1) + hash(n * 2 + 104729) - 1) * 0.030;

    const key = cwKey(n / fs);
    if (key) { re += 0.26 * cw.c; im += 0.26 * cw.s; }

    for (let k = 0; k < sP.length; k++) {
      re += 0.11 * sP[k].c;
      im += 0.11 * sP[k].s;
    }

    const phi = fmW * n + dtmfPhase(n / fs);
    re += 0.20 * Math.cos(phi);
    im += 0.20 * Math.sin(phi);

    const m = n % LOOP_N;
    // A half-bit is 480 000 / 2 375 = 3840 / 19 scene samples.
    const half = RDS_HALF[((m * 19) / 3840) | 0];
    const wphi = wfmW * n + voicePhase(m) - WFM_PILOT_BETA * pP.c + rdsK * half * rP.s;
    re += 0.17 * Math.cos(wphi);
    im += 0.17 * Math.sin(wphi);

    const env = burstEnvelope(n / fs);
    if (env > 0) { const g = 0.42 * env; re += g * ook.c; im += g * ook.s; }

    out[i * 2] = re;
    out[i * 2 + 1] = im;

    let nc = cw.c * cwR.rc - cw.s * cwR.rs;
    cw.s = cw.c * cwR.rs + cw.s * cwR.rc; cw.c = nc;
    nc = ook.c * ookR.rc - ook.s * ookR.rs;
    ook.s = ook.c * ookR.rs + ook.s * ookR.rc; ook.c = nc;
    for (const [ph, r] of [[sP[0], sR[0]], [sP[1], sR[1]],
                           [pP, pR], [rP, rR]]) {
      const c2 = ph.c * r.rc - ph.s * r.rs;
      ph.s = ph.c * r.rs + ph.s * r.rc; ph.c = c2;
    }
    if ((i & 4095) === 4095) {
      const norm = (v) => { const g = Math.hypot(v.c, v.s) || 1; v.c /= g; v.s /= g; };
      norm(cw); norm(ook); norm(sP[0]); norm(sP[1]);
      norm(pP); norm(rP);
    }
  }
  return out;
}

/**
 * Read `count` complex samples starting at absolute sample index `start`.
 * Returns an interleaved Float32Array of length count*2 — a view into the cache,
 * so treat it as read-only; every consumer in the DSP chain already does.
 *
 * Every tone advances by rotating a phasor rather than calling cos/sin per sample.
 * The straightforward version evaluated sixteen hump tones plus two carriers with a
 * cos and a sin apiece — about thirty-six transcendentals per sample — which cost
 * 56 ms to generate one waterfall row of a narrow channel and locked the page during
 * prefill. Two trig calls per tone per *call* now, then multiplies.
 */
export function read(start, count) {
  if (start < 0) start = 0;
  if (cache.data && start >= cache.start && start + count <= cache.start + cache.len) {
    const off = (start - cache.start) * 2;
    return cache.data.subarray(off, off + count * 2);   // a view, not a copy
  }
  // generate with headroom ahead, since reads slide forward
  const pad = Math.max(count, 1 << 17);
  const len = count + pad;
  cache.start = start;
  cache.len = len;
  cache.data = fill(start, len);
  return cache.data.subarray(0, count * 2);
}
