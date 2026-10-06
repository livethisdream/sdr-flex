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
const MAX_BLOCKS = 64;
const FORMATS = new Set(['cf32', 'cs16', 'cu8']);

export class GrEngine extends MockEngine {
  constructor(opts, worker) {
    super(opts);
    this.gr = worker;
    this.grStats = { blocks: 0, ms: 0, misses: 0, hits: 0 };
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

  /** Fetch every GNU Radio block a read ending at `at` and spanning `spanS` could touch. */
  async prepare(nodeId, at, spanS = 0) {
    if (!this.gr) return;
    const tuners = [];
    for (let n = this.node(nodeId); n; n = n.parent != null ? this.node(n.parent) : null) {
      if (this._grTuner(n)) tuners.push(n);
    }
    for (const n of tuners) {
      const fs = n.out.sampleRate, B = Math.max(256, Math.round(BLOCK_S * fs));
      const spec = this._tunerSpec(n);
      const blocks = this._blocksOf(n, spec.sig);
      const t0 = Math.max(0, at - spanS - PREPARE_BEFORE_S), t1 = Math.min(this.duration(), at + PREPARE_AFTER_S);
      for (let j = Math.floor((t0 * fs) / B); j * B < t1 * fs; j++) {
        if (blocks.has(j)) continue;
        const started = performance.now();
        try {
          const { bytes } = await this.gr.request({
            op: 'tuner', path: this.capture.path, format: this.capture.format, rate: spec.fsIn,
            k0: j * B, count: B, taps: Array.from(spec.taps), decim: spec.decim, offset: spec.offset,
          });
          blocks.set(j, new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)));
          this.grStats.blocks++;
          this.grStats.ms += performance.now() - started;
        } catch {
          // Off the end of the file, or the worker refused it: this block stays the JS
          // engine's, and is not asked for again.
          blocks.set(j, null);
        }
        if (blocks.size > MAX_BLOCKS) blocks.delete(blocks.keys().next().value);
      }
    }
  }

  _readIQ(node, tEnd, count) {
    if (this._grTuner(node)) {
      const spec = this._tunerSpec(node);
      const blocks = this._blocksOf(node, spec.sig);
      const fs = node.out.sampleRate, B = Math.max(256, Math.round(BLOCK_S * fs));
      const kEnd = Math.floor(tEnd * fs), kStart = kEnd - count;
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
    }
    return super._readIQ(node, tEnd, count);
  }
}
