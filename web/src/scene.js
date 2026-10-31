// A deterministic synthetic RF scene, generated lazily from absolute sample index.
//
// Nothing is stored: read(n, count) synthesises exactly the window asked for. That
// makes all history scrubbable for free, which is the promise ADR-0005 makes about
// real sources — here it costs nothing because the scene is a pure function of time.

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
  { offsetHz:  130_000, widthHz: 180_000, kind: 'wbfm', label: 'WBFM, \u00b165 kHz + pilot' },
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

// WBFM: the wideband half of the FM pair, and the signal that checks de-emphasis.
//
// What used to sit at this end of the band was a comb of sixteen static phasors called
// a "wideband hump". It was wide, and it was nothing — no modulation, no answer to
// "what is that", and nothing any detector could be right or wrong about. The scene had
// four signals and a smear.
//
// Two audio tones that were **equal at the microphone** and are unequal on the air,
// because a broadcast FM transmitter pre-emphasizes: it boosts treble by 1 + j2πfτ with
// τ = 75 µs, and the receiver is supposed to undo it. So an FM demodulator with no
// de-emphasis recovers 4 kHz about 6.2 dB hot, and one with it recovers the two tones
// equal. The demod hands the composite on as sent and Listen undoes it, and
// `web/test/detectors.test.mjs` asserts both numbers.
//
// **Broadcast-shaped rather than broadcast.** A real ±75 kHz stereo signal is a quarter
// of a megahertz of composite baseband, which is most of this 480 kHz band and would
// leave nowhere for the other four. ±65 kHz with the pilot and no stereo subcarrier is
// 168 kHz by Carson, fits with room, and is wideband by every measure that matters
// here: the deviation dwarfs the audio, it needs a wide channel, and it needs the
// de-emphasis.
const WFM_OFF = 130_000, WFM_DEV = 65_000;
const WFM_PILOT = 19_000, WFM_PILOT_SHARE = 0.10;    // 10% injection, as the standard asks
const WFM_TONES = [600, 4_000];
const PREEMPH_S = 75e-6;                             // the US time constant; 50 µs in Europe

/** How much a transmitter lifts a tone before sending it. */
const preemph = (f) => Math.hypot(1, 2 * Math.PI * f * PREEMPH_S);

// Deviation is split between the audio and the pilot, and then between the tones in the
// pre-emphasized proportion — which is what makes the receiver's job recoverable rather
// than a matter of taste.
const WFM_AMP = WFM_TONES.map(preemph);
const WFM_SUM = WFM_AMP.reduce((a, b) => a + b, 0);
const WFM_BETA = WFM_TONES.map((f, i) =>
  (WFM_DEV * (1 - WFM_PILOT_SHARE) * (WFM_AMP[i] / WFM_SUM)) / f);
const WFM_PILOT_BETA = (WFM_DEV * WFM_PILOT_SHARE) / WFM_PILOT;

/**
 * How far off a correct de-emphasis the recovered audio is, in dB, at each tone.
 *
 * Exported so the test asserts the scene's own arithmetic rather than a number somebody
 * typed twice.
 */
export const WFM_PREEMPH_DB = 20 * Math.log10(preemph(WFM_TONES[1]) / preemph(WFM_TONES[0]));
export const WFM_INFO = { offsetHz: WFM_OFF, devHz: WFM_DEV, pilotHz: WFM_PILOT, tones: WFM_TONES };
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

  // WBFM, the same way: the baseband is three phasors — two audio tones and the pilot —
  // summed into the carrier's phase. Three sines and one carrier, against the sixteen
  // phasors the static hump used to cost.
  const aR = WFM_TONES.map((f) => rot(f));
  const aP = WFM_TONES.map((f, i) => at(f, hash(7700 + i) * Math.PI * 2));
  const pR = rot(WFM_PILOT), pP = at(WFM_PILOT, 0);
  const wfmW = (2 * Math.PI * WFM_OFF) / fs;

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

    // e^{j(w_c n + Σ beta_k sin(w_k n))} — the pilot is just another term in the sum.
    let wphi = wfmW * n + WFM_PILOT_BETA * pP.s;
    for (let k = 0; k < aP.length; k++) wphi += WFM_BETA[k] * aP[k].s;
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
                           [pP, pR], [aP[0], aR[0]], [aP[1], aR[1]]]) {
      const c2 = ph.c * r.rc - ph.s * r.rs;
      ph.s = ph.c * r.rs + ph.s * r.rc; ph.c = c2;
    }
    if ((i & 4095) === 4095) {
      const norm = (v) => { const g = Math.hypot(v.c, v.s) || 1; v.c /= g; v.s /= g; };
      norm(cw); norm(ook); norm(sP[0]); norm(sP[1]);
      norm(pP); norm(aP[0]); norm(aP[1]);
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
