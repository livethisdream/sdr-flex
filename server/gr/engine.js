// The engine with GNU Radio doing the signal processing (ADR-0044).
//
// It is the JS engine with the sample-producing operations replaced one at a time, so the
// graph, the protocol and every method the client calls stay exactly as they were
// (ADR-0029). What has moved so far:
//
//   - a tuner on a recorded capture: GNU Radio's freq_xlating_fir_filter_ccf, computed by the
//     session's worker in 0.25 s blocks on the same grid the JS tuner uses, and agreeing with
//     it sample for sample (web/test/grtuner.test.mjs);
//   - an FM demod on such a tuner: quadrature_demod_cf, in the same flowgraph as its tuner, so
//     the tuner's samples never cross the pipe only to be demodulated (web/test/grfm.test.mjs).
//
// The engine's reads are synchronous and the worker answers over a pipe, so the two meet in a
// cache: the session calls `prepare` before anything that reads samples, which fetches the
// blocks the read will need, and the synchronous read then assembles from them. A read that
// finds a block missing is answered by the JS engine, which gives the same samples more
// slowly, and is counted — a miss is a prepare that asked for the wrong span, and the count is
// how that shows up in a measurement rather than in a wrong answer.
import { MockEngine } from '../../web/src/engine.js';
import * as dsp from '../../web/src/dsp.js';

const BLOCK_S = 0.25;
// Around the moment a read ends: the scope's trigger looks back about a second, and the
// detector cache (`_detectCached`) asks for whole blocks plus a margin either side.
const PREPARE_BEFORE_S = 1.4;
const PREPARE_AFTER_S = 0.35;
// How far past the playhead the worker keeps fetching while nothing is asking. At 37x real
// time it stays ahead with room to spare.
const AHEAD_S = 1.0;
const MAX_BLOCKS = 64;
const FORMATS = new Set(['cf32', 'cs16', 'cu8']);

export class GrEngine extends MockEngine {
  constructor(opts, worker) {
    super(opts);
    this.gr = worker;
    this.grStats = { blocks: 0, ms: 0, misses: 0, hits: 0, waits: 0, outside: 0 };
    this._watched = new Set();
    this._pumping = false;
  }

  /** Can GNU Radio compute this node? A tuner straight off a recorded file, for now. */
  _grTuner(node) {
    if (!node || node.op !== 'core.tuner') return false;
    const p = this.node(node.parent);
    const c = this.capture;
    return !!(p && p.op === 'core.source' && c && !c.live && c.path && FORMATS.has(c.format));
  }

  _tunerSpec(node) {
    const p = this.node(node.parent);
    const decim = node.params.decim.value;
    const taps = dsp.lowPassTaps(node.params.taps.value, node.params.widthHz.value / 2, p.out.sampleRate);
    const offset = node.params.centerHz.value - p.out.centerHz;
    const sig = `${this.capture.path}|${p.out.sampleRate}|${decim}|${taps.length}|${node.params.widthHz.value}|${offset}`;
    return { op: 'tuner', complex: true, decim, taps, offset, sig, fsIn: p.out.sampleRate };
  }

  /** Which of the operations GNU Radio computes this node is, or null. */
  _grKind(node) {
    if (this._grTuner(node)) return 'tuner';
    if (node && node.op === 'core.fm_discriminator' && this._grTuner(this.node(node.parent))) return 'fm';
    return null;
  }

  _grSpec(node) {
    const kind = this._grKind(node);
    if (kind === 'tuner') return this._tunerSpec(node);
    if (kind === 'fm') {
      const t = this._tunerSpec(this.node(node.parent));
      // The JS discriminator's scale: full deviation is full scale (DETECTORS, engine.js).
      const scale = (node.params.gain.value || 1) / Math.max(1, node.params.deviationHz.value);
      return { ...t, op: 'fm', complex: false, scale, sig: `${t.sig}|fm|${scale}` };
    }
    return null;
  }

  _blocksOf(node, sig) {
    if (!node._grBlocks || node._grSig !== sig) { node._grBlocks = new Map(); node._grSig = sig; }
    return node._grBlocks;
  }

