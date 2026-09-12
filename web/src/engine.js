// The engine contract, and the mock that implements it in the browser.
//
// ADR-0021: the client has no privileged path into the engine, so "the engine" can
// be this file. Every method is async and deliberately spends the latency budget —
// a mock that answers in microseconds would let us tune the UI against a backend
// that cannot exist.

import * as dsp from './dsp.js';
import * as scene from './scene.js';
import * as plugins from './plugins.js';
import { plan as identifyPlan } from './identify.js';
import { Graph } from './graph.js';
import * as frames from './frames.js';

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

// ── operation catalog ────────────────────────────────────────────────────
// `in`/`out` are semantic stream kinds (ADR-0006); the palette filters on them.
export const OPS = {
  'core.tuner': {
    name: 'Tune here', group: 'Narrow', in: 'iq', out: 'iq',
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

// Below this many characters across all of a decoder's records, a speculative pass does
// not call it a decode. Three: enough to rule out a single symbol found in noise, few
// enough to keep a short but real answer — eight DTMF digits are eight characters.
const MIN_DECODE_CHARS = 3;

const textLength = (records) =>
  records.reduce((n, r) => n + String(r.text ?? '').trim().length, 0);

/** Solid first, thin next, silent last; then by how much, then by name. */
function rank(a, b) {
  const tier = (r) => (r.records > 0 && !r.thin ? 0 : r.records > 0 ? 1 : 2);
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
      const got = iq ? this._readIQ(n, at, want) : this._detect(n, at, want);
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
      return { tried: [], skipped: [], results: [],
               error: 'external decoders run on the engine; this tab has no engine on a box to run them' };
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
    const audioRate = Math.max(...tried.filter((c) => c.via).map((c) => c.wants.rate), 0);
    const narrow = audioRate ? decimateFor(got, fs, audioRate) : null;

    // Demodulate once per way of demodulating, not once per decoder behind one.
    const audio = new Map();
    const feed = (via) => {
      if (!via) return { data: got.data, kind: got.kind, rate: fs };
      if (!audio.has(via)) audio.set(via, demodulate(via, narrow.data, narrow.count, narrow.rate).data);
      return { data: audio.get(via), kind: 'real', rate: narrow.rate };
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
      .map(([id, o]) => ({ id, ...o }));
    // Somebody else's decoders, if this build has a table of them. Marked external and
    // opaque: you cannot see inside one, and the UI says so rather than implying you
    // could have (ADR-0013).
    const ext = (this.adapters || [])
      .filter((a) => accepts(a.in, n.out.kind))
      .map((a) => ({ id: a.id, name: a.name, group: a.group, in: a.in, out: a.out,
                     external: true, opaque: true, blurb: a.blurb,
                     // Yours or ours (ADR-0026). A decoder you added misbehaving and one
                     // that shipped misbehaving are different problems, and the menu is
                     // where you find out which this is.
                     ...(a.local ? { local: a.local } : {}),
                     stub: !a.available, needs: a.command }));
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
  async addNode({ parent, op, selection, at = null }) {
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
      const centerHz = (selection.f0 + selection.f1) / 2;
      const widthHz = Math.abs(selection.f1 - selection.f0);
      const target = widthHz * 1.25;
      const decim = dsp.chooseDecimation(p.out.sampleRate, target);
      const rate = p.out.sampleRate / decim;
      const numTaps = 65;
      const pinned = selection.t0 != null && selection.t1 != null;
      node.params = {
        centerHz: param(centerHz, 'auto', { from: 'selection center' }),
        widthHz: param(widthHz, 'auto', { from: 'selection width' }),
        decim: param(decim, 'auto', { from: `${(p.out.sampleRate / 1e3).toFixed(0)} kS/s ÷ ${(target / 1e3).toFixed(1)} kHz` }),
        taps: param(numTaps, 'auto', { from: 'transition width' }),
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
      const src = this._readIQ(p, tEnd, need);
      const offset = node.params.centerHz.value - p.out.centerHz;
      const startPhase = (-2 * Math.PI * offset * Math.max(0, tEnd)) % (2 * Math.PI);
      return dsp.xlateFilterDecimate(src, taps, offset, p.out.sampleRate, decim, count, startPhase).samples;
    }

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
    return this._detect(node, tEnd, count);
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
    return { data: this._detect(n, t0 + count / fs, count), sampleRate: fs };
  }

  /**
   * The real-valued output of a detector node, `count` samples ending at `tEnd`.
   * `node` is the detector; its parent supplies the IQ.
   */
  _detect(node, tEnd, count) {
    const p = this.node(node.parent);
    const fs = node.out.sampleRate;
    const iq = this._readIQ(p, tEnd, count);
    return demodulate(node.op, iq, count, fs, node.params).data;
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
      const span = opts.spanS || 0.12;
      // The search window and the display window are different things. The trigger
      // has to look over a whole burst period to find an edge at all, but what it
      // shows afterwards is the span the user asked for — tying the two together
      // meant the span control moved nothing whenever the trigger was armed.
      const searchS = Math.min(maxSpan, opts.trigger === 'free' ? span : Math.max(1.05, span));
      const count = Math.min(131072, Math.max(256, Math.floor(fs * searchS)));
      const env = this._detect(n, now, count);
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
      const env = this._detect(p, now, count);   // whatever detector feeds this slicer
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
