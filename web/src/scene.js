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

// The burst payload the PWM slicer should recover: 0xAAAA preamble + payload.
export const PAYLOAD = [0xaa, 0xaa, 0x3c, 0x69];
export const SYMBOL_US = 417;
export const BURST_PERIOD_S = 0.9;

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

// wideband hump: a fixed comb of tones, tapered — cheap and deterministic
const HUMP = [];
{
  const n = 16, centre = 150_000, width = 34_000;
  for (let i = 0; i < n; i++) {
    const f = centre + ((i / (n - 1)) - 0.5) * 2 * width;
    const t = (f - centre) / width;
    HUMP.push({ f, a: 0.09 * Math.exp(-1.6 * t * t), p: hash(9000 + i) * Math.PI * 2 });
  }
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

/**
 * Read `count` complex samples starting at absolute sample index `start`.
 * Returns interleaved Float32Array of length count*2.
 */
export function read(start, count) {
  const fs = SOURCE.sampleRate;
  const out = new Float32Array(count * 2);

  const CW_OFF = -180_000;      // steady carrier
  const OOK_OFF = -25_000;      // the burst train we care about
  const w_cw = (2 * Math.PI * CW_OFF) / fs;
  const w_ook = (2 * Math.PI * OOK_OFF) / fs;

  for (let i = 0; i < count; i++) {
    const n = start + i;
    const t = n / fs;
    let re = 0, im = 0;

    // noise floor (two uniforms → roughly Gaussian enough for a waterfall)
    const n1 = hash(n * 2) + hash(n * 2 + 7919) - 1;
    const n2 = hash(n * 2 + 1) + hash(n * 2 + 104729) - 1;
    re += n1 * 0.030;
    im += n2 * 0.030;

    // steady carrier
    const pcw = w_cw * n;
    re += 0.26 * Math.cos(pcw);
    im += 0.26 * Math.sin(pcw);

    // wideband hump
    for (let h = 0; h < HUMP.length; h++) {
      const ph = (2 * Math.PI * HUMP[h].f * t) + HUMP[h].p;
      re += HUMP[h].a * Math.cos(ph);
      im += HUMP[h].a * Math.sin(ph);
    }

    // OOK burst train
    const env = burstEnvelope(t);
    if (env > 0) {
      const p = w_ook * n;
      re += 0.42 * env * Math.cos(p);
      im += 0.42 * env * Math.sin(p);
    }

    out[i * 2] = re;
    out[i * 2 + 1] = im;
  }
  return out;
}
