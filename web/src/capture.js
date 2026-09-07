// Reading somebody else's capture.
//
// A CTF hands you a file, not a live radio, and until this existed the tool could only
// look at a scene it generated itself. The interface is deliberately the same one the
// synthetic scene exposes — `read(start, count)` over an absolute sample index — so
// everything downstream, including scrubbing through history, works unchanged
// (ADR-0005: a source is a time-indexed medium, and a file is the easy case).
//
// Samples are converted on demand rather than up front. A 200 MB cu8 capture is 100 M
// complex samples; as Float32 that is 800 MB and the tab dies. Held as its original
// bytes with a decoded window cached, the same file costs 200 MB and opens instantly.

/**
 * Sample formats, keyed by the names the field actually uses. `bps` is bytes per
 * complex sample; `read` writes `count` complex samples into `out` as interleaved
 * float, starting at complex index `i0`.
 */
export const FORMATS = {
  // GNU Radio / gr-osmosdr / SigMF cf32_le — the lingua franca
  cf32: {
    name: 'complex float32', bps: 8,
    read(view, i0, count, out) {
      for (let i = 0; i < count; i++) {
        out[i * 2] = view.getFloat32((i0 + i) * 8, true);
        out[i * 2 + 1] = view.getFloat32((i0 + i) * 8 + 4, true);
      }
    },
  },
  // hackrf_transfer, bladeRF, SigMF ci16_le
  cs16: {
    name: 'complex int16', bps: 4,
    read(view, i0, count, out) {
      for (let i = 0; i < count; i++) {
        out[i * 2] = view.getInt16((i0 + i) * 4, true) / 32768;
        out[i * 2 + 1] = view.getInt16((i0 + i) * 4 + 2, true) / 32768;
      }
    },
  },
  // rtl_sdr's native output, and what most published RF CTF captures are
  cu8: {
    name: 'complex uint8', bps: 2,
    read(view, i0, count, out) {
      for (let i = 0; i < count; i++) {
        out[i * 2] = (view.getUint8((i0 + i) * 2) - 127.5) / 127.5;
        out[i * 2 + 1] = (view.getUint8((i0 + i) * 2 + 1) - 127.5) / 127.5;
      }
    },
  },
  cs8: {
    name: 'complex int8', bps: 2,
    read(view, i0, count, out) {
      for (let i = 0; i < count; i++) {
        out[i * 2] = view.getInt8((i0 + i) * 2) / 128;
        out[i * 2 + 1] = view.getInt8((i0 + i) * 2 + 1) / 128;
      }
    },
  },
};

/** SigMF's datatype strings, for the formats we can read. */
const SIGMF_TYPES = {
  cf32_le: 'cf32', ci16_le: 'cs16', ci8: 'cs8', cu8: 'cu8', ci8_le: 'cs8', cu8_le: 'cu8',
};

/**
 * What a filename says about its contents. Wrong often enough that the guess is
 * always shown and always editable — but right often enough to save a dialog.
 */
export function guessFormat(name) {
  const n = name.toLowerCase();
  if (/\.(cf32|fc32|cfile|complex|32fc)$/.test(n) || /float/.test(n)) return 'cf32';
  if (/\.(cs16|sc16|ci16|16sc)$/.test(n)) return 'cs16';
  if (/\.(cs8|sc8|ci8)$/.test(n)) return 'cs8';
  if (/\.(cu8|8u|uc8|bin|iq|raw|dat|complex16u)$/.test(n)) return 'cu8';
  return null;
}

/** Rate and center out of a filename, the way rtl_433 and gqrx write them. */
export function guessFromName(name) {
  const out = {};
  // …_433.92MHz_250kSps… / …_2400000Hz_… / …-8M-… — the common shapes
  let m = name.match(/(\d+(?:\.\d+)?)\s*([kMG]?)(?:Hz|hz)[_.-]/);
  if (m) out.centerHz = parseFloat(m[1]) * ({ '': 1, k: 1e3, M: 1e6, G: 1e9 }[m[2]] || 1);
  m = name.match(/(\d+(?:\.\d+)?)\s*([kMG]?)(?:sps|Sps|SPS|S_?s|sa?mp)/);
  if (m) out.sampleRate = parseFloat(m[1]) * ({ '': 1, k: 1e3, M: 1e6, G: 1e9 }[m[2]] || 1);
  return out;
}

/**
 * A loaded capture: the bytes, how to read them, and what is known about them.
 *
 * `read` mirrors the synthetic scene's contract exactly — same window cache, same
 * "returns a view, treat it as read-only" rule — so the engine cannot tell them apart.
 */
export class Capture {
  constructor({ buffer, format, sampleRate, centerHz, label, meta }) {
    this.buffer = buffer;
    this.view = new DataView(buffer);
    this.format = format;
    this.spec = FORMATS[format];
    this.sampleRate = sampleRate;
    this.centerHz = centerHz;
    this.label = label;
    this.meta = meta || null;
    this.samples = Math.floor(buffer.byteLength / this.spec.bps);
    this.durationS = this.samples / sampleRate;
    this._cache = { start: 0, len: 0, data: null };
  }

  /**
   * `count` complex samples from absolute index `start`, interleaved. Past the end of
   * the file the answer is zeros rather than an error: a display asking for the window
   * around a moment should get silence past the end, not a broken frame.
   */
  read(start, count) {
    if (start < 0) start = 0;
    const c = this._cache;
    if (c.data && start >= c.start && start + count <= c.start + c.len) {
      const off = (start - c.start) * 2;
      return c.data.subarray(off, off + count * 2);
    }
    const len = count + Math.max(count, 1 << 17);
    const data = new Float32Array(len * 2);
    const n = Math.max(0, Math.min(len, this.samples - start));
    if (n > 0) this.spec.read(this.view, start, n, data);
    c.start = start; c.len = len; c.data = data;
    return data.subarray(0, count * 2);
  }
}

/**
 * Turn dropped files into a capture.
 *
 * SigMF arrives as a pair — `x.sigmf-meta` beside `x.sigmf-data` — so a drop of both
 * is one capture with its rate and center already known, which is the whole reason the
 * format exists (ADR-0008). Anything else is raw samples plus a guess.
 */
export async function fromFiles(files) {
  const list = [...files];
  const meta = list.find((f) => /\.sigmf-meta$/i.test(f.name));
  const data = list.find((f) => /\.sigmf-data$/i.test(f.name)) ||
               list.find((f) => f !== meta);
  if (!data) throw new Error('no sample data in that drop');

  let format = null, sampleRate = null, centerHz = null, parsed = null;
  if (meta) {
    parsed = JSON.parse(await meta.text());
    const g = parsed.global || {};
    format = SIGMF_TYPES[g['core:datatype']] || null;
    if (!format && g['core:datatype']) {
      throw new Error(`SigMF datatype ${g['core:datatype']} is not one this build reads`);
    }
    if (g['core:sample_rate']) sampleRate = g['core:sample_rate'];
    const cap = (parsed.captures || [])[0] || {};
    if (cap['core:frequency'] != null) centerHz = cap['core:frequency'];
  }

  const named = guessFromName(data.name);
  format = format || guessFormat(data.name) || 'cu8';
  sampleRate = sampleRate || named.sampleRate || 2_048_000;
  centerHz = centerHz != null ? centerHz : (named.centerHz != null ? named.centerHz : 0);

  return new Capture({
    buffer: await data.arrayBuffer(),
    format, sampleRate, centerHz,
    label: data.name.replace(/\.(sigmf-data|cf32|cu8|cs16|cs8|iq|raw|bin|dat|complex)$/i, ''),
    meta: parsed,
  });
}
