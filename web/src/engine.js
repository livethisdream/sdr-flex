// The engine contract, and the mock that implements it in the browser.
//
// ADR-0021: the client has no privileged path into the engine, so "the engine" can
// be this file. Every method is async and deliberately spends the latency budget —
// a mock that answers in microseconds would let us tune the UI against a backend
// that cannot exist.

import * as dsp from './dsp.js';
import * as scene from './scene.js';

export const LATENCY = {
  paramMs: 40,        // hot parameter → visible effect
  structuralMs: 260,  // cold parameter or new node → first frame
  frameHz: 30,
  jitterMs: 3,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms + (Math.random() - 0.5) * 2 * LATENCY.jitterMs));

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
  // A sink is a node. A view renders what a node produced; a sink consumes it and
  // the data leaves the graph there, which is exactly what a terminal block is
  // (ADR-0027). Nothing takes `audio` as input, so nothing can follow it.
  'core.audio': {
    name: 'Listen', group: 'Listen', in: 'real', out: 'audio',
  },
  'ext.rtl433': {
    name: 'rtl_433', group: 'Decode', in: 'iq', out: 'events',
    external: true, stub: true,
  },
  'core.burst_detector': {
    name: 'Burst detector', group: 'Analyze', in: 'iq', out: 'events',
    stub: true,
  },
};

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

function param(value, mode = 'manual', auto = null) {
  return { value, mode, auto };
}

export class MockEngine {
  constructor() {
    this.nodes = new Map();
    this.root = null;
    this.letters = 0;      // channels are named in creation order, not by op
    this.t = 0;            // playhead, seconds since scene start
    this.playing = true;
    this._last = performance.now();
  }

