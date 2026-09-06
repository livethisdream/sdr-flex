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

// ── operation catalogue ────────────────────────────────────────────────────
// `in`/`out` are semantic stream kinds (ADR-0006); the palette filters on them.
export const OPS = {
  'core.tuner': {
    name: 'Tune here', group: 'Narrow', in: 'iq', out: 'iq', letter: 'A',
    fromSelection: true,
  },
  // A time window is a property of a channel, not a node of its own
  // (ADR-0023) — and the time-drag gesture it needs does not exist until
  // scrubbing does, so nothing here offers one yet.
  'core.am_envelope': {
    name: 'AM envelope', group: 'Demodulate', in: 'iq', out: 'real', letter: 'C',
  },
  'core.pwm_slicer': {
    name: 'PWM / OOK slicer', group: 'Decode', in: 'real', out: 'bits', letter: 'D',
  },
  'ext.rtl433': {
    name: 'rtl_433', group: 'Decode', in: 'iq', out: 'events', letter: 'E',
    external: true, stub: true,
  },
  'core.burst_detector': {
    name: 'Burst detector', group: 'Analyse', in: 'iq', out: 'events', letter: 'B',
    stub: true,
  },
};

function param(value, mode = 'manual', auto = null) {
  return { value, mode, auto };
}

export class MockEngine {
  constructor() {
    this.nodes = new Map();
    this.root = null;
    this.letters = 0;      // nodes are named in creation order, not by op
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
    return root;
  }

  node(id) { return this.nodes.get(id); }

  /**
   * A pinned window is a clip, not a still frame — it has duration, so it plays.
   * Short bursts play slowed down, because an 80 ms window at 1× would loop a
   * dozen times a second and read as a strobe rather than a signal.
   */
  clipRate(n) {
    const d = Math.max(1e-4, n.params.t1.value - n.params.t0.value);
    return Math.min(1, d / 4);           // a window takes about 4 s to watch
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
      letter: String.fromCharCode(65 + (this.letters++ % 26)),
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
        centerHz: param(centerHz, 'auto', { from: 'selection centre' }),
        widthHz: param(widthHz, 'auto', { from: 'selection width' }),
        decim: param(decim, 'auto', { from: `${(p.out.sampleRate / 1e3).toFixed(0)} kS/s ÷ ${(target / 1e3).toFixed(1)} kHz` }),
        taps: param(numTaps, 'auto', { from: 'transition width' }),
        // time is a property of the channel, not a node of its own (ADR-0023)
        timeMode: param(pinned ? 'pinned' : 'live'),
        t0: param(pinned ? selection.t0 : 0, 'auto', { from: 'selection start' }),
        t1: param(pinned ? selection.t1 : 0, 'auto', { from: 'selection end' }),
      };
      node.out = { kind: 'iq', sampleRate: rate, centerHz };
      node.label = 'Tuner';
    } else if (op === 'core.am_envelope') {
      node.out = { kind: 'real', sampleRate: p.out.sampleRate, centerHz: p.out.centerHz };
      node.label = 'AM env';
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
      return scene.read(start, count);
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
    const iq = this._readIQ(node, tEnd, count);
    return dsp.smooth(dsp.amEnvelope(iq, count), dsp.envelopeWindow(node.out.sampleRate));
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
      const p = this.node(n.parent);
      // look over a whole burst period so the trigger has something to find
      const searchS = Math.min(maxSpan, opts.trigger === 'free' ? (opts.spanS || 0.12) : 1.05);
      const count = Math.min(131072, Math.max(256, Math.floor(fs * searchS)));
      const iq = this._readIQ(p, now, count);
      const env = dsp.smooth(dsp.amEnvelope(iq, count), dsp.envelopeWindow(fs));
      const windowEnd = now;                        // absolute time of the last sample

      if (opts.trigger === 'free') {
        return { kind: 'timeseries', data: env, sampleRate: fs,
                 spanS: count / fs, t0: windowEnd - count / fs, triggered: false };
      }

      const b = dsp.findLastBurst(env, fs);
      if (!b) return { kind: 'timeseries', data: env, sampleRate: fs,
                       spanS: count / fs, t0: windowEnd - count / fs, triggered: false };

      const pad = Math.round(fs * 0.004);
      const s = Math.max(0, b.start - pad);
      const e = Math.min(env.length, b.end + pad);
      return {
        kind: 'timeseries', data: env.subarray(s, e), sampleRate: fs,
        spanS: (e - s) / fs, t0: windowEnd - (count - s) / fs, triggered: true,
      };
    }

    if (n.out.kind === 'bits') {
      const p = this.node(n.parent);           // the envelope feeding the slicer
      // a couple of burst periods, so there is always a complete one to show; the
      // app recomputes this a few times a second rather than every frame
      const fs = p.out.sampleRate;
      const span = Math.min(maxSpan, opts.spanS || 2.0);
      const count = Math.min(262144, Math.floor(fs * span));
      const gp = this.node(p.parent);
      const env = dsp.smooth(dsp.amEnvelope(this._readIQ(gp, now, count), count), dsp.envelopeWindow(fs));
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
