// The engine contract, and the mock that implements it in the browser.
//
// ADR-0021: the client has no privileged path into the engine, so "the engine" can
// be this file. Every method is async and deliberately spends the latency budget —
// a mock that answers in microseconds would let us tune the UI against a backend
// that cannot exist.

import * as dsp from './dsp.js';
import * as scene from './scene.js';
import * as plugins from './plugins.js';
import { plan as identifyPlan, MIN_DECODE_CHARS, textLength } from './identify.js';
import { Graph, inputsOf } from './graph.js';
import { alignment } from './delay.js';
import * as frames from './frames.js';
import * as spreading from './codes.js';

/**
 * What can be put in front of an audio decoder when the stream is IQ.
 *
 * Exported because the panel draws the plan before the first result lands — it has the
 * adapter list and `identify.js` is shared, so it can work out what is about to be tried
 * without asking. That only stays true if both sides agree on this list, so there is one.
 */
export function demodsFor(kind) {
  if (kind !== 'iq') return [];
  return [{ op: 'core.fm_discriminator', label: OPS['core.fm_discriminator'].name },
          { op: 'core.am_envelope', label: OPS['core.am_envelope'].name }];
}

export const LATENCY = {
  paramMs: 40,        // hot parameter → visible effect
  structuralMs: 260,  // cold parameter or new node → first frame
  frameHz: 30,
  jitterMs: 3,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms + (Math.random() - 0.5) * 2 * LATENCY.jitterMs));
const instant = () => Promise.resolve();

let nextId = 0;
const nid = (p) => `${p}${++nextId}`;

/**
 * What a derived gain aims at.
 *
 * The same number the audio sink's own AGC targets, so a stream brought here by hand and
 * one brought there automatically arrive at the same loudness — and two branches
 * normalized separately can be matrixed against each other without a second correction.
 */
const GAIN_TARGET = 0.25;

// The matched filter's length, in symbols. M17's own tap table is span 8 at α = 0.5, and
// a receiver's filter has to be the transmitter's or it is not matched to anything.
const SYMBOL_SPAN = 8;

// M17's, and the only symbol rate anything here reads. A second one makes this a
// parameter of the operation rather than a constant.
const SYMBOL_RATE = 4800;

// How much of a span a symbol sync fits itself over — and, because the two must be the
// same number, how far one fit is trusted.
//
// It was one fit for a whole capture, and that is the bug this constant now prevents.
// `softSymbols` finds an instant *relative to the window it was given*: fitting a 4 s
// window ending at t=40, 50, 60, 70, 80 and 90 on the GRCon26 M17 slot returned
// `offset` 12.323 every single time. Converting that to a capture-absolute phase
// therefore just re-encodes where the window happened to start, and applying it to the
// other eighty seconds is applying a number measured somewhere else. Measured, same
// signal, same decoder, only the fit window moved: **0 records to 95**, with an eye of
// 0.63 either way — the eye was right, the fits really were equally good, locally.
//
// So the capture is cut into blocks of this length, anchored at zero, and each block is
// fitted on itself. Overlapping reads still agree, because a block's grid is a property
// of the block rather than of the read (which is what ADR-0040 wanted); and no grid is
// ever used more than this far from where it was measured. Measured at 5, 10 and 20 s
// blocks: 94–95 records every time, at both a 9 kHz and a 12 kHz selection.
const SYMBOL_FIT_SECONDS = 10;

/** The block a moment belongs to. Anchored at zero so every read agrees on the edges. */
const fitBlock = (t) => Math.floor(Math.max(0, t) / SYMBOL_FIT_SECONDS);

/** Everything in a stream multiplied by one number, given in decibels. */
function scaled(x, gainDb) {
  const g = Math.pow(10, Number(gainDb) / 20);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] * g;
  return out;
}

/** RMS of an interleaved or plain stream. */
function levelOf(data, count, stride) {
  let s = 0;
  for (let i = 0; i < count * stride; i++) s += data[i] * data[i];
  return Math.sqrt(s / Math.max(1, count * stride));
}

/** A real stream as IQ with nothing in the imaginary part, for a mixer to take. */
function interleave(x, count) {
  const out = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) out[i * 2] = x[i];
  return out;
}

/** Rates, in the one place a merge has to compare two of them out loud. */
const fmtKS = (hz) => `${(hz / 1e3).toFixed(1)} kS/s`;

// ── operation catalog ────────────────────────────────────────────────────
// `in`/`out` are semantic stream kinds (ADR-0006); the palette filters on them.
export const OPS = {
  // **Takes a demodulated stream as well as IQ**, which is what a mixer can do and a
  // separate conversion node was pretending it could not. GNU Radio has had this for
  // decades as `freq_xlating_fir_filter_fcf`: a real input mixed by a complex phasor and
  // low-passed *is* the analytic baseband of whatever was around that frequency, so the
  // Hilbert transformer a conversion node needs is work nobody has to do.
  //
  // It is also strictly better where it matters. A Hilbert transformer cannot do anything
  // at zero frequency, so its image rejection falls apart at the bottom of the band — 8 dB
  // at 500 Hz where a mixer has no such problem, because a mixer has no opinion about DC.
  'core.tuner': {
    name: 'Tune here', group: 'Narrow', in: ['iq', 'real'], out: 'iq',
    fromSelection: true,
  },
  // A time window is a property of a channel, not a node of its own (ADR-0023),
  // so there is no gate operation here: dragging the box down the waterfall pins
  // the tuner this menu creates.
  // The ids name the algorithm — an envelope detector, an FM discriminator — because
  // that is what someone reading the graph needs to know. The display names follow
  // the convention every radio uses, because that is what someone *choosing* one is
  // looking for: nobody scans a menu for "envelope detector".
  'core.am_envelope': {
    name: 'AM demod', group: 'Demodulate', in: 'iq', out: 'real',
  },
  // These are detectors, not "demodulators" in the sense that bundles a
  // channelizer, AGC, squelch and an audio chain into one panel. The tuner ahead of
  // them already did the filtering; listening happens at the sink. That split is
  // the whole reason these have two parameters each instead of twenty.
  'core.fm_discriminator': {
    name: 'FM demod', group: 'Demodulate', in: 'iq', out: 'real',
  },
  'core.ssb': {
    name: 'SSB demod', group: 'Demodulate', in: 'iq', out: 'real',
  },
  'core.cw': {
    name: 'CW demod', group: 'Demodulate', in: 'iq', out: 'real',
  },
  // The one operation that takes a real stream and returns a real stream, and the only
  // one that returns two channels (ADR-0037). It is grouped with the demodulators
  // because that is what it is: a coherent demodulation of the L-R subcarrier, plus the
  // two-by-two matrix that turns a sum and a difference back into a left and a right.
  'core.stereo': {
    name: 'Stereo decode', group: 'Demodulate', in: 'real', out: 'real',
  },
  'core.pwm_slicer': {
    name: 'PWM / OOK slicer', group: 'Decode', in: 'real', out: 'bits',
  },
  // The other half of slicing: a fixed symbol rate rather than pulse widths, which
  // is what most real protocols use. Its output is `bytes` — the type ADR-0006
  // declared and nothing had needed until a plugin wanted somewhere to plug in.
  'core.nrz_slicer': {
    name: 'NRZ slicer', group: 'Decode', in: 'real', out: 'bytes',
  },
  // The third slicer, and the one whose parameters are most nearly derivable: a line
  // code that guarantees a transition every symbol tells you its own symbol rate.
  'core.manchester': {
    name: 'Manchester slicer', group: 'Decode', in: 'real', out: 'bytes',
  },
  // The fourth slicer, and the only one that takes IQ: a spread signal has to be
  // despread before there is a waveform to slice, and the correlation that despreads it
  // *is* the decision — the sign of one correlation is one bit. Splitting that into a
  // despreader and a slicer would put a node in the chain whose input is one sample per
  // symbol, which is not a waveform and has nothing to slice.
  'core.despread': {
    name: 'Despread (DSSS)', group: 'Decode', in: 'iq', out: 'bytes',
  },
  // A line code on top of a line code. Cheap to try, and a stream that sliced to noise
  // sometimes reads perfectly on the other side of it.
  'core.differential': {
    name: 'Differential decode', group: 'Decode', in: 'bytes', out: 'bytes',
  },
  // Where a guess becomes a fact: a CRC that validates every frame is the only thing
  // in the chain that answers "is this the packet" rather than "here are some bytes".
  // Takes bits as well as bytes, because a PWM slicer produces bursts of bits and
  // until this did, that was where the chain stopped: you could see the bits and there
  // was nothing to do with them.
  'core.framer': {
    name: 'Frames & CRC', group: 'Decode', in: ['bytes', 'bits'], out: 'events',
  },
  // A sink is a node. A view renders what a node produced; a sink consumes it and
  // the data leaves the graph there, which is exactly what a terminal block is
  // (ADR-0027). Nothing takes `audio` as input, so nothing can follow it.
  'core.audio': {
    name: 'Listen', group: 'Listen', in: 'real', out: 'audio',
  },
  // A file writer is a sink like the speaker is (ADR-0027), and it takes whatever is
  // in front of it — `*` rather than three near-identical entries in the palette.
  'core.export': {
    name: 'Export', group: 'Export', in: '*', out: 'file',
  },
  // The network sink ADR-0027 named when it listed what a sink is. Everything in this
  // table either analyzes a stream or decodes it; this one hands it to somebody else.
  //
  // The reason it is not an adapter: an adapter is a *function* — it reads a span,
  // prints records, exits, and the records come back into the tool with timestamps and
  // a pane. Some programs are *destinations* instead. A ground station drawing a drone's
  // flight on a map is not a `parse()` anybody wants to write; the map is the point. So
  // the samples go out and nothing comes back, which is what makes this a sink rather
  // than a decoder — and why `Identify` will never offer it.
  'core.stream': {
    name: 'Stream out', group: 'Export', in: '*', out: 'sink',
  },
  // The external decoders are not listed here. Which of them exist depends on what is
  // installed on the box, which only the engine can know, so `palette` asks the adapter
  // table rather than this one — and a decoder whose program is missing is still shown,
  // saying which program (ADR-0013).
  // Where a hopper has been, and in what order. The sequence is usually the thing
  // somebody is after, so it is records rather than a picture — but the picture is a
  // view of the same records (ADR-0027).
  'core.hopmap': {
    name: 'Hop map', group: 'Analyze', in: 'iq', out: 'events',
  },
  // And then following it. A hopper's payload runs through the dwells rather than
  // restarting on each one, so stitching them back together hands the ordinary chain a
  // signal it already knows how to read — which is why the hop sequence and the bits
  // come out of one capability rather than two.
  'core.dehop': {
    name: 'De-hop', group: 'Narrow', in: 'iq', out: 'iq',
  },
  // The resource grid, as a picture rather than a list. OFDM's message is *which* cells
  // carry anything, in time and in frequency, so the answer is a grid and not a byte
  // stream — and a grid is a stream type of its own rather than an events pane pretending.
  'core.ofdm': {
    name: 'OFDM grid', group: 'Analyze', in: 'iq', out: 'grid',
  },
  // A screen leaking is a raster: pixels along a line, lines down a frame. Fold the
  // signal at the line period and the picture comes back — the same grid view OFDM uses,
  // because "fold a signal into two dimensions" is one idea (ADR-0034).
  // Takes IQ as well as a demodulated stream, and IQ is the better input: the AM
  // detector's post-detection filter is sized for audio — forty microseconds — and a
  // pixel here is a fraction of one. Running a screen through it smears eight pixels
  // into each other and the letters come out as bars. The raster takes the magnitude
  // itself and leaves the bandwidth alone.
  'core.raster': {
    name: 'Raster', group: 'Analyze', in: ['iq', 'real'], out: 'grid',
  },
  // The way back from IQ, and the only one of the pair that has to exist: a chain of
  // tuners and arithmetic ends complex, and a speaker takes a real stream. `complex_to_real`
  // in anybody else's vocabulary.
  //
  // There is no node going the other way. The tuner takes `real` directly, which is what
  // a mixer can do — a separate Hilbert-based conversion was one more block to explain
  // and worse near DC.
  'core.real': {
    name: 'To real', group: 'Convert', in: 'iq', out: 'real',
  },

  // `multiply_const`, and the node that lets a chain of arithmetic end at a level
  // anything downstream can use. A conjugate product comes out scaled by the power of
  // whatever it was compared against, and a matrix between two branches needs them at the
  // same size — so somewhere between the arithmetic and the speaker there has to be one
  // number, and this is it.
  'core.gain': {
    name: 'Gain', group: 'Convert', in: ['iq', 'real'], out: 'same',
  },

  // The first operation with two inputs (ADR-0038). It is what makes a decode something
  // you can draw rather than something you invoke: the stereo decoder, spelled out, is a
  // tuner on the pilot, a tuner on the subcarrier, and this between them.
  //
  // Its output kind is whatever its inputs are — both must be the same, because there is
  // no meaning to adding a bitstream to a spectrum — and its second input is chosen from
  // the graph rather than drawn on a spectrum, which is the one thing in this tool that
  // asks you to point at a node.
  'core.math': {
    name: 'Math', group: 'Analyze', in: ['iq', 'real'], out: 'same',
    twoInputs: true,
  },
  // `symbol_sync_ff`, and the step a decoder that reads symbols needs in front of it.
  //
  // Most external decoders take samples and find their own clock. Some take symbols —
  // M17's packet decoder is the one here — and then somebody has to decide where in each
  // symbol period to look. Doing that inside the adapter would hide it, which is the
  // thing this tool is against: the sampling instant and the level fit are the two
  // numbers that decide whether a decode happens, so they belong on a node with their
  // evidence beside them.
  //
  // Out is `real` at the symbol rate. A soft symbol is a real number, and a stream of
  // them is a real stream — there is no third thing to be, and making one would mean a
  // new kind that only one decoder reads (ADR-0006).
  'core.symbols': {
    name: 'Symbol sync', group: 'Convert', in: 'real', out: 'real',
  },
  'core.burst_detector': {
    name: 'Burst detector', group: 'Analyze', in: 'iq', out: 'events',
    stub: true,
  },
};

/**
 * IQ to a real-valued stream, given an operation and nothing else.
 *
 * The same code a demodulator node runs, reachable without building one — which is what
 * `Identify` needs, because it speculatively demodulates a span several different ways
 * and throws away all but the ones that decoded something. Building four nodes and
 * deleting three of them would leave the graph as the record of a guess.
 *
 * Parameters are derived from the samples in hand when none are supplied, so the answer
 * comes with the evidence for how it was produced (ADR-0017) even when nobody chose it.
 */
export function demodulate(op, iq, count, fs, params = null) {
  const d = DETECTORS[op];
  if (d) {
    const p = params || d.derive(iq, count, fs);
    return { data: d.detect(iq, count, fs, p), params: p, label: d.label };
  }
  // AM: the rectifier, then the post-detection low-pass every real receiver has
  return {
    data: dsp.smooth(dsp.amEnvelope(iq, count), dsp.envelopeWindow(fs)),
    params: {},
    label: 'AM demod',
  };
}