  /**
   * The node whose GNU Radio blocks a read of this one will actually use: the first one up the
   * chain that GNU Radio computes. A stereo decoder reads its FM demod, and the FM demod's
   * blocks already contain the tuner, so the tuner's own blocks are not fetched for it.
   */
  _grNodesOf(nodeId) {
    for (let n = this.node(nodeId); n; n = n.parent != null ? this.node(n.parent) : null) {
      if (this._grKind(n)) return [n];
    }
    return [];
  }

  _blockSize(node) { return Math.max(256, Math.round(BLOCK_S * node.out.sampleRate)); }

  /** One block, fetched once: a second ask while the first is in flight shares it. */
  _ensure(node, j) {
    const spec = this._grSpec(node);
    const blocks = this._blocksOf(node, spec.sig);
    if (blocks.has(j)) return Promise.resolve();
    if (!node._grInflight || node._grInflightSig !== spec.sig) { node._grInflight = new Map(); node._grInflightSig = spec.sig; }
    if (node._grInflight.has(j)) return node._grInflight.get(j);
    const B = this._blockSize(node);
    const started = performance.now();
    const p = this.gr.request({
      op: spec.op, path: this.capture.path, format: this.capture.format, rate: spec.fsIn,
      k0: j * B, count: B, taps: Array.from(spec.taps), decim: spec.decim, offset: spec.offset,
      ...(spec.scale != null ? { scale: spec.scale } : {}),
    }).then(({ bytes }) => {
      blocks.set(j, new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)));
      this.grStats.blocks++;
      this.grStats.ms += performance.now() - started;
    }, () => {
      // Off the end of the file, or the worker refused it: this block stays the JS engine's,
      // and is not asked for again.
      blocks.set(j, null);
    }).finally(() => {
      node._grInflight.delete(j);
      if (blocks.size > MAX_BLOCKS) blocks.delete(blocks.keys().next().value);
    });
    node._grInflight.set(j, p);
    return p;
  }

  _range(node, t0, t1) {
    const fs = node.out.sampleRate, B = this._blockSize(node);
    const a = Math.floor((Math.max(0, t0) * fs) / B), b = Math.ceil((Math.min(this.duration(), t1) * fs) / B);
    const out = [];
    for (let j = a; j < b; j++) out.push(j);
    return out;
  }

  /**
   * Make sure the blocks a read ending at `at` will touch are here, and keep fetching ahead.
   *
   * The wait is only for what is missing right now, which during playback is nothing: the
   * pump below has already fetched past the playhead. It is a jump — a seek, a new channel —
   * that waits, once, for the blocks around where it landed. Fetching on the critical path
   * made playback outrun its own blocks and fall back to the JS engine on every other read.
   */
  async prepare(nodeId, at, spanS = 0) {
    if (!this.gr) return;
    const tuners = this._grNodesOf(nodeId);
    for (const n of tuners) n._grAt = at;
    const waits = [];
    for (const n of tuners) {
      const spec = this._grSpec(n);
      const blocks = this._blocksOf(n, spec.sig);
      for (const j of this._range(n, at - spanS - PREPARE_BEFORE_S, at + PREPARE_AFTER_S)) {
        if (!blocks.has(j)) waits.push(this._ensure(n, j));
      }
    }
    if (waits.length) { this.grStats.waits++; await Promise.all(waits); }
    this._pump(tuners);
  }

  /** Keep fetching, nearest the playhead first, until everything up to AHEAD_S past it is here. */
  async _pump(tuners) {
    for (const n of tuners) this._watched.add(n.id);
    if (this._pumping) return;
    this._pumping = true;
    try {
      for (;;) {
        let next = null;
        for (const id of this._watched) {
          const n = this.node(id);
          if (!n || !this._grKind(n) || n._grAt == null) { this._watched.delete(id); continue; }
          const blocks = this._blocksOf(n, this._grSpec(n).sig);
          const j = this._range(n, n._grAt, n._grAt + AHEAD_S).find((k) => !blocks.has(k));
          if (j != null) { next = [n, j]; break; }
        }
        if (!next) return;
        await this._ensure(next[0], next[1]);
      }
    } finally {
      this._pumping = false;
    }
  }

  /**
   * A whole span, read the way the JS engine reads it, with each chunk prepared just before it
   * is read. A decoder reads all ninety seconds of a capture; fetching every block up front
   * would evict the first ones from the cache before they were read.
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
      const at = t0 + (done + want) / fs;
      await this.prepare(nodeId, at, want / fs);
      const got = iq ? this._readIQ(n, at, want) : this._detectMono(n, at, want);
      out.set(got.subarray(0, iq ? want * 2 : want), iq ? done * 2 : done);
      if (onProgress) onProgress(Math.min(1, (done + want) / total));
    }
    return { data: out, sampleRate: fs, kind: n.out.kind, count: total };
  }

  _readIQ(node, tEnd, count) {
    if (this._grTuner(node)) {
      const spec = this._tunerSpec(node);
      const blocks = this._blocksOf(node, spec.sig);
      const fs = node.out.sampleRate, B = Math.max(256, Math.round(BLOCK_S * fs));
      const kEnd = Math.floor(tEnd * fs), kStart = kEnd - count;
      // Before the capture starts or after it ends there is nothing to fetch: the JS engine's
      // answer there is silence, and it is not a miss.
      if (kStart < 0 || tEnd > this.duration()) { this.grStats.outside++; return super._readIQ(node, tEnd, count); }
      const out = new Float32Array(count * 2);
      let whole = true;
      for (let j = Math.floor(kStart / B); j * B < kEnd; j++) {
        const blk = blocks.get(j);
        if (!blk) { whole = false; break; }
        const a = Math.max(kStart, j * B), b = Math.min(kEnd, (j + 1) * B);
        out.set(blk.subarray((a - j * B) * 2, (b - j * B) * 2), (a - kStart) * 2);
      }
      if (whole) { this.grStats.hits++; return out; }
      this.grStats.misses++;
      if (process.env.SDRFLEX_GR_DEBUG && this.grStats.misses <= 25) {
        const need = [];
        for (let j = Math.floor(kStart / B); j * B < kEnd; j++) if (!blocks.get(j)) need.push(j);
        console.error(`gr miss: tEnd ${tEnd.toFixed(3)} span ${(count / fs).toFixed(3)} s, missing blocks ${need.join(',')}` +
          ` (block = ${(B / fs).toFixed(2)} s), playhead ${node._grAt == null ? '-' : node._grAt.toFixed(3)}, stack ${new Error().stack.split('\n').slice(2, 6).map((l) => l.trim().replace(/^at /, '').replace(/\(.*\/(\w+\.js):(\d+):\d+\)/, '$1:$2')).join(' < ')}`);
      }
    }
    return super._readIQ(node, tEnd, count);
  }

  _detectRaw(node, tEnd, count) {
    if (this._grKind(node) === 'fm') {
      const out = this._fromBlocks(node, tEnd, count, 1);
      if (out) return out;
    }
    return super._detectRaw(node, tEnd, count);
  }

  /** `count` samples ending at `tEnd` from a node's GNU Radio blocks, or null if any is missing. */
  _fromBlocks(node, tEnd, count, width) {
    const blocks = this._blocksOf(node, this._grSpec(node).sig);
    const fs = node.out.sampleRate, B = this._blockSize(node);
    const kEnd = Math.floor(tEnd * fs), kStart = kEnd - count;
    if (kStart < 0 || tEnd > this.duration()) { this.grStats.outside++; return null; }
    const out = new Float32Array(count * width);
    for (let j = Math.floor(kStart / B); j * B < kEnd; j++) {
      const blk = blocks.get(j);
      if (!blk) { this.grStats.misses++; return null; }
      const a = Math.max(kStart, j * B), b = Math.min(kEnd, (j + 1) * B);
      out.set(blk.subarray((a - j * B) * width, (b - j * B) * width), (a - kStart) * width);
    }
    this.grStats.hits++;
    return out;
  }
}
