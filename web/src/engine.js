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
  'core.gate': {
    name: 'Gate to selection', group: 'Narrow', in: 'iq', out: 'iq', letter: 'G',
    fromSelection: true, needsTime: true,
  },
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
    const node = { id: nid('n'), parent, op, label: '', params: {}, out: null, stub: !!spec.stub };

    if (op === 'core.tuner') {
      const centerHz = (selection.f0 + selection.f1) / 2;
      const widthHz = Math.abs(selection.f1 - selection.f0);
      const target = widthHz * 1.25;
      const decim = dsp.chooseDecimation(p.out.sampleRate, target);
      const rate = p.out.sampleRate / decim;
      const numTaps = 65;
      node.params = {
        centerHz: param(centerHz, 'auto', { from: 'selection centre' }),
        widthHz: param(widthHz, 'auto', { from: 'selection width' }),
        decim: param(decim, 'auto', { from: `${(p.out.sampleRate / 1e3).toFixed(0)} kS/s ÷ ${(target / 1e3).toFixed(1)} kHz` }),
        taps: param(numTaps, 'auto', { from: 'transition width' }),
      };
      node.out = { kind: 'iq', sampleRate: rate, centerHz };
      node.label = 'Tuner';
    } else if (op === 'core.gate') {
      node.params = {
        t0: param(selection.t0, 'auto', { from: 'selection start' }),
        t1: param(selection.t1, 'auto', { from: 'selection end' }),
      };
      node.out = { ...p.out };
      node.label = 'Gate';
    } else if (op === 'core.am_envelope') {
      node.out = { kind: 'real', sampleRate: p.out.sampleRate, centerHz: p.out.centerHz };
      node.label = 'AM env';
    } else if (op === 'core.pwm_slicer') {
      // estimate from a real window of the parent's output — auto shows its work
      // estimate over a window wide enough to be sure it contains a burst — the
      // train fires about once a second, so a shorter look can land on pure noise
      const estSpan = 1.05;
      const env = await this._readReal(p, this.t, Math.min(131072, Math.floor(p.out.sampleRate * estSpan)));
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
    if (this.playing) this.t += Math.min(dt, 0.1);
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

    if (node.op === 'core.gate') {
      const t0 = node.params.t0.value, t1 = node.params.t1.value;
      const clamped = Math.max(t0, Math.min(tEnd, t1));
      return this._readIQ(p, clamped, count);
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

    if (n.out.kind === 'iq') {
      const bins = opts.bins || 1024;
      const iq = this._readIQ(n, this.t, bins);
      return { kind: 'spectrum', data: dsp.spectrum(iq, bins, opts.window || 'Hann'), sampleRate: n.out.sampleRate, centerHz: n.out.centerHz };
    }

    if (n.out.kind === 'real') {
      const span = opts.spanS || 0.12;
      const count = Math.min(48000, Math.max(256, Math.floor(n.out.sampleRate * span)));
      const p = this.node(n.parent);
      const iq = this._readIQ(p, this.t, count);
      const env = dsp.smooth(dsp.amEnvelope(iq, count), dsp.envelopeWindow(n.out.sampleRate));
      return { kind: 'timeseries', data: env, sampleRate: n.out.sampleRate, spanS: count / n.out.sampleRate };
    }

    if (n.out.kind === 'bits') {
      const p = this.node(n.parent);           // the envelope feeding the slicer
      // a full second, so a whole burst is always inside the window; the app
      // recomputes this a few times a second rather than every frame
      const span = opts.spanS || 1.0;
      const count = Math.min(131072, Math.floor(p.out.sampleRate * span));
      const gp = this.node(p.parent);
      const env = dsp.smooth(dsp.amEnvelope(this._readIQ(gp, this.t, count), count), dsp.envelopeWindow(p.out.sampleRate));
      const bits = dsp.pwmSlice(env, n.params.threshold.value, p.out.sampleRate, n.params.symbolUs.value);
      return { kind: 'bits', bits, env, sampleRate: p.out.sampleRate };
    }
    return { kind: 'none' };
  }
}