/**
 * A real stream in, a real stream out — the same shape as `demodulate`, for the
 * operations whose input has already been demodulated once.
 *
 * There is one of these so far and the indirection is still worth it: `_detect` should
 * not learn the name of an operation, and the next real-to-real node should be a case
 * here rather than a branch in the engine.
 */
export function realOp(op, x, count, fs, params = null) {
  if (op === 'core.symbols') {
    // The only one of these whose output rate is not its input's, which is why the
    // return may carry a rate and a count of its own. Given no parameters it measures
    // them — which is exactly what `Identify` needs, since a speculative pass has no
    // node to have derived them on (ADR-0040).
    const rate = params ? Number(params.symbolRate.value) : SYMBOL_RATE;
    if (params) {
      return {
        data: dsp.softSymbolsAt(x, count, fs, rate, {
          phase: params.phase.value, center: params.center.value, gain: params.gain.value,
          invert: params.invert.value === 'yes', span: SYMBOL_SPAN,
        }),
        sampleRate: rate, label: 'Symbol sync',
      };
    }
    const fit = dsp.softSymbols(x, count, fs, rate);
    return { data: fit.symbols, count: fit.n, sampleRate: rate, eye: fit.eye, label: 'Symbol sync' };
  }
  if (op === 'core.stereo') {
    // Number(), because the strip offers this as a list and a list hands back strings.
    const tau = params ? Number(params.deemphasisUs.value) : 75;
    // `auto` re-measures the pilot on the samples in hand; `stereo` and `mono` are the
    // two ways to overrule that, and both are a decision a person made.
    const want = !params || params.decode.value === 'auto' ? 'auto' : params.decode.value === 'stereo';
    return {
      data: dsp.stereoDecode(x, count, fs, { deemphasisUs: tau, stereo: want }).data,
      label: 'Stereo decode',
    };
  }
  return { data: x, label: op };
}

/**
 * The detectors, as a table rather than a switch: each says how to derive its
 * parameters from the signal, and how to turn IQ into a real-valued stream. Adding
 * the fourth one should be a row here and a line in OPS, not an edit in five places.
 */
const DETECTORS = {
  'core.fm_discriminator': {
    label: 'FM demod',
    derive(iq, count, fs) {
      const d = dsp.estimateDeviation(iq, count, fs);
      return {
        deviationHz: param(Math.round(d.value) || 3000, 'auto', {
          from: d.confident
            ? 'the 98th percentile of the instantaneous frequency'
            : 'instantaneous frequency (looks unmodulated)',
          confident: d.confident,
        }),
        gain: param(1, 'manual'),
      };
    },
    detect(iq, count, fs, params) {
      const f = dsp.fmDiscriminate(iq, count, fs);
      // scale so full deviation is full scale — the display and the audio sink then
      // mean the same thing across signals of wildly different loudness
      const k = (params.gain.value || 1) / Math.max(1, params.deviationHz.value);
      const out = new Float32Array(count);
      for (let i = 0; i < count; i++) out[i] = f[i] * k;
      return out;
    },
  },
  'core.ssb': {
    label: 'SSB demod',
    derive(iq, count, fs) {
      const sb = dsp.estimateSideband(iq, count);
      return {
        sideband: param(sb.value, 'auto', {
          from: sb.confident
            ? `energy ${Math.abs(sb.ratioDb).toFixed(0)} dB higher ${sb.ratioDb > 0 ? 'above' : 'below'} center`
            : 'both sides look alike — this is a guess',
          confident: sb.confident,
        }),
        bfoHz: param(0, 'manual'),
        gain: param(6, 'manual'),
      };
    },
    detect(iq, count, fs, params) {
      const a = dsp.ssbDemod(iq, count, fs, params.sideband.value, params.bfoHz.value);
      const g = params.gain.value || 1;
      for (let i = 0; i < count; i++) a[i] *= g;
      return a;
    },
  },
  'core.cw': {
    label: 'CW demod',
    derive(iq, count, fs) {
      const off = dsp.estimateCarrierOffset(iq, count, fs);
      return {
        offsetHz: param(Math.round(off.value), 'auto', {
          from: off.confident
            ? `the strongest bin, ${off.snrDb.toFixed(0)} dB over the floor`
            : 'the strongest bin (no clear carrier)',
          confident: off.confident,
        }),
        // where you want to hear it. A preference, not a measurement, so it starts
        // manual — marking it auto would claim evidence that does not exist.
        pitchHz: param(700, 'manual'),
        gain: param(4, 'manual'),
      };
    },
    detect(iq, count, fs, params) {
      const a = dsp.cwBeat(iq, count, fs, params.offsetHz.value, params.pitchHz.value);
      const g = params.gain.value || 1;
      for (let i = 0; i < count; i++) a[i] *= g;
      return a;
    },
  },
};

/** An operation's input type, which may be one kind, several, or anything. */
export function accepts(want, kind) {
  if (want === '*') return true;
  return Array.isArray(want) ? want.includes(kind) : want === kind;
}

/**
 * The same filter-and-decimate a tuner runs, at whatever whole ratio gets close to four
 * times the fastest audio rate any candidate wants.
 *
 * Four times, not one: the decoder does its own resampling on the other side and a
 * margin above its rate costs almost nothing here, while cutting it fine would throw
 * away the transition band the decoder is about to need. A span already at or below
 * that rate is passed through, which is the common case — most channels are narrow by
 * the time anybody asks what they are.
 */
function decimateFor(got, fs, audioRate) {
  const target = audioRate * 4;
  const decim = Math.max(1, Math.floor(fs / target));
  if (decim === 1) return { data: got.data, count: got.count, rate: fs };
  const taps = dsp.lowPassTaps(65, fs / (2 * decim), fs);
  const count = Math.floor(got.count / decim);
  // xlateFilterDecimate reads `count * decim + taps.length` samples, so the tail of the
  // span has to be there to be read; one filter length short of the end is nothing at
  // these rates and the alternative is reading past the array.
  const room = Math.floor((got.count - taps.length) / decim);
  const n = Math.max(1, Math.min(count, room));
  return {
    data: dsp.xlateFilterDecimate(got.data, taps, 0, fs, decim, n, 0).samples,
    count: n,
    rate: fs / decim,
  };
}

/** Solid first, thin next, silent last; then by how much, then by name. */
function rank(a, b) {
  const tier = (r) => (r.records > 0 && !r.thin && !r.suspect ? 0 : r.records > 0 ? 1 : 2);
  return tier(a) - tier(b) || b.records - a.records ||
         a.name.localeCompare(b.name) || String(a.viaLabel).localeCompare(String(b.viaLabel));
}

/**
 * Run `work` over every item, at most `limit` at a time, in the order they finish.
 *
 * The cap is because each of these is a subprocess: eight decoders at once on a laptop
 * is eight resamples and eight programs competing for the same cores, and the report
 * fills in more slowly than it would with three. Rejections are the caller's to handle
 * — here every unit already resolves with its own error.
 */
