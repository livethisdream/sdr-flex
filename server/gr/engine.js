// The engine with GNU Radio doing the signal processing (ADR-0044).
//
// It is the JS engine with the sample-producing operations replaced one at a time, so the
// graph, the protocol and every method the client calls stay exactly as they were
// (ADR-0029). What has moved so far:
//
//   - a tuner on a recorded capture: GNU Radio's freq_xlating_fir_filter_ccf, computed by the
//     session's worker in 0.25 s blocks on the same grid the JS tuner uses, and agreeing with
//     it sample for sample (web/test/grtuner.test.mjs).
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
    return { decim, taps, offset, sig, fsIn: p.out.sampleRate };
  }

  _blocksOf(node, sig) {
    if (!node._grBlocks || node._grSig !== sig) { node._grBlocks = new Map(); node._grSig = sig; }
    return node._grBlocks;
  }

  /** The GNU Radio tuners a read of this node goes through. */
  _grTunersOf(nodeId) {
    const out = [];
    for (let n = this.node(nodeId); n; n = n.parent != null ? this.node(n.parent) : null) {
      if (this._grTuner(n)) out.push(n);
    }
    return out;
  }

  _blockSize(node) { return Math.max(256, Math.round(BLOCK_S * node.out.sampleRate)); }

  /** One block, fetched once: a second ask while the first is in flight shares it. */
  _ensure(node, j) {
    const spec = this._tunerSpec(node);
    const blocks = this._blocksOf(node, spec.sig);
    if (blocks.has(j)) return Promise.resolve();
    if (!node._grInflight || node._grInflightSig !== spec.sig) { node._grInflight = new Map(); node._grInflightSig = spec.sig; }
    if (node._grInflight.has(j)) return node._grInflight.get(j);
    const B = this._blockSize(node);
    const started = performance.now();
    const p = this.gr.request({
      op: 'tuner', path: this.capture.path, format: this.capture.format, rate: spec.fsIn,
      k0: j * B, count: B, taps: Array.from(spec.taps), decim: spec.decim, offset: spec.offset,
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
    const tuners = this._grTunersOf(nodeId);
    for (const n of tuners) n._grAt = at;
    const waits = [];
    for (const n of tuners) {
      const spec = this._tunerSpec(n);
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
          if (!n || !this._grTuner(n) || n._grAt == null) { this._watched.delete(id); continue; }
          const blocks = this._blocksOf(n, this._tunerSpec(n).sig);
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
}
