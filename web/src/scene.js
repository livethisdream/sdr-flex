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
  const n = 16, center = 150_000, width = 34_000;
  for (let i = 0; i < n; i++) {
    const f = center + ((i / (n - 1)) - 0.5) * 2 * width;
    const t = (f - center) / width;
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

  const CW_OFF = -180_000;
  const OOK_OFF = -25_000;
  const rot = (hz) => { const w = (2 * Math.PI * hz) / fs; return { rc: Math.cos(w), rs: Math.sin(w) }; };
  const at = (hz, phase) => { const a = (2 * Math.PI * hz * start) / fs + phase; return { c: Math.cos(a), s: Math.sin(a) }; };

  const cwR = rot(CW_OFF), cw = at(CW_OFF, 0);
  const ookR = rot(OOK_OFF), ook = at(OOK_OFF, 0);
  const hR = HUMP.map((h) => rot(h.f));
  const hP = HUMP.map((h) => at(h.f, h.p));
  const nh = HUMP.length;

  for (let i = 0; i < count; i++) {
    const n = start + i;
    let re = (hash(n * 2) + hash(n * 2 + 7919) - 1) * 0.030;
    let im = (hash(n * 2 + 1) + hash(n * 2 + 104729) - 1) * 0.030;

    re += 0.26 * cw.c;
    im += 0.26 * cw.s;

    for (let h = 0; h < nh; h++) {
      const a = HUMP[h].a, ph = hP[h];
      re += a * ph.c;
      im += a * ph.s;
    }

    const env = burstEnvelope(n / fs);
    if (env > 0) { const g = 0.42 * env; re += g * ook.c; im += g * ook.s; }

    out[i * 2] = re;
    out[i * 2 + 1] = im;

    let nc = cw.c * cwR.rc - cw.s * cwR.rs;
    cw.s = cw.c * cwR.rs + cw.s * cwR.rc; cw.c = nc;
    nc = ook.c * ookR.rc - ook.s * ookR.rs;
    ook.s = ook.c * ookR.rs + ook.s * ookR.rc; ook.c = nc;
    for (let h = 0; h < nh; h++) {
      const ph = hP[h], r = hR[h];
      const c2 = ph.c * r.rc - ph.s * r.rs;
      ph.s = ph.c * r.rs + ph.s * r.rc; ph.c = c2;
    }
    if ((i & 4095) === 4095) {
      const norm = (v) => { const m = Math.hypot(v.c, v.s) || 1; v.c /= m; v.s /= m; };
      norm(cw); norm(ook);
      for (let h = 0; h < nh; h++) norm(hP[h]);
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