  // ── session ──────────────────────────────────────────────────────────────
  async createSession() {
    await sleep(120);
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
    this.capture = null;          // null means the synthetic scene
    this.ended = false;
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
    await sleep(LATENCY.structuralMs);
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

  /** How much signal there is, in seconds — a file ends, the scene does not. */
  duration() { return this.capture ? this.capture.durationS : Infinity; }

  node(id) { return this.nodes.get(id); }

  /**
   * A pinned window is a clip, not a still frame — it has duration, so it plays.
   * Short bursts play slowed down, because an 80 ms window at 1× would loop a
   * dozen times a second and read as a strobe rather than a signal.
   */
  /** Derived so a window takes about four seconds to watch — overridable like anything else. */
  autoClipRate(n) {
    const d = Math.max(1e-4, n.params.t1.value - n.params.t0.value);
    return Math.min(1, d / 4);
  }

  clipRate(n) {
    const p = n.params.rate;
    if (p && p.mode === 'manual') return p.value;
    const v = this.autoClipRate(n);
    if (p) p.value = v;                  // keep the readout honest while auto
    return v;
  }

  clipPos(n) {
    if (n._t == null) n._t = n.params.t0.value;
    return n._t;
  }

  /**
   * The moment a node is looking at: a pinned ancestor's clip position if there is
   * one, otherwise the session playhead.
   */
  effectiveTime(id) {
    let n = this.node(id);
    while (n) {
      const m = n.params && n.params.timeMode;
      if (m && m.value === 'pinned') return this.clipPos(n);
      n = n.parent ? this.node(n.parent) : null;
    }
    return this.t;
  }

  isPinned(id) {
    let n = this.node(id);
    while (n) {
      const m = n.params && n.params.timeMode;
      if (m && m.value === 'pinned') return n;
      n = n.parent ? this.node(n.parent) : null;
    }
    return null;
  }

  path(id) {
    const out = [];
    let n = this.node(id);
    while (n) { out.unshift(n); n = n.parent ? this.node(n.parent) : null; }
    return out;
  }

  children(id) {
    return [...this.nodes.values()].filter((n) => n.parent === id);
  }

  // ── palette: only operations valid on this node's output type ────────────
  async palette(nodeId) {
    await sleep(8);
    const n = this.node(nodeId);
    return Object.entries(OPS)
      .filter(([, o]) => o.in === n.out.kind)
      .map(([id, o]) => ({ id, ...o }));
  }

  // ── nodes ────────────────────────────────────────────────────────────────
  /**
   * selection: { f0, f1 } in Hz absolute, and optionally { t0, t1 } in seconds.
   * Everything derivable is derived and marked `auto` (ADR-0017).
   */
  async addNode({ parent, op, selection }) {
    await sleep(LATENCY.structuralMs);
    const p = this.node(parent);
    const spec = OPS[op];
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
      const iq = this._readIQ(p, this.effectiveTime(p.id), Math.min(65536, Math.floor(fs * 0.25)));
      const count = iq.length / 2;
      node.params = DETECTORS[op].derive(iq, count, fs);
      node.out = { kind: 'real', sampleRate: fs, centerHz: p.out.centerHz };
      node.label = DETECTORS[op].label;
    } else if (op === 'core.audio') {
      node.params = {
        volume: param(0.5),
        // off by default: a squelch that arrives closed looks exactly like a
        // broken decoder, and the difference takes a while to work out
        squelch: param(0),
      };
      node.out = { kind: 'audio', sampleRate: p.out.sampleRate, centerHz: p.out.centerHz };
      node.label = 'Listen';
    } else if (op === 'core.pwm_slicer') {
      // estimate from a real window of the parent's output — auto shows its work
      // estimate over a window wide enough to be sure it contains a burst — the
      // train fires about once a second, so a shorter look can land on pure noise.
      // A pinned parent already narrowed it to the box the user drew.
      const pPin = this.isPinned(p.id);
      const pSpan = pPin ? Math.max(1e-3, pPin.params.t1.value - pPin.params.t0.value) : Infinity;
      const estSpan = Math.min(pSpan, 1.05);
      const env = await this._readReal(p, this.effectiveTime(p.id), Math.min(131072, Math.floor(p.out.sampleRate * estSpan)));
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
    return node;
  }

  async removeNode(id) {
    await sleep(30);
    for (const c of this.children(id)) await this.removeNode(c.id);
    this.nodes.delete(id);
  }

  /** Hot params take the short path; structural ones cost a rebuild. */
  async setParam(nodeId, key, value, mode = 'manual') {
    const n = this.node(nodeId);
    const cold = key === 'decim' || key === 'taps';
    await sleep(cold ? LATENCY.structuralMs : LATENCY.paramMs);
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
    return { node: n, rebuilt: cold };
  }

  async setMode(nodeId, key, mode) {
    const n = this.node(nodeId);
    await sleep(LATENCY.paramMs);
    n.params[key] = { ...n.params[key], mode };
    return n;
  }

  // ── transport ────────────────────────────────────────────────────────────
  tick() {
    const now = performance.now();
    const dt = (now - this._last) / 1000;
    this._last = now;
    const step = Math.min(dt, 0.1);
    if (this.playing) {
      this.t += step;
      // A file ends. Running the clock past it would scroll silence forever and look
      // exactly like a stall, so playback stops at the end and says so.
      const d = this.duration();
      if (this.t >= d) { this.t = d; this.playing = false; this.ended = true; }
      for (const n of this.nodes.values()) {
        const m = n.params && n.params.timeMode;
        if (!m || m.value !== 'pinned') continue;
        const t0 = n.params.t0.value, t1 = n.params.t1.value;
        const d = Math.max(1e-4, t1 - t0);
        if (n._t == null || n._t < t0 || n._t > t1) n._t = t0;
        n._t += step * this.clipRate(n);
        if (n._t > t1) n._t = t0 + ((n._t - t0) % d);   // loop
      }
    }
    return this.t;
  }

  // ── sample production ────────────────────────────────────────────────────
  /** IQ samples out of `node`, `count` of them, ending at time `tEnd`. */
  _readIQ(node, tEnd, count) {
    if (node.op === 'core.source') {
      const start = Math.max(0, Math.floor(tEnd * node.out.sampleRate) - count);
      return this.capture ? this.capture.read(start, count) : scene.read(start, count);
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

    return this._readIQ(p, tEnd, count);
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
    const d = DETECTORS[node.op];
    if (d) return d.detect(iq, count, fs, node.params);
    // AM: the rectifier, then the post-detection low-pass every real receiver has
    return dsp.smooth(dsp.amEnvelope(iq, count), dsp.envelopeWindow(fs));
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
