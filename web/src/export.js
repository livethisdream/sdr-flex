// Getting a channel back out.
//
// This is the piece that removes tools from the chain. Playtesting a capture today
// means inspectrum to look, GNU Radio to channelize, gqrx to listen, sox to make a
// 22050 Hz wav, and only then multimon-ng. The first three are already here; without
// this the fourth and fifth still are not, and the tool stops one step short of an
// answer.
//
// Two shapes, because two things consume them: a WAV at a rate a stock decoder asks
// for, and IQ with a SigMF sidecar so a channel becomes a capture in its own right.

/** Rates the field's decoders ask for on stdin, so they are one click rather than a note. */
export const AUDIO_RATES = [8000, 22050, 44100, 48000];

/**
 * Band-limited resample by an arbitrary ratio.
 *
 * Linear interpolation is tempting and wrong here: the output is fed to a slicer that
 * is deciding bit boundaries, and the images linear interpolation leaves land right
 * where the decision is made. This is a windowed-sinc, which costs more than it needs
 * to and does not matter, because export happens once rather than sixty times a second.
 */
export function resample(x, fromRate, toRate, halfWidth = 16) {
  if (fromRate === toRate) return x;
  const ratio = toRate / fromRate;
  const n = Math.floor(x.length * ratio);
  const out = new Float32Array(n);

  // When decimating, the filter has to cut at the *output* Nyquist, not the input's —
  // and that is where this used to go wrong. The cutoff was scaled and the kernel's
  // width was not, so decimating 2.4 MS/s to 250 kS/s built a sinc stretched nine and a
  // half times and then truncated it at sixteen input samples: three zero crossings,
  // which is not a low-pass filter, it is a suggestion. A 200 kHz tone came back at
  // 50 kHz down only 31 dB. Anything a dongle heard between about 125 and 250 kHz was
  // folding into the band rtl_433 was reading.
  //
  // Sixteen is sixteen zero crossings of the filter, so the support has to stretch with
  // it: a hundred and fifty-four input samples at that ratio, not sixteen.
  const cutoff = Math.min(1, ratio);
  const support = Math.max(1, Math.ceil(halfWidth / cutoff));
  const taps = support * 2;

  // Which makes the kernel too expensive to evaluate per output — three transcendentals
  // a tap over three hundred taps and two million outputs is not a wait anybody would
  // sit through. So it is built once, on a fixed grid of fractional offsets, and every
  // output is a table lookup and a dot product. The grid is fine enough that the phase
  // error inside a step is far below the stopband it would have to beat to matter.
  const SUBS = 128;
  const kern = new Float32Array(SUBS * taps);
  for (let sp = 0; sp < SUBS; sp++) {
    const frac = sp / SUBS;
    const base = sp * taps;
    let sum = 0;
    for (let j = 0; j < taps; j++) {
      const d = (frac + support - 1 - j) * cutoff;
      const s = d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
      const t = j / (taps - 1);
      const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * t) + 0.08 * Math.cos(4 * Math.PI * t);
      const h = s * w;
      kern[base + j] = h;
      sum += h;
    }
    // Unity gain at DC, per phase, so a steady signal comes out the level it went in.
    if (sum !== 0) for (let j = 0; j < taps; j++) kern[base + j] /= sum;
  }

  for (let i = 0; i < n; i++) {
    const at = i / ratio;
    const c = Math.floor(at);
    const sp = Math.min(SUBS - 1, Math.floor((at - c) * SUBS));
    const kb = sp * taps;
    const start = c - support + 1;
    let acc = 0;
    if (start >= 0 && start + taps <= x.length) {
      for (let j = 0; j < taps; j++) acc += x[start + j] * kern[kb + j];
    } else {
      // At the edges some of the kernel hangs off the end of the signal. Renormalizing
      // over what is actually there beats treating the outside as silence, which would
      // fade the first and last few milliseconds of every resampled span.
      let norm = 0;
      for (let j = 0; j < taps; j++) {
        const k = start + j;
        if (k < 0 || k >= x.length) continue;
        acc += x[k] * kern[kb + j];
        norm += kern[kb + j];
      }
      acc = norm !== 0 ? acc / norm : 0;
    }
    out[i] = acc;
  }
  return out;
}

/** Peak-normalize with headroom, so a decoder sees a full-scale signal and no clipping. */
export function normalize(x, peak = 0.89) {
  let mx = 0, dc = 0;
  for (let i = 0; i < x.length; i++) dc += x[i];
  dc /= x.length || 1;
  for (let i = 0; i < x.length; i++) { const v = Math.abs(x[i] - dc); if (v > mx) mx = v; }
  const g = mx > 1e-12 ? peak / mx : 0;
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = (x[i] - dc) * g;
  return out;
}

/** 16-bit PCM mono WAV — what multimon-ng, direwolf and dsd all read. */
export function wav(samples, sampleRate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);                    // PCM
  v.setUint16(22, 1, true);                    // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);       // byte rate
  v.setUint16(32, 2, true);                    // block align
  v.setUint16(34, 16, true);                   // bits
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/** Interleaved float32 IQ — GNU Radio's cfile, and SigMF's cf32_le. */
export function cf32(iq) {
  return new Blob([iq instanceof Float32Array ? iq.buffer.slice(iq.byteOffset, iq.byteOffset + iq.byteLength) : iq],
                  { type: 'application/octet-stream' });
}

/**
 * The sidecar that makes an exported channel a capture rather than a pile of bytes.
 *
 * The provenance fields are the point: a slot pulled out of a composite should say
 * where it came from and what was done to it, or it becomes an orphan file on someone's
 * disk in a week (ADR-0007, ADR-0008).
 */
export function sigmfMeta({ sampleRate, centerHz, label, from, chain, startS }) {
  return new Blob([JSON.stringify({
    global: {
      'core:datatype': 'cf32_le',
      'core:sample_rate': sampleRate,
      'core:version': '1.0.0',
      'core:description': `${label} — channel exported by SDR Flex`,
      'core:recorder': 'SDR Flex',
      ...(from ? { 'sdrflex:source': from } : {}),
      ...(chain ? { 'sdrflex:chain': chain } : {}),
    },
    captures: [{ 'core:sample_start': 0, 'core:frequency': centerHz,
                 ...(startS != null ? { 'core:datetime_offset_s': startS } : {}) }],
    annotations: [],
  }, null, 2)], { type: 'application/json' });
}

/** Plain text, for bits and hex going into whatever comes next. */
export function text(s) { return new Blob([s], { type: 'text/plain' }); }

/** Hand a blob to the browser as a download. */
export function save(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