async function inParallel(items, limit, work) {
  let next = 0;
  const runner = async () => {
    while (next < items.length) {
      const i = next++;
      await work(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
}

/** Bits to bytes, in whichever order the chain is reading them. */
function bytesOf(bits, msbFirst = true) {
  const out = new Uint8Array(Math.floor(bits.length / 8));
  for (let b = 0; b < out.length; b++) {
    let v = 0;
    for (let k = 0; k < 8; k++) {
      const bit = bits[b * 8 + k];
      v |= msbFirst ? (bit << (7 - k)) : (bit << k);
    }
    out[b] = v;
  }
  return out;
}

/**
 * How much of a byte stream reads as text.
 *
 * A weak test used for exactly one thing: choosing between a decode and its own inverse,
 * where nothing in the signal decides and the two are otherwise indistinguishable. It is
 * not evidence that something decoded — the external decoder runner has the same measure
 * for the same reason, and there it is a reason to *refuse* a result rather than accept
 * one (ADR-0031).
 */
function printableRatio(bytes) {
  if (!bytes.length) return 0;
  let n = 0;
  for (const v of bytes) if ((v >= 32 && v < 127) || v === 10 || v === 13 || v === 9) n++;
  return n / bytes.length;
}

/** First occurrence of a byte pattern, or -1. */
function findBytes(hay, needle) {
  if (!needle.length) return -1;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * A name somebody typed, made safe to put in a one-line strip.
 *
 * Control characters and newlines are stripped rather than escaped: a name is a label,
 * and a label containing a newline is a rendering bug waiting for the first person who
 * pastes one in. Runs of whitespace collapse for the same reason.
 */
export function cleanName(name) {
  return String(name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32);
}

/**
 * What to say about a tap count, including when it is not enough.
 *
 * Decimating drops everything around a multiple of the output rate on top of the
 * channel, and a short filter lets it in. The figure quoted is the worst gain anywhere
 * that folds — so "48 dB down" means a neighbouring channel arrives at a thousandth of
 * its real strength, and "10 dB down" means it arrives at a third of it and your bytes
 * are somebody else's.
 *
 * When no affordable tap count reaches the target the evidence says so plainly, because
 * a narrow channel on a fast source genuinely cannot be brick-walled by one FIR and the
 * useful response is to widen the selection rather than to keep turning the knob.
 */
function tapEvidence(filt, decim) {
  if (decim <= 1) {
    return { from: 'nothing is decimated here, so nothing folds in', confident: true };
  }
  const db = Math.abs(filt.rejectionDb).toFixed(0);
  return filt.met
    ? { from: `the worst of what folds in lands ${db} dB down`, confident: true }
    : { from: `the worst of what folds in is only ${db} dB down — this channel is narrow ` +
              'enough that a neighbour will leak into it. A wider selection is the fix, ' +
              'not more taps',
        confident: false };
}

function param(value, mode = 'manual', auto = null) {
  return { value, mode, auto };
}

export class MockEngine extends Graph {
  /**
   * `latency: false` for an engine with a network in front of it.
   *
   * The simulated delays exist so the UI is tuned against a backend that cannot
   * answer instantly (ADR-0021). Once there is a real one, they stop being honest
   * and start being 260 ms added to every structural edit on top of the real cost.
   */
  constructor({ latency = true } = {}) {
    super();
    this._sleep = latency ? sleep : instant;
  }

  // ── session ──────────────────────────────────────────────────────────────
  async createSession() {
    await this._sleep(120);
    const root = {
      id: nid('n'), parent: null, op: 'core.source',
      label: 'synthetic #0',
      params: {
        sampleRate: param(scene.SOURCE.sampleRate),
        centerHz: param(scene.SOURCE.centerHz),
      },
      out: { kind: 'iq', sampleRate: scene.SOURCE.sampleRate, centerHz: scene.SOURCE.centerHz },
    };
    this.nodes.set(root.id, root);
    this.root = root;
    return root;
  }

  /**
   * Point the session at a loaded capture instead of the synthetic scene.
   *
   * Everything downstream of the source is thrown away rather than retuned: the
   * channels were drawn on a different band at a different rate, so keeping them
   * would leave tuners pointing at frequencies the new file does not contain — a
   * quieter kind of wrong than an empty tree.
   */
  async openCapture(cap) {
    await this._sleep(LATENCY.structuralMs);
    for (const c of this.children(this.root.id)) await this.removeNode(c.id);
    this.capture = cap;
    this.letters = 0;
    this.t = 0;
    const root = this.root;
    root.label = cap.label;
    root.params.sampleRate = param(cap.sampleRate);
    root.params.centerHz = param(cap.centerHz);
    root.out = { kind: 'iq', sampleRate: cap.sampleRate, centerHz: cap.centerHz };
    return root;
  }

  /**
   * Point the session at a radio instead of a file.
   *
   * The same call as `openCapture` in every way that matters, because ADR-0005 says a
   * live source is a medium that happens to still be being written — the engine below
   * this line cannot tell them apart, and that is the whole design.
   */
  async openRadio(radio) {
    const root = await this.openCapture(radio);
    // Opening a radio means "show me what is on the air", not "show me the oldest
    // thing still in the buffer". The playhead starts at the live edge; scrubbing back
    // into what the ring already holds is then a deliberate move rather than the
    // state you happen to land in.
    this.t = radio.durationS;
    return root;
  }

  /**
   * Everything a node produces between two moments, in one go.
   *
   * Every other read in this engine is a window for a display, capped at what fits on
   * screen. An export is the opposite: it wants all of it, and it is allowed to be
   * slow because it happens once. `onProgress` exists because "all of it" can be a
   * minute of a 500 kS/s channel and a frozen tab is indistinguishable from a crash.
   */
  async readSpan(nodeId, t0, t1, onProgress) {
    const n = this.node(nodeId);
    if (!n || (n.out.kind !== 'iq' && n.out.kind !== 'real')) return null;
    const fs = n.out.sampleRate;
    const total = Math.max(1, Math.floor((t1 - t0) * fs));
    const chunk = 1 << 16;
    const iq = n.out.kind === 'iq';
    const out = new Float32Array(iq ? total * 2 : total);
    for (let done = 0; done < total; done += chunk) {
      const want = Math.min(chunk, total - done);
      const at = t0 + (done + want) / fs;          // reads end at a moment
      const got = iq ? this._readIQ(n, at, want) : this._detectMono(n, at, want);
      out.set(got.subarray(0, iq ? want * 2 : want), iq ? done * 2 : done);
      if (onProgress) {
        onProgress(Math.min(1, (done + want) / total));
        await new Promise((r) => setTimeout(r, 0));   // let the frame loop breathe
      }
    }
    return { data: out, sampleRate: fs, kind: n.out.kind, count: total };
  }

  /**
   * Slice a whole capture to bytes, once.
   *
   * Not a frame. The packet in a capture can be anywhere in it and eight seconds
   * long, so a window sized for a display would miss it entirely — this reads the
   * lot, which is a job rather than something to redo sixty times a second. The
   * result is cached on the node against the parameters that produced it, so the
   * view is free until something actually changes.
   */
  async sliceBytes(nodeId, onProgress, at = null) {
    const n = this.node(nodeId);
    if (!n || n.out.kind !== 'bytes') return null;
    const p = this.node(n.parent);

    // Three things produce bytes now, and one of them eats bytes rather than samples.
    // Dispatching here rather than in three near-identical methods keeps the caching,
    // the span selection and the progress reporting in one place.
    if (n.op === 'core.differential') return this._sliceDifferential(n, p, onProgress, at);
    if (n.op === 'core.despread') return this._sliceDespread(n, p, onProgress, at);

    const keys = n.op === 'core.manchester'
      ? ['threshold', 'symbolUs', 'polarity', 'syncHex', 'bitOrder']
      : ['threshold', 'symbolUs', 'syncHex', 'bitOrder'];
    const keyOf = () => keys.map((k) => n.params[k].value).join('|');
    if (n._sliced && n._sliced.key === keyOf()) return n._sliced;

    const fs = p.out.sampleRate;
    const pin = this.isPinned(p.id);
    const t0 = pin ? pin.params.t0.value : 0;
    const now = at != null ? at : this.t;
    const t1 = pin ? pin.params.t1.value : (isFinite(this.duration()) ? this.duration() : now);
    const got = await this.readSpan(p.id, t0, t1, onProgress);
    if (!got) return null;

    // Estimate from the whole span, not a window of it — the packet is wherever it
    // is, and an estimator that only looked at the first two seconds of british_news
    // measured the announcer.
    if (n.params.threshold.mode === 'auto') {
      const otsu = dsp.otsuThreshold(got.data);
      n.params.threshold = { ...n.params.threshold, value: otsu.value,
        auto: { from: `Otsu over all ${(t1 - t0).toFixed(1)} s`, hist: otsu.hist } };
    }
    const manchester = n.op === 'core.manchester';
    if (n.params.symbolUs.mode === 'auto') {
      const sym = manchester
        ? dsp.estimateManchesterSymbol(got.data, n.params.threshold.value, fs)
        : dsp.estimateNrzSymbol(got.data, n.params.threshold.value, fs);
      n.params.symbolUs = { ...n.params.symbolUs,
        value: sym.value > 0 ? +sym.value.toFixed(2) : n.params.symbolUs.value,
        auto: {
          from: manchester
            ? (sym.confident
                // The signature of a line code with a transition every symbol: runs
                // come in exactly two lengths and never a third.
                ? `every run is one or two half-symbols of ${(sym.value / 2).toFixed(1)} \u00b5s ` +
                  `(${(sym.agreement * 100).toFixed(0)}% of ${sym.runs} runs)`
                : `runs come in more than two lengths over ${sym.runs} of them — ` +
                  'this may not be Manchester')
            : (sym.confident
                ? `every run is a multiple of ${sym.value.toFixed(1)} \u00b5s (${(sym.agreement * 100).toFixed(0)}% of ${sym.runs} runs)`
                : `shortest run over ${sym.runs} runs — they do not agree, so this is a guess`),
          confident: sym.confident,
        } };
    }

    const msb = n.params.bitOrder.value !== 'lsb';
    const sync = dsp.syncBitsOf(n.params.syncHex.value, msb);
    const r = manchester
      ? dsp.manchesterSlice(got.data, n.params.threshold.value, fs, n.params.symbolUs.value,
                            { msbFirst: msb, syncBits: sync, polarity: n.params.polarity.value })
      : dsp.nrzSlice(got.data, n.params.threshold.value, fs, n.params.symbolUs.value,
                     { msbFirst: msb, syncBits: sync });
    n._sliced = { key: keyOf(), ...r, t0, t1, sampleRate: fs };
    return n._sliced;
  }

  /**
   * Every burst a PWM slicer found, over the whole span rather than a display window.
   *
   * `frame()` slices a window because that is what a view shows. A decoder wants all of
   * them, for the same reason `sliceBytes` reads the whole capture: the packet is
   * wherever it is, and a window sized for a display is almost never over it.
   */
  async sliceBursts(n, at = null) {
    const p = this.node(n.parent);
    if (!p) return null;
    const keyOf = () => [n.params.threshold.value, n.params.symbolUs.value].join('|');
    if (n._bursts && n._bursts.key === keyOf()) return n._bursts;

    const fs = p.out.sampleRate;
    const pin = this.isPinned(p.id);
    const now = at != null ? at : this.t;
    const t0 = pin ? pin.params.t0.value : 0;
    const t1 = pin ? pin.params.t1.value : (isFinite(this.duration()) ? this.duration() : now);
    const got = await this.readSpan(p.id, t0, t1);
    if (!got) return null;

    const raw = dsp.pwmSlice(got.data, n.params.threshold.value, fs, n.params.symbolUs.value);
    n._bursts = {
      key: keyOf(), t0, t1, sampleRate: fs,
      groups: raw.map((g) => ({ bits: g.bits, t: t0 + g.start / fs,
                                durationS: (g.end - g.start) / fs })),
    };
    return n._bursts;
  }

  /**
   * Despread, in the order the three unknowns narrow each other.
   *
   * Chip rate first, because it comes from the transitions and needs nothing else.
   * Carrier offset second, because a correlation over a code period is a coherent
   * integration over that period and an uncorrected offset makes it sum to nothing —
   * at 900 Hz and 60 kchip/s a 127-chip integration is two full rotations. The code
   * last, because by then it is a correlation over chips rather than samples, which is
   * what makes searching six hundred candidates something that finishes.
   *
   * Every one of them says what told it so (ADR-0017), and the search says what it did
   * not try as well as what it found (ADR-0031).
   */
  async _sliceDespread(n, p, onProgress, at) {
    const named = n.params.code.mode === 'manual' && n.params.code.value !== 'auto'
      ? n.params.code.value : '';
    const pinnedRate = n.params.chipRate.mode === 'manual' && n.params.chipRate.value > 0
      ? n.params.chipRate.value : 0;
    // Keyed on the question rather than the answer: this writes the chip rate and the
    // code it found back into its own parameters, so a key built from their values
    // changes the moment the work is done and never hits (the OFDM grid learned this
    // the hard way).
    const keyOf = () => [named || 'auto', pinnedRate || 'auto', n.params.invert.value,
                         n.params.syncHex.value, n.params.bitOrder.value].join('|');
    if (n._sliced && n._sliced.key === keyOf()) return n._sliced;

    const span = await this._spanOf(p, at);
    if (!span) return null;
    const fs = span.sampleRate;
    const fail = (why) => {
      n._sliced = { key: keyOf(), bytes: new Uint8Array(0), bits: 0, error: why,
                    t0: span.t0, t1: span.t1, sampleRate: fs };
      return n._sliced;
    };

    const chip = pinnedRate
      ? { chipRate: pinnedRate, samplesPerChip: fs / pinnedRate, phase: 0, confident: true,
          agreement: 1, transitions: 0 }
      : dsp.estimateChip(span.data, span.count, fs);
    if (!(chip.samplesPerChip >= 2)) return fail(chip.reason || 'no chip rate could be measured');
    n.params.chipRate = { ...n.params.chipRate, value: Math.round(chip.chipRate),
      auto: { from: pinnedRate ? 'pinned'
                : `every run between transitions is a multiple of ${chip.samplesPerChip.toFixed(2)} samples ` +
                  `(${((chip.agreement || 0) * 100).toFixed(0)}% of ${chip.transitions} of them)`,
              confident: !!chip.confident } };

    const off = n.params.offsetHz.mode === 'manual'
      ? { hz: n.params.offsetHz.value, coherence: 1, confident: true }
      : dsp.estimateBpskOffset(span.data, span.count, fs);
    n.params.offsetHz = { ...n.params.offsetHz, value: +off.hz.toFixed(1),
      auto: { from: `the squared signal is a tone there (${(off.coherence * 100).toFixed(0)}% coherent)`,
              confident: !!off.confident } };

    const chips = dsp.chipStream(span.data, span.count, chip.samplesPerChip, chip.phase);
    dsp.derotateChips(chips, (2 * Math.PI * off.hz) / chip.chipRate);
    if (chips.n < 32) return fail('too few chips in this span to find a code');

    let best, evidence, notTried = [];
    if (named) {
      const one = spreading.byId(named);
      if (!one) return fail(`no code called ${named}`);
      const found = dsp.searchCodes(chips, [one], { minPeriods: 1 });
      if (!found.best) return fail(`${named} does not fit in this span`);
      best = found.best;
      evidence = `${one.name} \u2014 ${one.detail}, given rather than searched for; ` +
                 `peak ${best.psr.toFixed(1)}\u00d7 its own sidelobes`;
    } else {
      const { candidates, excluded } = spreading.sweep();
      const found = dsp.searchCodes(chips, candidates);
      if (!found.best) return fail('no code long enough to check fits in this span');
      best = found.best;
      const m = found.margin;
      evidence = `${found.tried} codes tried; ${best.code.name} (${best.code.detail}) ` +
                 `peaks ${best.psr.toFixed(1)}\u00d7 its own sidelobes, ` +
                 (isFinite(m) ? `${m.toFixed(1)}\u00d7 the next code` : 'and nothing else came close');
      // What was not tried, and why — the half of the answer that is easy to leave out.
      for (const e of excluded) notTried.push(`${e.family}: ${e.why}`);
      for (const s of found.skipped) {
        notTried.push(`${s.count} codes of ${s.length} chips: only ${s.have} periods in this span, ` +
                      `and ${s.need} are needed before a peak means anything`);
      }
      n._ranked = found.ranked;
    }

    // A code found by correlation is not the same as a code that decoded something. The
    // peak-to-sidelobe ratio is the evidence for the first; the eye is the evidence for
    // the second, and they can disagree.
    const confident = best.psr > 6;
    n.params.code = { ...n.params.code, value: best.code.id,
      auto: { from: evidence, confident, notTried } };

    const msb = n.params.bitOrder.value !== 'lsb';
    const want = n.params.invert.mode === 'manual' ? n.params.invert.value : 'auto';
    const normal = dsp.despread(chips, best.code.chips, best.offset);
    const flipped = want === 'auto' || want === 'inverted'
      ? dsp.despread(chips, best.code.chips, best.offset, { invert: true }) : null;

    let use = normal, chose = 'normal';
    if (want === 'inverted') { use = flipped; chose = 'inverted'; }
    else if (want === 'auto' && flipped) {
      const score = (b) => printableRatio(bytesOf(b.bits, msb));
      const a = score(normal), f = score(flipped);
      if (f > a) { use = flipped; chose = 'inverted'; }
      n.params.invert = { ...n.params.invert, value: chose,
        auto: { from: `${(Math.max(a, f) * 100).toFixed(0)}% of the bytes are printable ` +
                      `${chose === 'inverted' ? 'inverted' : 'as they are'}, against ` +
                      `${(Math.min(a, f) * 100).toFixed(0)}% the other way`,
                confident: Math.abs(a - f) > 0.2 } };
    }

    const all = bytesOf(use.bits, msb);
    const sync = frames.bytesOfHex(n.params.syncHex.value);
    const at8 = sync.length ? findBytes(all, sync) : -1;
    const bytes = at8 >= 0 ? all.subarray(at8 + sync.length) : all;

    n._sliced = {
      key: keyOf(), bytes, bits: use.bits.length, sampleRate: fs, t0: span.t0, t1: span.t1,
      syncAt: at8, sps: chip.samplesPerChip, eye: use.eye, psr: best.psr,
      code: best.code.id, chipOffset: best.offset,
    };
    return n._sliced;
  }

  /** Differential sits on bytes, so its input is whatever the node above it sliced. */
  async _sliceDifferential(n, p, onProgress, at) {
    const keyOf = () => [n.params.mode.value, n.params.bitOrder.value].join('|');
    if (n._sliced && n._sliced.key === keyOf()) return n._sliced;
    const src = await this.sliceBytes(p.id, onProgress, at);
    if (!src) return null;
    const r = dsp.differentialDecode(src.bytes, n.params.mode.value,
                                     { msbFirst: n.params.bitOrder.value !== 'lsb' });
    n._sliced = { key: keyOf(), ...r, t0: src.t0, t1: src.t1, sampleRate: src.sampleRate };
    return n._sliced;
  }

  /**
   * Frames, and the CRC that says whether they are frames at all.
   *
   * The CRC is derived by trying the catalog rather than configured, because it is the
   * one check in the chain that can *confirm* a guess. Every variant against every
   * frame is microseconds, and an answer only counts if it validates all of them — one
   * short frame agreeing with an 8-bit CRC happens one time in 256 and means nothing.
   */
  /**
   * Every dwell in the span, in order, with the channel set derived from them.
   *
   * The parameters are filled in from what was found and say what told them so
   * (ADR-0017) — a hop map that arrives needing to be told the dwell time is a hop map
   * for somebody who already knew the answer, which is nobody.
   */
  async runHops(n, at) {
    const p = this.node(n.parent);
    const t0 = performance.now();
    const span = await this._spanOf(p, at);
    if (!span) return { records: [], error: 'nothing upstream has produced samples yet' };

    const bins = Math.max(32, Math.round(n.params.bins.value) || 256);
    const found = dsp.findHops(span.data, span.count, span.sampleRate, { bins, step: bins >> 1 });

    const evidence = found.hops.length
      ? `${found.hops.length} dwells over ${(span.t1 - span.t0).toFixed(2)} s`
      : 'no dwells found';
    n.params.dwellMs = { ...n.params.dwellMs, value: +(found.dwellS * 1000 || 0).toFixed(3),
      auto: { from: found.confident
        ? `the median of ${found.hops.length} dwells (${(found.agreement * 100).toFixed(0)}% within a quarter of it)`
        : `${evidence} — the dwells do not agree with each other, so this may not be a hopper`,
        confident: found.confident } };
    n.params.spacingHz = { ...n.params.spacingHz, value: Math.round(found.spacingHz || 0),
      auto: { from: found.channels.length > 1
        ? `the median gap between ${found.channels.length} channels`
        : 'only one channel was used, so there is no spacing to measure',
        confident: found.channels.length > 1 } };
    n.params.channels = { ...n.params.channels, value: found.channels.length,
      auto: { from: `peak frequencies clustered by their gaps, ${evidence}`, confident: found.confident } };

    if (!found.hops.length) {
      return { records: [], ms: performance.now() - t0,
               error: found.reason ? `no hopping here: ${found.reason}` : 'no dwells above the noise floor' };
    }

    const centerHz = p.out.centerHz;
    const records = found.hops.map((h, i) => ({
      text: `ch ${h.channel} · ${((centerHz + h.hz) / 1e6).toFixed(4)} MHz`,
      n: i, channel: h.channel, t: +h.t0.toFixed(4),
      ms: +((h.t1 - h.t0) * 1000).toFixed(2),
      offsetHz: Math.round(h.hz),
    }));
    // The order is the answer. A reader scrolling forty rows to write down a sequence is
    // a reader doing by hand the one thing this node exists to do.
    records.unshift({
      text: `sequence: ${found.hops.map((h) => h.channel).join(' ')}`,
      dwells: found.hops.length, channels: found.channels.length,
      dwellMs: +(found.dwellS * 1000).toFixed(2),
      spacingHz: Math.round(found.spacingHz),
    });
    return { records, ms: performance.now() - t0,
             note: `${found.channels.length} channels, ${found.hops.length} dwells` };
  }

  /**
   * A window to estimate from: as long as makes sense, and inside the medium.
   *
   * Every `auto` parameter that is derived when a node is made is derived from this, so
   * it is the difference between a value with evidence behind it and a value derived from
   * the silence before the recording started.
   */
  _peekWindow(fs, now, seconds = 0.25) {
    const d = this.duration();
    const have = isFinite(d) ? Math.floor(d * fs) : Infinity;
    const count = Math.max(256, Math.min(65536, Math.floor(fs * seconds), have));
    // End far enough in for the window to be full, but never past the end of the medium.
    const earliest = count / fs;
    const at = isFinite(d) ? Math.min(d, Math.max(now, earliest)) : Math.max(now, earliest);
    return { count, at };
  }

  /** The whole span a node should be analyzed over: the pinned clip, or all of it. */
  async _spanOf(p, at) {
    const pin = this.isPinned(p.id);
    const now = at != null ? at : this.t;
    const t0 = pin ? pin.params.t0.value : 0;
    const t1 = pin ? pin.params.t1.value : (isFinite(this.duration()) ? this.duration() : now);
    const got = await this.readSpan(p.id, t0, t1);
    return got ? { ...got, t0, t1 } : null;
  }

  async runFrames(n, at) {
    const p = this.node(n.parent);
    const t0 = performance.now();

    // A slicer that produced bursts has already done the framing: each burst is a
    // frame, and looking for a sync word inside one would be looking for a boundary
    // that is already known. A byte stream has no such structure and needs the sync.
    const sync = frames.bytesOfHex(n.params.syncHex.value);
    let found;
    if (p.out.kind === 'bits') {
      const bursts = await this.sliceBursts(p, at);
      if (!bursts) return { records: [], error: 'nothing upstream has produced bits yet' };
      if (!bursts.groups.length) {
        return { records: [], ms: performance.now() - t0,
                 error: 'the slicer found no bursts — its threshold and symbol period are the thing to move' };
      }
      const msb = true;
      found = bursts.groups.map((g, i) => ({
        at: i, bit: 0, bytes: dsp.packBits(g.bits, { msbFirst: msb }).bytes, t: g.t,
      })).filter((f) => f.bytes.length);
      if (!found.length) {
        return { records: [], ms: performance.now() - t0,
                 error: `${bursts.groups.length} bursts, none of them a whole byte long` };
      }
    } else {
      const src = await this.sliceBytes(p.id, null, at);
      if (!src) return { records: [], error: 'nothing upstream has produced bytes yet' };
      found = frames.findFrames(src.bytes, {
        syncBytes: sync, frameBytes: Math.max(0, Math.round(n.params.frameBytes.value)),
      });
    }
    if (!found.length) {
      return { records: [], ms: performance.now() - t0,
               error: sync.length ? 'that sync word does not appear in the bytes' : 'no bytes to frame' };
    }

    let spec = null;
    const want = n.params.crc.value;
    if (want === 'auto') {
      const got = frames.detectCrc(found.map((f) => f.bytes));
      spec = got;
      n.params.crc = { ...n.params.crc, value: 'auto',
        auto: got
          ? { from: got.from, confident: got.confident }
          : { from: `nothing in the catalog validates all ${found.length} frames`, confident: false } };
    } else if (want !== 'none') {
      const c = frames.crcById(want);
      if (c) spec = { ...c, littleEndian: false };
    }

    const records = found.map((f, i) => {
      // A detected CRC can also have found where each frame really ends; the bytes
      // after that are the gap before the next one, not part of the packet.
      const chk = frames.checkFrame(f.bytes, spec, spec && spec.lengths ? spec.lengths[i] : 0);
      const body = chk.checked ? f.bytes.subarray(0, chk.bodyEnd) : f.bytes;
      const rec = {
        text: [...body].map((x) => x.toString(16).padStart(2, '0')).join(' '),
        at: f.t != null ? `${f.t.toFixed(3)} s` : `bit ${f.bit}`,
        bytes: body.length,
      };
      // Hex is what the frame is; text is what it says. Shown when the frame is mostly
      // printable, because when it is, that is the whole answer and reading it out of
      // the hex by hand is a chore nobody should be doing twice.
      const printable = [...body].filter((v) => v >= 32 && v < 127).length;
      if (body.length && printable / body.length >= 0.75) {
        rec.reads = [...body].map((v) => (v >= 32 && v < 127 ? String.fromCharCode(v) : '·')).join('');
      }
      if (chk.checked && chk.tail > 0) rec.then = `${chk.tail} B of dead air`;
      if (chk.checked) {
        rec.crc = chk.ok
          ? `ok (${chk.got.toString(16).padStart(spec.width / 4, '0')})`
          : `BAD — reads ${chk.want.toString(16).padStart(spec.width / 4, '0')}, ` +
            `computes ${chk.got.toString(16).padStart(spec.width / 4, '0')}`;
      }
      return rec;
    });

    const good = spec ? records.filter((r) => /^ok/.test(r.crc || '')).length : 0;
    return {
      records, ms: performance.now() - t0,
      note: spec
        ? `${good} of ${records.length} pass ${spec.name}`
        : `${records.length} frames, no CRC identified`,
    };
  }

  /**
   * Run a plugin node over its parent's output.
   *
   * The whole reason this boundary is cheap: the input is a few kilobytes that were
   * already computed for the view above, and the output is a handful of records. No
   * rate to negotiate, no format to convert, nothing to supervise.
   */
  async runRecords(nodeId, at = null) {
    const n = this.node(nodeId);
    if (!n) return null;
    if (n.op === 'core.framer') {
      const out = await this.runFrames(n, at);
      n._records = out;
      return out;
    }
    if (n.op === 'core.hopmap') {
      const out = await this.runHops(n, at);
      n._records = out;
      return out;
    }
    if (n.adapter && this.runAdapter) {
      const out = await this.runAdapter(n, at);
      n._records = out;
      return out;
    }
    return this.runPlugin(nodeId, at);
  }

  /**
   * The in-tab engine has no network, so a stream sink here is a sink with nothing
   * behind it.
   *
   * Said rather than thrown: this is the same shape as an external decoder in the
   * hosted build — the node is real, the graph is honest about what it contains, and
   * what cannot happen says so in the one place somebody will look for it.
   */
  async streamPush() {
    return { error: 'a stream sink sends from the engine, and this tab is the engine',
             sent: 0, bytes: 0, sentNow: 0 };
  }

  async streamStop() { return { stopped: true }; }

  /**
   * One span of a decoder's output, without disturbing what the node already holds.
   *
   * `runRecords` answers "what is in this capture" and caches the answer on the node.
   * This answers "what is in these seconds", which is the question a decoder being
   * watched while the capture plays is being asked over and over — so it returns its
   * records rather than replacing anything, and the caller decides what to keep.
   *
   * Blocks are what make this affordable *and* what make it correct. A decoder handed
   * the whole capture every time the playhead moved would be quadratic; and the symbol
   * sync in front of one now measures its grid per block of capture time, so a block is
   * already the unit over which a decode is a decode.
   */
  async runRecordsSpan(nodeId, t0, t1) {
    const n = this.node(nodeId);
    if (!n || !(t1 > t0)) return null;
    if (n.adapter && this.runAdapter) {
      const out = await this.runAdapter(n, t1, { t0, t1 });
      return { ...out, t0, t1 };
    }
    // Only external decoders read a span of their own. A plugin is handed the view's
    // own samples and a framer reads bytes that are already there, so for those this
    // is the ordinary run and saying so beats pretending otherwise.
    const out = await this.runRecords(nodeId, t1);
    return out ? { ...out, t0, t1 } : null;
  }

  /**
   * Try every decoder that could read this stream, and say what each one found.
   *
   * The plan comes from `identify.js` and the running happens here, because only the
   * engine can read a span and only the engine knows what a demodulator is. Three
   * things about the shape are deliberate:
   *
   * **One span read, many decoders.** Reading the span per candidate would be eight
   * reads of the same seconds of signal, and on a long capture that is most of the wall
   * clock. The demodulated versions are computed once each and shared too.
   *
   * **Results arrive as they land.** `onResult` is called per decoder rather than the
   * whole report returning at the end, because the first one to answer is usually the
   * answer and a list that fills in is the difference between "this is working" and
   * "this has hung". Over the wire that rides the existing per-call progress channel.
   *
   * **What was not tried is part of the answer.** A decoder that is not installed, that
   * takes the wrong kind of stream, or that wants bandwidth the capture never had comes
   * back with its reason. An empty list is otherwise unreadable: you cannot tell a
   * signal nothing recognized from a signal nothing was even asked about.
   */
  async identify(nodeId, { at = null, onResult = null, timeoutMs = 20_000, concurrency = 3 } = {}) {
    const n = this.node(nodeId);
    if (!n) return null;
    if (n.out.kind !== 'iq' && n.out.kind !== 'real') {
      return { tried: [], skipped: [], results: [], error: `nothing to identify on a ${n.out.kind} stream` };
    }
    // An adapter runs as a process, so this needs the engine on a box. Said plainly
    // rather than shown as an empty report, which would read as "nothing matched".
    if (!this.runAdapterData || !(this.adapters || []).length) {
      return { tried: [], skipped: [], results: [], error: 'no decoders available' };
    }

    const fs = n.out.sampleRate;
    const now = at != null ? at : this.t;
    const { t0, t1 } = this.identifyWindow(nodeId, now);

    const { tried, skipped } = identifyPlan(this.adapters,
      { kind: n.out.kind, sampleRate: fs, demods: demodsFor(n.out.kind) });

    const got = tried.length ? await this.readSpan(nodeId, t0, t1) : null;
    if (tried.length && !got) {
      return { tried, skipped, results: [], error: 'nothing upstream has produced samples yet' };
    }

    // Narrow the IQ once before demodulating it, if anything is going to be.
    //
    // An audio decoder wants 48 kHz at most. Demodulating a 2.4 MS/s span and handing
    // that to it means a discriminator over fifty times more samples than the answer
    // needs, and then a fifty-to-one resample per decoder on the far side — eight
    // seconds of a real capture took seventeen and most of a gigabyte. Decimating
    // first is what the chain being proposed would do anyway: this *is* the tuner,
    // run once and shared, and a discriminator that is not listening to 2.4 MHz of
    // noise is a better discriminator too.
    // `feedRate`, not `wants.rate`: a symbol decoder reads 4800 symbols a second off a
    // stream that has to have been wide enough to contain them, and decimating to 4800
    // would take the signal out before the symbol sync ever saw it.
    const audioRate = Math.max(...tried.filter((c) => c.via).map((c) => c.feedRate || c.wants.rate), 0);
    const narrow = audioRate ? decimateFor(got, fs, audioRate) : null;

    // Run each stage once, not once per decoder behind it.
    //
    // A chain is a list now rather than a single demodulator, and the cache is keyed by
    // the *prefix* rather than by the whole chain — so `fm_discriminator` is computed
    // once and both the decoders that read its output and the ones that read a symbol
    // sync on top of it share that one discriminator. Three decoders behind one demod was
    // always the common case; a stage behind a stage is the new one.
    const stages = new Map();
    const feed = (via) => {
      if (!via || !via.length) return { data: got.data, kind: got.kind, rate: fs };
      let cur = { data: narrow.data, count: narrow.count, rate: narrow.rate, kind: 'iq' };
      let key = '';
      for (const op of via) {
        key = key ? `${key}>${op}` : op;
        if (!stages.has(key)) {
          const out = cur.kind === 'iq'
            ? { ...demodulate(op, cur.data, cur.count, cur.rate), count: cur.count, rate: cur.rate }
            : realOp(op, cur.data, cur.count, cur.rate);
          stages.set(key, {
            data: out.data, kind: 'real',
            count: out.count != null ? out.count : cur.count,
            rate: out.sampleRate != null ? out.sampleRate : cur.rate,
          });
        }
        cur = stages.get(key);
      }
      return { data: cur.data, kind: 'real', rate: cur.rate };
    };

    const results = [];
    const started = Date.now();
    await inParallel(tried, concurrency, async (cand) => {
      const { data, kind, rate } = feed(cand.via);
      const out = await this.runAdapterData({
        adapter: cand.id, data, kind, sampleRate: rate, centerHz: n.out.centerHz,
        params: cand.params, timeoutMs,
      });
      const row = {
        id: cand.id, name: cand.name, via: cand.via, viaLabel: cand.viaLabel,
        // The settings it answered with, so the node built from this row is the run
        // that produced it rather than a fresh guess at the same decoder.
        params: cand.params,
        records: out.records.length, ms: out.ms, note: out.note, error: out.error,
        ...(out.rejected ? { rejected: out.rejected } : {}),
        // A decode with almost nothing in it is not a decode. Given OOK bursts and told
        // to try everything, multimon-ng's Morse demodulator returns "E" — one dit,
        // which is what a single noise blip looks like to it — and a report that ranks
        // that alongside two APRS frames and says "1 decoder read something here" is
        // worse than one that found nothing, because it sends you somewhere.
        //
        // The threshold is a judgment and belongs here rather than in the adapter: a
        // one-letter transmission is a real thing and a decoder is right to report it,
        // but a speculative pass across every decoder at once cannot take it seriously.
        // The row still shows what it said, so nothing is hidden — it just does not get
        // to be the headline.
        thin: out.records.length > 0 && textLength(out.records) < MIN_DECODE_CHARS,
        // A parser may mark a record as one the decoder had to guess at — a checksum
        // that did not agree, most often. One suspect record among real ones is a lossy
        // decode and still a decode; a row where *every* record is suspect is a decoder
        // pattern-matching on noise, and ADR-0031 is the whole reason this distinction
        // is drawn rather than counted. It ranks with `thin`: shown, never the headline.
        suspect: out.records.length > 0 && out.records.every((r) => r.suspect),
        // Enough of what it said to recognize the answer, not the whole decode: the
        // point of the report is choosing a decoder, and the decoder's own pane is
        // three characters away once one is chosen.
        sample: out.records.slice(0, 3).map((r) => r.text),
        ...(out.explained ? { explained: out.explained } : {}),
      };
      results.push(row);
      if (onResult) onResult(row);
    });

    // Whatever found the most, first, with the thin results below anything solid and
    // above the silent ones. A decoder that found nothing is still listed, because
    // ruling out 250 known protocols in one action is a real answer.
    results.sort(rank);
    return {
      tried, skipped, results,
      t0, t1, windowS: t1 - t0, sampleRate: fs, kind: n.out.kind, ms: Date.now() - started,
    };
  }

  async runPlugin(nodeId, at = null) {
    const n = this.node(nodeId);
    if (!n || !n.plugin) return null;
    const p = this.node(n.parent);
    const src = p.out.kind === 'bytes' ? await this.sliceBytes(p.id, null, at) : null;
    if (!src) return { records: [], error: 'nothing upstream has produced bytes yet' };
    const args = {};
    for (const [k, v] of Object.entries(n.params)) args[k] = v.value;
    const out = plugins.run(n.plugin, src.bytes, args);
    n._records = out;
    return out;
  }

  // ── palette: only operations valid on this node's output type ────────────
  async palette(nodeId) {
    await this._sleep(8);
    const n = this.node(nodeId);
    const built = Object.entries(OPS)
      .filter(([, o]) => accepts(o.in, n.out.kind))
      // `M4` means M4 again. It had been shared with "the program is not installed", which
      // told a machine without rtl_433 that rtl_433 arrives in a future milestone —
      // two states with nothing in common but a boolean (ADR-0039).
      .map(([id, o]) => ({ id, ...o, ...(o.stub ? { soon: 'M4' } : {}) }));
    // Somebody else's decoders, if this build has a table of them. Marked external and
    // opaque: you cannot see inside one, and the UI says so rather than implying you
    // could have (ADR-0013).
    const ext = (this.adapters || [])
      .filter((a) => accepts(a.in, n.out.kind))
      // **A decoder whose program is not on this box is not in the menu** (ADR-0039). The
      // menu answers "what do you want to do with this", and one that cannot run is not an
      // available answer at any altitude. What it was protecting — that you cannot install
      // what you do not know exists — is `Identify`'s job, and `Identify` already names
      // every decoder it could not try and why (ADR-0031).
      //
      // One that *you* added is different and stays. You wrote that manifest and expected
      // it to run, so its absence is a mistake to be told about rather than a capability
      // you have not discovered, and silence is the wrong answer to a mistake.
      .filter((a) => a.available || a.local)
      .map((a) => ({ id: a.id, name: a.name, group: a.group, in: a.in, out: a.out,
                     external: true, opaque: true, blurb: a.blurb,
                     // Yours or ours (ADR-0026). A decoder you added misbehaving and one
                     // that shipped misbehaving are different problems, and the menu is
                     // where you find out which this is.
                     ...(a.local ? { local: a.local } : {}),
                     // Unclickable, and the badge says *why* rather than borrowing the one
                     // that means "we have not written this yet".
                     ...(a.available ? {} : { stub: true, soon: `needs ${a.command}`, needs: a.command }) }));
    // A loaded plugin is an operation like any other — same menu, same filter on
    // stream type, marked so you can see it came from outside (ADR-0013's opacity
    // rule, applied to a kind that is not opaque at all).
    const pl = plugins.forKind(n.out.kind)
      .map((p) => ({ id: p.id, name: p.name, group: p.group || 'Decode',
                     in: p.in, out: p.out, external: true }));
    return built.concat(ext, pl);
  }

  // ── nodes ────────────────────────────────────────────────────────────────
  /**
   * selection: { f0, f1 } in Hz absolute, and optionally { t0, t1 } in seconds.
   * Everything derivable is derived and marked `auto` (ADR-0017).
   */
  async addNode({ parent, op, selection, at = null, withNode = null }) {
    await this._sleep(LATENCY.structuralMs);
    const p = this.node(parent);
    // Everything below that estimates from the signal estimates at this moment.
    const now = at != null ? at : this.effectiveTime(parent);
    // Three places an operation can come from: built in, somebody else's program, or a
    // file dropped on the window.
    const spec = OPS[op] || (this.adapter && this.adapter(op)) || plugins.get(op);
    if (!spec) throw new Error(`no operation ${op}`);
    const node = {
      id: nid('n'), parent, op, label: '', params: {}, out: null, stub: !!spec.stub,
      // Only channels are lettered. A letter is a handle for "which signal am I
      // looking at" — spending them on the blocks inside one channel gave every
      // demodulator a name that meant nothing and made A · Tuner › C · AM demod read
      // as two peers. Blocks are known by what they do.
      letter: op === 'core.tuner' ? String.fromCharCode(65 + (this.letters++ % 26)) : null,
    };

    if (op === 'core.tuner') {
      // On IQ the selection is in RF and the mixer offset is the difference from the
      // parent's centre. On a demodulated stream the numbers are baseband offsets — 38 kHz
      // means 38 kHz from DC — so the centre *is* the offset, and the parent's `centerHz`
      // stays what ADR-0036 made it: where the samples came from, not the middle of this
      // picture.
      const centerHz = (selection.f0 + selection.f1) / 2;
      const widthHz = Math.abs(selection.f1 - selection.f0);
      const target = widthHz * 1.25;
      const decim = dsp.chooseDecimation(p.out.sampleRate, target);
      const rate = p.out.sampleRate / decim;
      // Measured, not assumed. This said `auto` and "transition width" for a year and
      // was the number 65 — which is plenty for a wide channel and nowhere near enough
      // for a narrow one. See dsp.chooseTaps.
      const filt = dsp.chooseTaps(p.out.sampleRate, widthHz, decim);
      const numTaps = filt.taps;
      const pinned = selection.t0 != null && selection.t1 != null;
      node.params = {
        centerHz: param(centerHz, 'auto', { from: 'selection center' }),
        widthHz: param(widthHz, 'auto', { from: 'selection width' }),
        decim: param(decim, 'auto', { from: `${(p.out.sampleRate / 1e3).toFixed(0)} kS/s ÷ ${(target / 1e3).toFixed(1)} kHz` }),
        taps: param(numTaps, 'auto', tapEvidence(filt, decim)),
        // time is a property of the channel, not a node of its own (ADR-0023)
        timeMode: param(pinned ? 'pinned' : 'live'),
        rate: param(1, 'auto', { from: 'window length — about four seconds to watch' }),
        t0: param(pinned ? selection.t0 : 0, 'auto', { from: 'selection start' }),
        t1: param(pinned ? selection.t1 : 0, 'auto', { from: 'selection end' }),
      };
      node.out = { kind: 'iq', sampleRate: rate, centerHz };
      node.label = 'Tuner';
    } else if (op === 'core.am_envelope') {
      node.out = { kind: 'real', sampleRate: p.out.sampleRate, centerHz: p.out.centerHz };
      node.label = 'AM demod';
    } else if (DETECTORS[op]) {
      // Every detector lands with its parameters already derived from the signal in
      // front of it, and says what it derived them from (ADR-0017). A detector that
      // arrives needing to be told the deviation is a detector for someone who
      // already knew the answer.
      const fs = p.out.sampleRate;
      // A quarter second, or as much as there is — whichever is less, and positioned so
      // the window actually lands on signal. Asking for 0.25 s ending at the playhead is
      // right on a long capture and wrong on a short one: on a 90 ms capture with the
      // playhead at 50 ms, four fifths of that window is before the beginning, and an
      // estimator handed mostly silence reports "looks unmodulated" and picks a
      // deviation off the noise.
      const { count, at } = this._peekWindow(fs, now);
      const iq = this._readIQ(p, at, count);
      node.params = DETECTORS[op].derive(iq, count, fs);
      node.out = { kind: 'real', sampleRate: fs, centerHz: p.out.centerHz };
      node.label = DETECTORS[op].label;
    } else if (op === 'core.raster') {
      node.params = {
        lineUs: param(0, 'auto', { from: 'not yet measured — the shortest period it repeats at' }),
        lines: param(0, 'auto', { from: 'not yet measured — how many lines before it repeats again' }),
        average: param(1, 'manual'),
        floorDb: param(-20, 'auto', { from: 'relative to the brightest pixel' }),
      };
      node.out = { kind: 'grid', sampleRate: p.out.sampleRate, centerHz: p.out.centerHz };
      node.label = 'Raster';
    } else if (op === 'core.ofdm') {
      // Nothing is assumed. The FFT size, the prefix and the symbol period are all
      // derived from the signal when the grid is built, and each says what told it so.
      node.params = {
        fftN: param(0, 'auto', { from: 'not yet measured — the lag the prefix correlates at' }),
        cpN: param(0, 'auto', { from: 'not yet measured — how wide that correlation is' }),
        symbolUs: param(0, 'auto', { from: 'not yet measured' }),
        floorDb: param(-12, 'auto', { from: 'relative to the strongest subcarrier' }),
      };
      node.out = { kind: 'grid', sampleRate: p.out.sampleRate, centerHz: p.out.centerHz };
      node.label = 'OFDM grid';
    } else if (op === 'core.hopmap' || op === 'core.dehop') {
      // Undecided on purpose, and for the same reason the slicers are: a hopper's dwells
      // are spread across a capture and the window a display happens to be showing is
      // almost never over a representative stretch of them. These are derived from the
      // whole span when the node is asked to produce something, not from a peek here.
      node.params = {
        bins: param(256, 'auto', { from: 'a compromise between time and frequency resolution' }),
        dwellMs: param(0, 'auto', { from: 'not yet measured — derived from the dwells found' }),
        spacingHz: param(0, 'auto', { from: 'not yet measured — derived from the channels found' }),
        channels: param(0, 'auto', { from: 'not yet measured' }),
      };
      if (op === 'core.dehop') {
        node.params.channel = param(-1, 'auto', { from: 'every channel, in the order they were used' });
        node._needsDehop = true;              // sliced below, once the node exists to hang it on
        // The de-hopped stream is one channel wide, so the rate that makes sense is the
        // channel spacing with room either side rather than whatever the source was.
        node.out = { kind: 'iq', sampleRate: p.out.sampleRate, centerHz: p.out.centerHz };
        node.label = 'De-hop';
      } else {
        node.out = { kind: 'events', sampleRate: p.out.sampleRate, centerHz: p.out.centerHz };
        node.label = 'Hop map';
      }
    } else if (op === 'core.gain') {
      // Derived, like everything else (ADR-0017): measure what is there and say what it
      // would take to bring it to a level a speaker or a matrix can use. So a gain of
      // +38 dB arrives explaining itself rather than sitting there as a number somebody
      // has to discover by turning it.
      const fs = p.out.sampleRate;
      const { count, at } = this._peekWindow(fs, now);
      const stride = p.out.kind === 'iq' ? 2 : 1;
      const rms = levelOf(stride === 2 ? this._readIQ(p, at, count) : this._detectMono(p, at, count),
                          count, stride);
      const want = rms > 1e-9 ? 20 * Math.log10(GAIN_TARGET / rms) : 0;
      node.params = {
        gainDb: param(Math.round(want * 10) / 10, 'auto', {
          from: `its level is ${rms.toExponential(1)} and this brings it to ${GAIN_TARGET}`,
          confident: rms > 1e-9,
        }),
      };
      node.out = {
        kind: p.out.kind, sampleRate: p.out.sampleRate, centerHz: p.out.centerHz,
        ...(p.out.channels > 1 ? { channels: p.out.channels } : {}),
      };
      node.label = 'Gain';
    } else if (op === 'core.real') {
      node.params = {};
      node.out = { kind: 'real', sampleRate: p.out.sampleRate, centerHz: p.out.centerHz };
      node.label = 'To real';
    } else if (op === 'core.symbols') {
      // Measured once, here, and then held. A sampling instant re-derived on every frame
      // would walk as the window slid, and a decoder downstream would see a different
      // symbol grid each time it was asked — so this reads a window now, keeps what it
      // found, and every frame afterwards is `softSymbolsAt` doing arithmetic.
      const fs = p.out.sampleRate;
      const rate = SYMBOL_RATE;
      // The block the playhead is in, measured on itself — not the end of the capture,
      // which is where this used to look and is nowhere near what anybody is looking at.
      //
      // Every other auto parameter here is a property of a carrier, which any quarter
      // second of it will tell you. A symbol grid is not: it is a measurement of a
      // stretch of signal, only good near that stretch, and the read path now takes each
      // block on its own grid. These three numbers are that block's, and they say so —
      // the span is part of the evidence because without it the number is unfalsifiable.
      const block = fitBlock(now);
      const fit = this._symbolGrid(node, block, p, rate);
      const phase = fit.phase;
      const where = `${fit.t0.toFixed(0)}–${fit.t1.toFixed(0)} s`;
      const evidence = { confident: fit.eye > 0.7 };
      node.params = {
        symbolRate: param(rate, 'manual'),
        // The eye is the evidence for all three, so it is what all three say. It is the
        // number that decides whether any of this worked — 1 is every symbol dead on a
        // level, 0.5 is a coin toss dressed as a decode — and a phase, a center and a
        // gain are one measurement reported as three, so quoting it three times is
        // honest rather than repetitive.
        phase: param(+phase.toFixed(3), 'auto', { ...evidence, from: fit.n
          ? `of ${fs / rate} instants in a symbol, this is where ${fit.n} of them fit the levels ` +
            `best over ${where} (eye ${fit.eye.toFixed(3)}); every other ${SYMBOL_FIT_SECONDS} s ` +
            'of the capture is measured on itself'
          : 'nothing to measure yet' }),
        // Where zero is and how far out ±3 is. A discriminator carries the tuning error
        // as the first and the capture's own units as the second, and neither of those
        // is knowable before looking.
        center: param(+fit.center.toPrecision(4), 'auto', { ...evidence, from: fit.n
          ? `the midpoint between the outer levels over ${where}, which sit ${fit.eye.toFixed(3)} of the way apart`
          : 'nothing to measure yet' }),
        gain: param(+fit.gain.toPrecision(4), 'auto', { ...evidence, from: fit.n
          ? `it puts the outer level at ±3 over ${where}, where the decoder expects it (eye ${fit.eye.toFixed(3)})`
          : 'nothing to measure yet' }),
        invert: param('no', 'manual'),
      };
      node.out = { kind: 'real', sampleRate: rate, centerHz: p.out.centerHz };
      node.label = 'Symbol sync';
    } else if (op === 'core.math') {
      // It arrives with one input and says so, the way the slicers arrive undecided:
      // choosing the other one is a question about the graph, and the graph is on screen
      // where a fresh node's parameters are not.
      const other = withNode && this.canFeed(withNode, node.id) ? this.node(withNode) : null;
      node.inputs = other ? [parent, other.id] : [parent];
      node.params = {
        withNode: param(other ? other.id : '', 'manual'),
        op: param('a-b', 'manual'),
      };
      node.out = {
        kind: p.out.kind,
        sampleRate: p.out.sampleRate,
        centerHz: p.out.centerHz,
        ...(p.out.channels > 1 ? { channels: p.out.channels } : {}),
      };
      node.label = 'Math';
    } else if (op === 'core.stereo') {
      // The pilot is the evidence, and it is the good kind: a bare tone at a frequency
      // the standard fixes, present when and only when the station is in stereo. So the
      // node arrives either saying it found one and how far above its guard band, or
      // saying it did not — in which case it will hand back the mono sum on both
      // channels rather than manufacture a difference out of noise (ADR-0031).
      const fs = p.out.sampleRate;
      const { count, at } = this._peekWindow(fs, now);
      const pilot = dsp.estimatePilot(this._detectMono(p, at, count), count, fs);
      node.params = {
        // The derived value is the answer to "is this in stereo", and the pilot is the
        // evidence for it (ADR-0017). Overriding it to `stereo` is for a pilot too weak
        // to measure rather than for one that is not there; overriding to `mono` is how
        // you listen past a decoder that is making a mess of a marginal signal.
        decode: param(pilot.confident ? 'stereo' : 'mono', 'auto', {
          from: pilot.confident
            ? `a ${(pilot.value / 1e3).toFixed(1)} kHz pilot, ${pilot.snrDb.toFixed(0)} dB over the ` +
              '15–23 kHz guard band where only a pilot belongs'
            : 'no pilot in the 15–23 kHz guard band — this station is in mono',
          confident: pilot.confident,
        }),
        // A preference, not a measurement: nothing in the signal says which continent it
        // came from, so marking it auto would claim evidence that does not exist. The
        // same honesty redsea's `region` knob applies to the same ambiguity.
        deemphasisUs: param(75, 'manual'),
      };
      node.out = { kind: 'real', sampleRate: fs, centerHz: p.out.centerHz, channels: 2 };
      node.label = 'Stereo decode';
    } else if (op === 'core.audio') {
      node.params = {
        volume: param(0.5),
        // off by default: a squelch that arrives closed looks exactly like a
        // broken decoder, and the difference takes a while to work out
        squelch: param(0),
      };
      node.out = { kind: 'audio', sampleRate: p.out.sampleRate, centerHz: p.out.centerHz };
      node.label = 'Listen';
    } else if (op === 'core.nrz_slicer') {
      // These arrive undecided on purpose. A 2 s peek at the playhead is the wrong
      // place to estimate from: a packet can sit anywhere in a capture, and the
      // window a display happens to be showing is almost never over it. They are
      // derived in `sliceBytes`, from exactly the samples that get sliced.
      const fs = p.out.sampleRate;
      node.params = {
        threshold: param(0.5, 'auto', { from: 'not yet measured — derived when the capture is sliced' }),
        symbolUs: param(100, 'auto', { from: 'not yet measured — derived when the capture is sliced' }),
        // A sync word is something you discover, not something a tool can derive:
        // there is no signal in the data that says "the bytes start here" until you
        // know what you are looking for.
        syncHex: param(''),
        bitOrder: param('msb'),
      };
      node.out = { kind: 'bytes', sampleRate: fs, centerHz: p.out.centerHz };
      node.label = 'NRZ';
    } else if (op === 'core.manchester') {
      // Same reasoning as the NRZ slicer: estimating from whatever window a display
      // happens to be showing is estimating from the wrong samples. Derived in
      // `sliceBytes`, over exactly the span that gets sliced.
      node.params = {
        threshold: param(0.5, 'auto', { from: 'not yet measured — derived when the capture is sliced' }),
        symbolUs: param(400, 'auto', { from: 'not yet measured — derived when the capture is sliced' }),
        // The two conventions are exact inverses, so nothing in the signal decides
        // between them. A sync word does, and until there is one this is a coin the
        // user flips — which is why it arrives manual rather than pretending.
        polarity: param('ieee'),
        syncHex: param(''),
        bitOrder: param('msb'),
      };
      node.out = { kind: 'bytes', sampleRate: p.out.sampleRate, centerHz: p.out.centerHz };
      node.label = 'Manchester';
    } else if (op === 'core.despread') {
      // Undecided, all of it. The chip rate, the code and the polarity are all derived
      // from the span when it is despread — which is the only place they can be derived
      // from, because a code search needs several code periods and a display window is
      // not sized for that.
      node.params = {
        chipRate: param(0, 'auto', { from: 'not yet measured \u2014 from the chip transitions' }),
        code: param('auto', 'auto', { from: 'not yet searched' }),
        // BPSK does not say which polarity is a one; nothing in the signal does. `auto`
        // is honest about the basis it picks on — printable text — and says so in the
        // evidence rather than quietly choosing.
        invert: param('auto', 'auto', { from: 'whichever reads as text' }),
        offsetHz: param(0, 'auto', { from: 'not yet measured \u2014 from the squared signal' }),
        syncHex: param(''),
        bitOrder: param('msb'),
      };
      node.out = { kind: 'bytes', sampleRate: p.out.sampleRate, centerHz: p.out.centerHz };
      node.label = 'Despread';
    } else if (op === 'core.differential') {
      node.params = {
        mode: param('nrz-m'),
        bitOrder: param('msb'),
      };
      node.out = { kind: 'bytes', sampleRate: p.out.sampleRate, centerHz: p.out.centerHz };
      node.label = 'Differential';
    } else if (op === 'core.framer') {
      node.params = {
        syncHex: param(''),
        frameBytes: param(0, 'auto', { from: 'to the next sync word' }),
        crc: param('auto', 'auto', { from: 'not yet measured — derived from the frames' }),
      };
      node.out = { kind: 'events', sampleRate: p.out.sampleRate, centerHz: p.out.centerHz };
      node.label = 'Frames';
    } else if (this.adapter && this.adapter(op)) {
      const a = this.adapter(op);
      node.params = {};
      // The knobs travel with the node rather than living in a table the client would
      // have to keep in step: an adapter's parameters are its own business, and the
      // strip should be able to draw one it has never heard of.
      node.paramMeta = {};
      for (const pm of a.params || []) {
        node.params[pm.id] = param(pm.default, 'manual');
        node.paramMeta[pm.id] = { label: pm.label || pm.id, type: pm.type || 'text',
                                  placeholder: pm.placeholder, hint: pm.hint, values: pm.values };
      }
      node.out = { kind: a.out, sampleRate: p.out.sampleRate, centerHz: p.out.centerHz };
      node.label = a.name;
      node.adapter = op;
      // Opaque on purpose: there is no drilling into somebody else's decoder, its
      // provenance is approximate, and the UI is required to look different because of
      // it. That is the price of 250 protocols for 60 lines (ADR-0013).
      node.opaque = true;
    } else if (plugins.get(op)) {
      const spec2 = plugins.get(op);
      node.params = {};
      for (const pm of spec2.params || []) {
        node.params[pm.id] = param(pm.default, pm.auto ? 'auto' : 'manual',
          pm.auto ? { from: 'the default this decoder ships with', confident: false } : null);
      }
      node.out = { kind: spec2.out, sampleRate: p.out.sampleRate, centerHz: p.out.centerHz };
      node.label = spec2.name;
      node.plugin = op;
    } else if (op === 'core.export') {
      node.params = {
        // whole-capture by default: the common case is "give me this channel", and a
        // window is what you ask for when you already know which part you want
        from: param(0),
        to: param(0),
        audioRate: param(22050),
      };
      node.out = { kind: 'file', sampleRate: p.out.sampleRate, centerHz: p.out.centerHz };
      node.label = 'Export';
    } else if (op === 'core.stream') {
      // Defaults that are GQRX's, because that is the convention the receiving end
      // already knows: 48 kHz signed 16-bit mono on a UDP port. `multimon-ng -` and
      // friends have been fed exactly this for years.
      const audio = p.out.kind === 'real' || p.out.kind === 'audio';
      node.params = {
        // Loopback, because a sink that defaults to shouting at the network is a
        // different kind of tool. In a container this has to be the host's address to
        // reach anything — see server/README.md, which says so rather than leaving it
        // to be discovered.
        host: param('127.0.0.1'),
        port: param(7355),
        format: param(audio ? 's16' : 'raw',
                      'manual', null),
        rate: param(audio ? 48_000 : Math.round(p.out.sampleRate)),
        running: param('no'),
      };
      node.out = { kind: 'sink', sampleRate: p.out.sampleRate, centerHz: p.out.centerHz };
      node.label = 'Stream out';
    } else if (op === 'core.pwm_slicer') {
      // estimate from a real window of the parent's output — auto shows its work
      // estimate over a window wide enough to be sure it contains a burst — the
      // train fires about once a second, so a shorter look can land on pure noise.
      // A pinned parent already narrowed it to the box the user drew.
      const pPin = this.isPinned(p.id);
      const pSpan = pPin ? Math.max(1e-3, pPin.params.t1.value - pPin.params.t0.value) : Infinity;
      const estSpan = Math.min(pSpan, 1.05);
      const env = await this._readReal(p, now, Math.min(131072, Math.floor(p.out.sampleRate * estSpan)));
      const otsu = dsp.otsuThreshold(env);
      const sym = dsp.estimateSymbolPeriod(env, otsu.value, p.out.sampleRate);
      node.params = {
        threshold: param(otsu.value, 'auto', { from: 'Otsu on the amplitude histogram', hist: otsu.hist }),
        symbolUs: param(Math.round(sym.value) || 417, 'auto', {
          from: sym.confident ? 'two clean pulse-length clusters' : 'pulse lengths (low confidence)',
          hist: sym.hist, confident: sym.confident,
        }),
      };
      node.out = { kind: 'bits', sampleRate: p.out.sampleRate, centerHz: p.out.centerHz };
      node.label = 'PWM';
    } else {
      node.out = { kind: spec.out, sampleRate: p.out.sampleRate, centerHz: p.out.centerHz };
      node.label = spec.name;
    }

    this.nodes.set(node.id, node);
    if (node._needsDehop) { delete node._needsDehop; await this._refreshDehop(node.id, now); }
    return node;
  }

  async removeNode(id) {
    await this._sleep(30);
    for (const c of this.children(id)) await this.removeNode(c.id);
    this.nodes.delete(id);
  }

  /** Hot params take the short path; structural ones cost a rebuild. */
  /**
   * De-hopping has to happen before anything downstream can read a sample, and reads are
   * synchronous. So it runs when the node is made and again whenever a parameter that
   * would change the answer moves — rather than lazily on first read, which would hand
   * the first frame silence and the second one the signal.
   */
  async _refreshDehop(nodeId, at) {
    const n = this.node(nodeId);
    if (!n || n.op !== 'core.dehop') return;
    const st = await this.sliceDehop(nodeId, at);
    const live = this.node(nodeId);
    if (!live || !st) return;
    // The stitched stream is shorter than the span it came from — that is the dead air
    // between dwells, removed — so the node's own duration is its own business.
    live._dehopSpanS = st.count / st.sampleRate;
  }

  async setParam(nodeId, key, value, mode = 'manual') {
    const n = this.node(nodeId);
    const cold = key === 'decim' || key === 'taps';
    await this._sleep(cold ? LATENCY.structuralMs : LATENCY.paramMs);
    n.params[key] = { ...n.params[key], value, mode };
    if (key === 't0' || key === 't1' || key === 'timeMode') n._t = null;
    // Choosing the second input is not a setting, it is an edge. It is set from the
    // parameter strip because that is where a node's own controls live, but what it
    // writes is the graph (ADR-0038) — a cycle is refused here rather than found later.
    if (n.op === 'core.math' && key === 'withNode') {
      const other = value && this.canFeed(value, n.id) ? this.node(value) : null;
      n.inputs = other ? [n.parent, other.id] : [n.parent];
      if (!other) n.params.withNode.value = '';
    }
    if (n.op === 'core.tuner') {
      n.out.sampleRate = this.node(n.parent).out.sampleRate / n.params.decim.value;
      n.out.centerHz = n.params.centerHz.value;
      for (const c of this.children(n.id)) {
        c.out.sampleRate = n.out.sampleRate;
        c.out.centerHz = n.out.centerHz;
      }
    }
    // De-hopping is done ahead of any read, so a parameter that changes which dwells get
    // stitched has to redo it before the next frame asks for samples.
    if (n.op === 'core.dehop' && (key === 'bins' || key === 'channel')) await this._refreshDehop(n.id, null);
    return { node: n, rebuilt: cold };
  }

  async setMode(nodeId, key, mode) {
    const n = this.node(nodeId);
    await this._sleep(LATENCY.paramMs);
    n.params[key] = { ...n.params[key], mode };
    return n;
  }

  /**
   * What to call this node, when what it does is not what it is.
   *
   * A name sits *beside* the operation rather than replacing it. `label` stays what the
   * node does — the palette put it there and it is how the flow view, the export
   * filename and every error message refer to the node — and `name` is what the person
   * building the graph calls it. Six tuners across a band are six things called "Tuner",
   * and the letter answers which one but not what it is; "fan remote" answers what it is.
   *
   * The letter is untouched on purpose. It is the handle the channel markers, the
   * torn-off tiles and the export filenames all use, so a rename that took it away would
   * quietly rename things nobody was looking at.
   *
   * Capped and squeezed, because this lands in the most horizontally constrained row in
   * the layout and a name long enough to push a sibling off the strip has cost more than
   * it bought (`docs/08-ui-principles.md`). Empty clears it and the node goes back to
   * being called what it does.
   */
  async renameNode(nodeId, name) {
    const n = this.node(nodeId);
    if (!n) return null;
    await this._sleep(LATENCY.paramMs);
    const clean = cleanName(name);
    if (clean) n.name = clean; else delete n.name;
    return n;
  }

  // ── sample production ────────────────────────────────────────────────────
  /**
   * IQ samples out of `node`, `count` of them, ending at time `tEnd`.
   *
   * Ending at `tEnd` is the contract, and it has to hold even when the window reaches
   * back before the start of the medium — a tuner asks for its filter's worth of extra
   * samples ahead of every read, so the very first read of any capture reaches back
   * past zero. Clamping the start to zero instead of padding the front silently returns
   * a window that *ends* late by however much was clamped, and then only the first
   * chunk of a long read is shifted while every later one is not. The seam that makes
   * duplicates the filter's length in samples, which is under a millisecond and is
   * enough to lose a packet that happens to straddle it: at 96 kS/s the boundary falls
   * every 0.68 s, and a fixture with two APRS frames in it decoded exactly the one that
   * did not sit on top of one.
   */
  _readIQ(node, tEnd, count) {
    if (node.op === 'core.source') {
      const start = Math.floor(tEnd * node.out.sampleRate) - count;
      const read = (a, n) => (this.capture ? this.capture.read(a, n) : scene.read(a, n));
      if (start >= 0) return read(start, count);
      // before the beginning is silence, which is what past the end already is
      const have = count + start;
      const out = new Float32Array(count * 2);
      if (have > 0) out.set(read(0, have).subarray(0, have * 2), -start * 2);
      return out;
    }
    const p = this.node(node.parent);

    if (node.op === 'core.tuner') {
      const decim = node.params.decim.value;
      const taps = dsp.lowPassTaps(node.params.taps.value, node.params.widthHz.value / 2, p.out.sampleRate);
      const need = count * decim + taps.length;
      // A real parent is handed to the same mixer with an empty imaginary part. Mixing a
      // real signal by a complex phasor and low-passing keeps the positive-frequency
      // content around the offset and throws the negative-frequency image away with the
      // rest — which is the analytic signal, arrived at without a Hilbert transformer.
      // Half the amplitude, because a real cosine is two phasors and only one survives.
      const onReal = p.out.kind === 'real';
      const offset = onReal ? node.params.centerHz.value
                            : node.params.centerHz.value - p.out.centerHz;

      // **Which input samples become output samples is a property of the capture, not of
      // the read.** `xlateFilterDecimate` takes every `decim`-th sample counting from the
      // start of what it is handed, so the answer used to depend on where that started —
      // and that was `Math.floor(tEnd * parentRate) - need`, whose remainder modulo
      // `decim` moves with `tEnd`. Two reads ending at different moments therefore landed
      // on different input samples, which is a sub-sample time shift in the output.
      //
      // It hid for a long time because it is harmless until something cares about a
      // fraction of a sample. Measured on the GRCon26 M17 slot: a 9 kHz selection
      // decimates by 42, so the shift reaches 41/42 of an output sample — 0.39 of a
      // symbol at 2.48 samples per symbol, and the symbols came back a fifth of full
      // scale away from the ones a direct fit produced (mean |difference| 0.56 on
      // symbols that run ±3; 10 records against 0). The same signal at a 24 kHz
      // selection decimates by 16 into 6.5 samples a symbol, where the worst case is
      // 0.14 of a symbol: there the two paths agreed to the bit.
      //
      // So the output grid is anchored to the capture: absolute output sample `k` is
      // always made from the input samples starting at `k * decim`, whatever window
      // happens to be asking.
      // The one term that was `Math.floor(tEnd * parentRate)` and is now `endOut * decim`.
      // Everything else about the window — including the tuner being late by half its
      // filter, which `delay.js` accounts for and a test pins — is unchanged, because
      // the two differ by less than one output sample and only in the part that was
      // making the grid depend on the read.
      const endOut = Math.floor(tEnd * node.out.sampleRate);
      const startAt = endOut * decim - need;
      // Positioned by sample index rather than by a moment: the half-sample keeps the
      // division and its floor from landing one sample early, which is the rounding
      // `_readMerged` documents at length.
      const tRead = (endOut * decim + 0.5) / p.out.sampleRate;
      const src = onReal ? interleave(this._detectMono(p, tRead, need), need)
                         : this._readIQ(p, tRead, need);

      // The mixer's phase is referenced to the **first sample of the window**, not to its
      // end — which is a different number for every window length, because `need` depends
      // on how many samples were asked for.
      //
      // Referenced to `tEnd` it was: the same tuner, asked for the same moment, handed
      // back a different phase depending on the count. Forty-eight extra samples on a
      // 19 kHz offset moved it seventy-two degrees. Nothing noticed for as long as
      // everything downstream looked at magnitudes — a spectrum, a waterfall, an
      // envelope — and it makes a tuner unusable for anything coherent, which is to say
      // for everything ADR-0038 exists for.
      const startPhase = (-2 * Math.PI * offset * (startAt / p.out.sampleRate)) % (2 * Math.PI);
      return dsp.xlateFilterDecimate(src, taps, offset, p.out.sampleRate, decim, count, startPhase).samples;
    }

    if (node.op === 'core.math') return this._readMerged(node, tEnd, count).data;
    if (node.op === 'core.gain') return scaled(this._readIQ(p, tEnd, count), node.params.gainDb.value);

    if (node.op === 'core.dehop') {
      // Same length and same time base as its parent, because it corrects rather than
      // rearranges — so this is an ordinary window read like every other node's.
      const st = node._dehopped;
      const out = new Float32Array(count * 2);
      if (!st || !st.count) return out;                 // not sliced yet, or nothing found
      const end = Math.floor(tEnd * node.out.sampleRate);
      for (let k = 0; k < count; k++) {
        const idx = end - count + k;
        if (idx < 0 || idx >= st.count) continue;
        out[k * 2] = st.data[idx * 2];
        out[k * 2 + 1] = st.data[idx * 2 + 1];
      }
      return out;
    }

    return this._readIQ(p, tEnd, count);
  }

  /**
   * Follow the hops and stitch the dwells into one continuous channel.
   *
   * Mix each dwell down by where it actually was, keep only the part of it that was
   * transmitting, and lay them end to end. What comes out is the payload as it would have
   * been if nobody had been hopping — which the ordinary demodulator and slicer chain
   * reads without knowing anything happened. That is the point: the hop sequence and the
   * bits are one capability, not two.
   *
   * The dwell edges are taken from where the energy was, not from a schedule, so the
   * settling time at each end of a hop is dropped rather than stitched in as a click.
   */
  /**
   * The resource grid, built once over the whole span and cached against its parameters.
   *
   * A job rather than a frame: an OFDM symbol is a few hundred microseconds and the
   * interesting pattern is hundreds of them, so what a display window happens to hold is
   * never the answer.
   */
  async sliceGrid(nodeId, at = null) {
    const n = this.node(nodeId);
    if (!n || n.out.kind !== 'grid') return null;
    if (n.op === 'core.raster') return this._sliceRaster(n, at);
    const p = this.node(n.parent);
    // Keyed on the *question*, not the answer.
    //
    // The obvious key is the parameters, and it is wrong here: this operation writes the
    // derived FFT size back into `fftN`, so a key that included the value changed the
    // moment the work was done and the cache never hit once. What actually varies is
    // whether somebody has pinned a size, and to what.
    const pinned = n.params.fftN.mode === 'manual' && n.params.fftN.value >= 8;
    const key = pinned ? `pinned:${Math.round(n.params.fftN.value)}` : 'auto';
    if (n._grid && n._grid.key === key) return n._grid;

    const span = await this._spanOf(p, at);
    if (!span) return null;
    const fs = span.sampleRate;
    const est = pinned
      ? { ...dsp.estimateOfdm(span.data, span.count, fs, { sizes: [Math.round(n.params.fftN.value)] }) }
      : dsp.estimateOfdm(span.data, span.count, fs);

    if (!est || !est.fftN) {
      n._grid = { key, rows: 0, cols: 0, data: new Float32Array(0), error: est?.reason || 'no OFDM structure here' };
      return n._grid;
    }
    n.params.fftN = { ...n.params.fftN, value: est.fftN,
      auto: { from: `the prefix correlates at a lag of ${est.fftN} samples ` +
                    `(${est.peak.toFixed(2)} against ${est.mean.toFixed(2)} elsewhere)`,
              confident: est.confident } };
    n.params.cpN = { ...n.params.cpN, value: est.cpN,
      auto: { from: `the correlation stays coherent for ${est.cpN} samples, ` +
                    `which is a ${(est.cpN / est.fftN * 100).toFixed(0)}% prefix`,
              confident: est.confident } };
    n.params.symbolUs = { ...n.params.symbolUs, value: +(est.symbolS * 1e6).toFixed(2),
      auto: { from: `${est.fftN} + ${est.cpN} samples at ${(fs / 1e3).toFixed(0)} kS/s`,
              confident: est.confident } };

    const g = dsp.ofdmGrid(span.data, span.count, est);
    n._grid = { key, ...g, est, sampleRate: fs, centerHz: p.out.centerHz,
                t0: span.t0, spacingHz: est.spacingHz, symbolS: est.symbolS,
                confident: est.confident };
    return n._grid;
  }

  /**
   * A screen, folded back out of the signal that leaked it.
   *
   * Two periods and a fold. The line period is the shortest thing the signal repeats at;
   * the frame is a whole number of those; and averaging the frames is free signal-to-noise
   * on a still picture, which a leak almost always is.
   */
  async _sliceRaster(n, at) {
    const p = this.node(n.parent);
    const pinnedLine = n.params.lineUs.mode === 'manual' && n.params.lineUs.value > 0;
    const key = [pinnedLine ? `line:${n.params.lineUs.value}` : 'auto',
                 n.params.average.value].join('|');
    if (n._grid && n._grid.key === key) return n._grid;

    const span = await this._spanOf(p, at);
    if (!span) return null;
    const fs = span.sampleRate;
    // The envelope, at full bandwidth. Nothing is filtered on the way in — the whole
    // point of taking IQ here is to avoid a post-detection filter sized for audio.
    const video = span.kind === 'iq' ? dsp.amEnvelope(span.data, span.count) : span.data;
    const est = dsp.estimateRaster(video, span.count, fs);
    const lineSamples = pinnedLine ? (n.params.lineUs.value * 1e-6) * fs : est.lineSamples;

    if (!lineSamples || lineSamples < 4) {
      n._grid = { key, rows: 0, cols: 0, data: new Float32Array(0),
                  error: est.reason || 'nothing here repeats often enough to be a raster' };
      return n._grid;
    }

    n.params.lineUs = { ...n.params.lineUs, value: +((lineSamples / fs) * 1e6).toFixed(3),
      auto: { from: `it repeats every ${lineSamples.toFixed(1)} samples ` +
                    `(${est.peak?.toFixed(2)} against ${est.background?.toFixed(2)} elsewhere)`,
              confident: !!est.confident } };
    n.params.lines = { ...n.params.lines, value: est.linesPerFrame || 0,
      auto: { from: est.frameConfident
        ? `the whole frame repeats every ${est.linesPerFrame} lines (${est.frameScore.toFixed(2)})`
        : 'no frame repeat stood out — this may be moving, or only one frame long',
        confident: !!est.frameConfident } };

    const cols = Math.max(2, Math.round(lineSamples));
    const lines = est.linesPerFrame;
    const wantAvg = n.params.average.value && est.frameConfident && lines > 2;
    const haveFrames = wantAvg ? Math.floor(span.count / (lineSamples * lines)) : 0;

    // Fold the frames on top of each other, when there are frames and averaging is on.
    //
    // Every frame in the capture, not the few a row cap allowed: what is held is one
    // frame however many go into it, and each is lined up against the ones before it, for
    // the reason `stackFrames` gives.
    let out, frames = 1, walked = 0;
    if (haveFrames >= 2) {
      const st = dsp.stackFrames(video, span.count, lineSamples, lines, { cols });
      ({ frames, walked } = st);
      out = { rows: st.rows, cols: st.cols, data: st.data };
    } else {
      // Nothing to average into: stack the lines and let somebody look at them. The cap
      // is memory, not meaning — a grid is drawn, and nobody reads four thousand lines.
      out = dsp.foldRaster(video, span.count, lineSamples, { cols, maxRows: 4096 });
    }

    n._grid = { key, ...out, sampleRate: fs, centerHz: p.out.centerHz, t0: span.t0,
                symbolS: lineSamples / fs, spacingHz: 0, frames, walked,
                confident: !!est.confident, kindLabel: 'raster' };
    return n._grid;
  }

  async sliceDehop(nodeId, at = null) {
    const n = this.node(nodeId);
    if (!n || n.op !== 'core.dehop') return null;
    const p = this.node(n.parent);
    const key = [n.params.bins.value, n.params.channel.value].join('|');
    if (n._dehopped && n._dehopped.key === key) return n._dehopped;

    const span = await this._spanOf(p, at);
    if (!span) return null;
    const bins = Math.max(32, Math.round(n.params.bins.value) || 256);
    const found = dsp.findHops(span.data, span.count, span.sampleRate, { bins, step: bins >> 1 });
    if (!found.hops.length) {
      n._dehopped = { key, data: new Float32Array(0), count: 0, hops: 0,
                      reason: found.reason || 'no dwells found' };
      return n._dehopped;
    }

    // It corrects; it does not rearrange.
    //
    // The first version of this stitched the dwells together with the dead time cut out,
    // which is the obvious thing to do and is wrong twice over. It makes a stream whose
    // time axis is not the capture's — and worse, a dwell edge is only known to within
    // one analysis step, which at any useful resolution is a symbol or two. Cutting there
    // loses a fraction of a symbol at every hop, so the symbol clock walks and the slicer
    // downstream reads a payload that decodes to nothing. It looked entirely plausible
    // until a preamble of 0xAA came back as 0x78e1c78e.
    //
    // Correcting each sample by the frequency in effect at that moment leaves every
    // sample where it was, so the symbol clock survives and the ordinary demodulator and
    // slicer read the payload without knowing anything happened. Dead air between dwells
    // stays dead air, which is the truth about the signal rather than a seam hidden in it.
    const fs = span.sampleRate;
    const only = Math.round(n.params.channel.value);
    const offset = new Float32Array(span.count);
    const live = new Uint8Array(span.count);
    for (const h of found.hops) {
      if (only >= 0 && h.channel !== only) continue;
      const a = Math.max(0, Math.round(h.t0 * fs));
      const b = Math.min(span.count, Math.round(h.t1 * fs));
      for (let i = a; i < b; i++) { offset[i] = h.hz; live[i] = 1; }
    }

    const data = new Float32Array(span.count * 2);
    let ph = 0, kept = 0;
    for (let i = 0; i < span.count; i++) {
      if (!live[i]) { ph = 0; continue; }
      const re = span.data[i * 2], im = span.data[i * 2 + 1];
      const c = Math.cos(ph), sn = Math.sin(ph);
      data[i * 2] = re * c - im * sn;
      data[i * 2 + 1] = re * sn + im * c;
      ph += (-2 * Math.PI * offset[i]) / fs;
      if (ph < -Math.PI * 2) ph += Math.PI * 2;
      kept++;
    }
    n._dehopped = {
      key, data, count: span.count, sampleRate: fs,
      hops: found.hops.filter((h) => only < 0 || h.channel === only).length,
      channels: found.channels.length, dwellS: found.dwellS,
      keptS: kept / fs, spanS: span.t1 - span.t0,
    };
    return n._dehopped;
  }

  async _readReal(node, tEnd, count) {
    return this._detectMono(node, tEnd, count);
  }

  /**
   * Audio out of a detector node: `count` samples *starting* at `t0`.
   *
   * Every other read in this engine ends at a moment, because a display shows what
   * just happened. Audio is the one consumer that runs forward — it needs the next
   * chunk, contiguous with the last one — and asking for a backward window and
   * reversing the reasoning at the call site is how gaps and overlaps get in.
   */
  async readAudio(nodeId, t0, count) {
    const n = this.node(nodeId);
    if (!n || n.out.kind !== 'real') return null;
    const fs = n.out.sampleRate;
    // Interleaved, with the count, because the speaker is the one consumer that wants
    // both channels rather than their sum (ADR-0037).
    return {
      data: this._detect(n, t0 + count / fs, count),
      sampleRate: fs,
      channels: n.out.channels || 1,
    };
  }

  /**
   * Two inputs, lined up, combined — `count` samples ending at `tEnd`.
   *
   * The alignment is the whole job. Both inputs are asked for the same window, and both
   * hand back samples that are a little older than the moment asked for — by *different*
   * amounts, because they came through different filters (ADR-0038). So the second one is
   * read with margin either side and shifted onto the first before anything is combined.
   *
   * The shift is fractional and stays fractional. Half a sample at 160 kS/s is forty
   * degrees at 38 kHz, and the operation this exists for is a conjugate product, where
   * forty degrees is most of the answer.
   */
  _readMerged(node, tEnd, count) {
    const ids = inputsOf(node);
    const a = this.node(ids[0]);
    const b = ids[1] ? this.node(ids[1]) : null;
    const iq = node.out.kind === 'iq';
    const stride = iq ? 2 : 1;
    const read = (n, end, many) => (iq ? this._readIQ(n, end, many) : this._detectMono(n, end, many));

    const A = read(a, tEnd, count);
    // Nothing chosen, or nothing it can be lined up against: hand the first input through
    // rather than inventing an answer. `note` is what the strip shows instead of a value.
    if (!b) return { data: A, note: 'choose a second input' };
    if (a.out.sampleRate !== b.out.sampleRate) {
      return { data: A, note: `${fmtKS(a.out.sampleRate)} against ${fmtKS(b.out.sampleRate)} — ` +
                             'a merge does not resample, so set both tuners to the same decimation' };
    }
    const align = alignment(a, b, (id) => this.node(id));
    if (!align.ok) return { data: A, note: align.why };

    // Room for the shift plus the interpolator's own support, so neither runs off an end.
    const pad = Math.ceil(Math.abs(align.shiftSamples)) + 24;
    // **Both inputs are read to the same `tEnd`**, and the margin comes from asking for
    // more samples rather than from moving the end. That is not tidiness. A read is
    // positioned by `Math.floor(tEnd * sampleRate)`, and asking for `tEnd + pad / rate`
    // instead floors to 120095 where the arithmetic says 120096 — one input sample, which
    // at a decimation of four is a quarter of an output sample of jitter. Which is to say
    // the read positioning was introducing exactly the error this whole node exists to
    // correct, at a size the correction cannot see.
    //
    // A window of `count + 2 * pad` samples ending at `tEnd` puts the sample for the same
    // moment as `A[k]` at index `2 * pad + k`, and both windows floor the same number.
    const raw = read(b, tEnd, count + 2 * pad);
    const shifted = dsp.shiftBy(raw, align.shiftSamples, { stride });

    const out = new Float32Array(count * stride);
    const how = node.params.op.value;
    for (let k = 0; k < count; k++) {
      const i = k * stride, j = (2 * pad + k) * stride;
      if (!iq) {
        const x = A[i], y = shifted[j];
        out[i] = how === 'a+b' ? x + y : how === 'a-b' ? x - y
               : how === 'a/b' ? (Math.abs(y) > 1e-10 ? x / y : 0) : x * y;
        continue;
      }
      const ar = A[i], ai = A[i + 1], br = shifted[j], bi = shifted[j + 1];
      if (how === 'a+b') { out[i] = ar + br; out[i + 1] = ai + bi; }
      else if (how === 'a-b') { out[i] = ar - br; out[i + 1] = ai - bi; }
      else if (how === 'a*b') { out[i] = ar * br - ai * bi; out[i + 1] = ar * bi + ai * br; }
      else if (how === 'a*conj(b)') { out[i] = ar * br + ai * bi; out[i + 1] = ai * br - ar * bi; }
      else {
        // a ÷ b, which is the conjugate product with the reference's own power divided
        // back out — `divide_cc`. That difference is the whole of what separates a phase
        // comparison that survives a fading signal from one that fades with it: the
        // product's amplitude rides on `b` and the quotient's does not.
        const m = br * br + bi * bi;
        const k = m > 1e-20 ? 1 / m : 0;
        out[i] = (ar * br + ai * bi) * k;
        out[i + 1] = (ai * br - ar * bi) * k;
      }
    }
    return { data: out, shiftSamples: align.shiftSamples };
  }

  /**
   * The real-valued output of a detector node, `count` samples ending at `tEnd`.
   *
   * Interleaved when there is more than one channel, the way `iq` interleaves its two
   * components (ADR-0037) — so the array is `count * channels` long and every caller
   * either knows that or asks for `_detectMono` instead.
   *
   * `node` is usually a detector and its parent supplies the IQ. A node whose parent is
   * already a real stream — a stereo decoder is the first — reads that recursively
   * instead, which is what makes a chain of real-to-real operations possible at all.
   */
  _detect(node, tEnd, count) {
    const p = this.node(node.parent);
    const fs = node.out.sampleRate;
    if (node.op === 'core.math') return this._readMerged(node, tEnd, count).data;
    if (node.op === 'core.real') return dsp.realPart(this._readIQ(p, tEnd, count), count);
    if (node.op === 'core.gain') return scaled(this._detect(p, tEnd, count), node.params.gainDb.value);
    if (node.op === 'core.symbols') return this._readSymbols(node, tEnd, count);
    if (p.out.kind === 'real') {
      return realOp(node.op, this._detectMono(p, tEnd, count), count, fs, node.params).data;
    }
    const iq = this._readIQ(p, tEnd, count);
    return demodulate(node.op, iq, count, fs, node.params).data;
  }

  /**
   * The grid for one block of capture time, measured on that block and then remembered.
   *
   * A block rather than a read, because two reads that overlap have to agree about which
   * sample was a symbol or the decoder downstream sees a different grid every frame —
   * that is what ADR-0040 is protecting, and it is a property of the *block*, not of one
   * fit held forever. The blocks are anchored at zero, so every read agrees on the edges
   * however it was positioned.
   */
  _symbolGrid(node, block, parent = null, atRate = 0) {
    if (!node._grids) node._grids = new Map();
    const hit = node._grids.get(block);
    if (hit) return hit;

    // The parent by argument when there is one: this is also called from `addNode`,
    // where the node being measured is not in the graph yet and cannot look its own
    // parent up.
    const p = parent || this.node(node.parent);
    const fsIn = p.out.sampleRate;
    // `node.out` is written after the parameters are, so on the way in from `addNode`
    // there is nothing to read the rate off yet and it arrives as an argument instead.
    const rate = atRate || node.out.sampleRate;
    const sps = fsIn / rate;
    const d = this.duration();
    const t0 = block * SYMBOL_FIT_SECONDS;
    const t1 = isFinite(d) ? Math.min(d, t0 + SYMBOL_FIT_SECONDS) : t0 + SYMBOL_FIT_SECONDS;
    const n = Math.max(256, Math.round(Math.max(0, t1 - t0) * fsIn));
    const fit = dsp.softSymbols(this._detectMono(p, t1, n), n, fsIn, rate);
    // Absolute, not window-relative. `fit.offset` is an index into the block that was
    // measured, and that block does not start on a symbol boundary — so the phase a read
    // can use is the one taken against the capture's own sample zero.
    const windowStart = Math.floor(t1 * fsIn) - n;
    const g = {
      phase: fit.n ? (((windowStart + fit.offset) % sps) + sps) % sps : 0,
      center: fit.center, gain: fit.gain, eye: fit.eye, n: fit.n, t0, t1,
    };
    node._grids.set(block, g);
    return g;
  }

  /**
   * `count` soft symbols ending at `tEnd`, each one on the grid measured where it is.
   *
   * The one real-to-real operation whose output rate is not its input's, which is what
   * makes it the only one that cannot read `count` samples from its parent and be done.
   * A symbol at 4800 is ten samples at 48k, and the ten it is are decided by an absolute
   * index rather than by where this window happens to start.
   *
   * Which grid, though, is a question the old version answered once for a whole capture,
   * and wrongly: a phase measured on ten seconds is a measurement *of those ten seconds*.
   * So the read is cut at the block boundaries it crosses and each part is taken on its
   * own block's grid. A read inside one block — every display read is — is one pass and
   * the same pass as before.
   *
   * A phase somebody typed is not a measurement and is not second-guessed: `manual` wins
   * everywhere, which is also what makes `invert` usable as the escape hatch the note
   * tells people to try.
   */
  _readSymbols(node, tEnd, count) {
    const p = this.node(node.parent);
    const fsIn = p.out.sampleRate;
    const rate = node.out.sampleRate;
    const sps = fsIn / rate;
    const pr = node.params;
    const held = pr.phase.mode === 'manual'
      ? { phase: pr.phase.value, center: pr.center.value, gain: pr.gain.value } : null;

    const endSym = Math.floor(tEnd * rate);
    const firstSym = endSym - count;
    const out = new Float32Array(Math.max(0, count));
    // Half the filter plus a sample of slack for the interpolator.
    const pad = Math.ceil((SYMBOL_SPAN / 2) * sps) + 2;

    for (let k = firstSym; k < endSym;) {
      const g = held || this._symbolGrid(node, fitBlock(k / rate));
      // To the end of this block, or the end of what was asked for.
      const stop = held ? endSym
        : Math.min(endSym, Math.ceil((fitBlock(k / rate) + 1) * SYMBOL_FIT_SECONDS * rate));
      const nsym = Math.max(1, stop - k);
      const a = Math.floor(k * sps + g.phase) - pad;
      const b = Math.ceil((k + nsym - 1) * sps + g.phase) + pad + 1;
      const need = Math.max(1, b - a);
      // The parent read ends at absolute sample `b`, which is what puts `a` at index 0.
      const x = this._detectMono(p, b / fsIn, need);
      const part = dsp.softSymbolsAt(x, need, fsIn, rate, {
        phase: k * sps + g.phase - a,
        first: 0, symbols: nsym,
        center: g.center, gain: g.gain,
        invert: pr.invert.value === 'yes',
        span: SYMBOL_SPAN,
      });
      out.set(part.subarray(0, Math.min(nsym, count - (k - firstSym))), k - firstSym);
      k += nsym;
    }
    return out;
  }

  /**
   * One named channel of it, for a view.
   *
   * A pane cannot plot two channels against one y axis without saying which is which,
   * and it must not pick one silently — so the choice is a view parameter and this is
   * where it lands, alongside `domain` (ADR-0036). `sum` is the default because on a
   * one-channel stream it is the only answer, and on two it is the mono signal.
   */
  _detectChannel(node, tEnd, count, which) {
    const ch = node.out.channels || 1;
    if (ch === 1 || !which || which === 'sum') return this._detectMono(node, tEnd, count);
    const data = this._detect(node, tEnd, count);
    const c = Math.min(which === 'right' ? 1 : 0, ch - 1);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = data[i * ch + c];
    return out;
  }

  /**
   * The same thing as one channel: the mono sum where there is more than one.
   *
   * This is what every consumer that is not the speaker or a view wants — a slicer, an
   * external decoder, an export. It is also correct rather than merely convenient: in FM
   * stereo the sum *is* the mono signal, because the encoding was built so a mono
   * receiver could ignore the subcarrier and be right (ADR-0037).
   */
  _detectMono(node, tEnd, count) {
    const data = this._detect(node, tEnd, count);
    const ch = node.out.channels || 1;
    if (ch === 1) return data;
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      let s = 0;
      for (let c = 0; c < ch; c++) s += data[i * ch + c];
      out[i] = s / ch;
    }
    return out;
  }

  /**
   * A display frame. `bins`, `window` and `avg` change what is computed, so they
   * are engine-side; dB range, colormap and scroll speed only change how it is
   * painted, so they stay in the client (ADR-0012).
   */
  frame(nodeId, opts) {
    const n = this.node(nodeId);
    if (n.stub) return { kind: 'stub' };
    const now = opts.at != null ? opts.at : this.effectiveTime(nodeId);
    // A pinned channel means these samples and no others, so every window that
    // looks backwards is clamped to it — otherwise a view would quietly read
    // outside the box the user drew.
    const pin = this.isPinned(nodeId);
    const maxSpan = pin && opts.at == null
      ? Math.max(1e-3, pin.params.t1.value - pin.params.t0.value)
      : Infinity;

    if (n.out.kind === 'iq') {
      const bins = opts.bins || 1024;
      const iq = this._readIQ(n, now, bins);
      return { kind: 'spectrum', data: dsp.spectrum(iq, bins, opts.window || 'Hann'), sampleRate: n.out.sampleRate, centerHz: n.out.centerHz };
    }

    if (n.out.kind === 'real') {
      const fs = n.out.sampleRate;

      // The same samples, read on the other axis. A detector's output is a signal in
      // its own right — an FM discriminator's is the whole composite, with the audio
      // at the bottom, a pilot at 19 kHz, L-R on 38 kHz and RDS at 57 kHz — and none
      // of that is visible in a waveform. Which axis is a view parameter rather than
      // a second node: nothing about the graph changes, only what is plotted.
      //
      // One-sided, so the span is 0 to fs/2 and the frequencies are baseband offsets
      // rather than RF. `centerHz` says where they came from and is carried through
      // for provenance (ADR-0007), not as the middle of this picture.
      if (opts.domain === 'frequency') {
        const bins = opts.bins || 1024;
        const x = this._detectChannel(n, now, bins * 2, opts.channel);
        return {
          kind: 'spectrum', baseband: true,
          data: dsp.realSpectrum(x, bins, opts.window || 'Hann'),
          sampleRate: fs, centerHz: n.out.centerHz,
        };
      }

      const span = opts.spanS || 0.12;
      // The search window and the display window are different things. The trigger
      // has to look over a whole burst period to find an edge at all, but what it
      // shows afterwards is the span the user asked for — tying the two together
      // meant the span control moved nothing whenever the trigger was armed.
      const searchS = Math.min(maxSpan, opts.trigger === 'free' ? span : Math.max(1.05, span));
      const count = Math.min(131072, Math.max(256, Math.floor(fs * searchS)));
      const env = this._detectChannel(n, now, count, opts.channel);
      const windowEnd = now;                        // absolute time of the last sample

      if (opts.trigger === 'free') {
        return { kind: 'timeseries', data: env, sampleRate: fs,
                 spanS: count / fs, t0: windowEnd - count / fs, triggered: false };
      }

      const win = Math.max(64, Math.min(env.length, Math.round(fs * span)));
      const b = dsp.findLastBurst(env, fs);
      // nothing to latch onto: show the most recent `span`, not the whole search
      const pre = b ? Math.round(win * 0.12) : 0;  // a little room before the edge
      const e = b ? Math.min(env.length, Math.max(win, b.start - pre + win)) : env.length;
      const s = Math.max(0, e - win);
      return {
        kind: 'timeseries', data: env.subarray(s, e), sampleRate: fs,
        spanS: (e - s) / fs, t0: windowEnd - (count - s) / fs, triggered: !!b,
      };
    }

    if (n.out.kind === 'bytes') {
      return { kind: 'bytes', sliced: n._sliced || null };
    }

    if (n.out.kind === 'events') {
      return { kind: 'events', run: n._records || null };
    }

    if (n.out.kind === 'bits') {
      const p = this.node(n.parent);           // the envelope feeding the slicer
      // a couple of burst periods, so there is always a complete one to show; the
      // app recomputes this a few times a second rather than every frame
      const fs = p.out.sampleRate;
      const span = Math.min(maxSpan, opts.spanS || 2.0);
      const count = Math.min(262144, Math.floor(fs * span));
      const env = this._detectMono(p, now, count);   // whatever detector feeds this slicer
      const groups = dsp.pwmSlice(env, n.params.threshold.value, fs, n.params.symbolUs.value);
      const windowStart = now - count / fs;
      return {
        kind: 'bits', env, sampleRate: fs,
        symbolUs: n.params.symbolUs.value,
        groups: groups.map((g) => ({
          bits: g.bits,
          t: windowStart + g.start / fs,
          durationS: (g.end - g.start) / fs,
        })),
      };
    }
    return { kind: 'none' };
  }
}
