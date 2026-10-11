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
//     the tuner's samples never cross the pipe only to be demodulated (web/test/grfm.test.mjs);
//   - a stereo decoder on such a demod: GNU Radio's pilot PLL and matrix blocks, arranged as
//     its wfm_rcv_pll arranges them, following the broadcast standard (web/test/grstereo.test.mjs).
//
// The engine's reads are synchronous and the worker answers over a pipe, so the two meet in a
// cache: the session calls `prepare` before anything that reads samples, which fetches the
// blocks the read will need, and the synchronous read then assembles from them. A read that
// finds a block missing is answered by the JS engine, which gives the same samples more
// slowly, and is counted — a miss is a prepare that asked for the wrong span, and the count is
// how that shows up in a measurement rather than in a wrong answer.
import { MockEngine } from '../../web/src/engine.js';
import * as dsp from '../../web/src/dsp.js';
import { PRIORITY } from './pool.js';

const BLOCK_S = 0.25;
// Beyond what a read itself spans: the detector cache (`_detectCached`) computes whole
// 0.25 s blocks with a 30 ms margin either side, so a read can reach that far past its ends.
const EDGE_S = BLOCK_S + 0.03;
// How far past the playhead the worker keeps fetching while nothing is asking. At 37x real
// time it stays ahead with room to spare.
const AHEAD_S = 1.0;
// How long a radio's block that was refused, because it was not on disk yet, waits before it
// is asked for again.
const RETRY_S = 0.3;
const MAX_BLOCKS = 64;
const FORMATS = new Set(['cf32', 'cs16', 'cu8']);
const captureIds = new WeakMap();
let captureCount = 0;
const captureId = (c) => {
  if (!captureIds.has(c)) captureIds.set(c, ++captureCount);
  return captureIds.get(c);
};

export class GrEngine extends MockEngine {
  constructor(opts, worker, { scene = null } = {}) {
    super(opts);
    this.gr = worker;
    // With nothing open, the synthetic scene, once server/gr/scene.js has recorded it.
    this.scene = scene;
    this.grStats = { blocks: 0, ms: 0, misses: 0, hits: 0, waits: 0, outside: 0 };
    this._watched = new Set();
    this._pumping = false;
  }

  /** Can GNU Radio compute this node? A tuner straight off a recorded file, for now. */
  _grTuner(node) {
    if (!node || node.op !== 'core.tuner') return false;
    const p = this.node(node.parent);
    const c = this.capture;
    // A file, or a radio's ring (ADR-0030), which is a file whose start moves: GNU Radio reads
    // it the same way, wrapping where the ring does, and only what is already on disk.
    const st = this._store();
    return !!(p && p.op === 'core.source' && st && FORMATS.has(st.format));
  }

  /**
   * Where the samples are on disk. A file is its own; a radio keeps a Ring (server/ring.js),
   * replaced whenever the radio retunes, so the ring and not the radio is what a block's
   * identity is tied to. (A radio's own `samples` is how many it has written, not the ring's
   * size, which is why this does not read it.)
   */
  _store() {
    const c = this.capture;
    if (!c) return this.scene && this.scene.ready ? { path: this.scene.path, format: 'cf32', ring: 0, id: this.scene } : null;
    if (c.ring) return { path: c.ring.path, format: c.ring.format, ring: c.ring.samples, id: c.ring };
    if (c.live) return c.path ? { path: c.path, format: c.format, ring: c.samples, id: c } : null;
    return c.path ? { path: c.path, format: c.format, ring: 0, id: c } : null;
  }

  _tunerSpec(node) {
    const p = this.node(node.parent);
    const decim = node.params.decim.value;
    const taps = dsp.lowPassTaps(node.params.taps.value, node.params.widthHz.value / 2, p.out.sampleRate);
    const offset = node.params.centerHz.value - p.out.centerHz;
    // The recording itself is part of what a block depends on: retuning a radio starts a new
    // ring at the same path, and a block from the old one would be the wrong signal.
    const sig = `${captureId(this._store().id)}|${p.out.sampleRate}|${decim}|${taps.length}|${node.params.widthHz.value}|${offset}`;
    return { op: 'tuner', complex: true, decim, taps, offset, sig, fsIn: p.out.sampleRate };
  }

  /** Which of the operations GNU Radio computes this node is, or null. */
  _grKind(node) {
    if (this._grTuner(node)) return 'tuner';
    if (node && node.op === 'core.fm_discriminator' && this._grTuner(this.node(node.parent))) return 'fm';
    if (node && node.op === 'core.cw' && this._grTuner(this.node(node.parent))) return 'cw';
    if (node && node.op === 'core.stereo' && this._grKind(this.node(node.parent)) === 'fm') return 'stereo';
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
    if (kind === 'cw') {
      // The CW recipe (recipes/cw.grc), whose parameters are this node's. Its filter is the
      // design `dsp.cwTaps` mirrors, which is what keeps the JS demod a faithful fallback.
      const t = this._tunerSpec(this.node(node.parent)), p = node.params;
      // Its parameters are named as the node's are, so they pass straight through.
      const args = { offsetHz: p.offsetHz.value, pitchHz: p.pitchHz.value, gain: p.gain.value || 1,
                     filterHz: p.filterHz ? Number(p.filterHz.value) : dsp.CW_FILTER_HZ };
      return { ...t, op: 'recipe', recipe: 'cw', args, complex: false,
               sig: `${t.sig}|cw|${args.offsetHz}|${args.pitchHz}|${args.gain}|${args.filterHz}` };
    }
    if (kind === 'stereo') {
      const p = this.node(node.parent);
      const f = this._grSpec(p);
      const extra = {
        audio_decim: Math.round(p.out.sampleRate / node.out.sampleRate),
        // Mono is what the pilot evidence decided, or what a person chose (ADR-0031): with no
        // pilot there is no phase reference, and a difference decoded against noise is not a
        // quiet decode.
        mode: node.params.decode.value === 'mono' ? 'mono' : 'stereo',
        deemph_us: Number(node.params.deemphasisUs.value) || 0,
        phase: node.params.subcarrierDeg ? Number(node.params.subcarrierDeg.value) : 0,
        runin_s: 0.02,
      };
      return { ...f, ...extra, op: 'stereo', width: 2,
               sig: `${f.sig}|stereo|${extra.audio_decim}|${extra.mode}|${extra.deemph_us}|${extra.phase}` };
    }
    return null;
  }

  _blocksOf(node, sig) {
    if (!node._grBlocks || node._grSig !== sig) { node._grBlocks = new Map(); node._grSig = sig; }
    return node._grBlocks;
  }

  /**
   * How far back a display frame of this node reads, in seconds: what `frame` asks for.
   * A spectrum needs its FFT; a scope needs its trigger's search window, which is the longest.
   */
  frameSpan(nodeId, opts = {}) {
    const n = this.node(nodeId);
    if (!n) return 0;
    const fs = n.out.sampleRate, bins = opts.bins || 1024;
    if (n.out.kind === 'iq') return bins / fs;
    if (n.out.kind !== 'real') return 0;
    if (opts.domain === 'frequency') return (bins * 2) / fs;
    const span = opts.spanS || 0.12;
    const search = opts.trigger === 'free' ? span : Math.max(1.05, span);
    return Math.min(search, Math.floor(131072 / this._upstreamRatio(n)) / fs);
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
  _ensure(node, j, priority = PRIORITY.read) {
    const spec = this._grSpec(node);
    const blocks = this._blocksOf(node, spec.sig);
    if (blocks.has(j)) return Promise.resolve();
    if (!node._grInflight || node._grInflightSig !== spec.sig) { node._grInflight = new Map(); node._grInflightSig = spec.sig; }
    const key = `${node.id}|${spec.sig}|${j}`;
    if (node._grInflight.has(j)) {
      // Already asked for, perhaps by the prefetch at its low priority; a frame waiting on it
      // now should not wait behind the prefetch's queue.
      if (this.gr.raise) this.gr.raise(key, priority);
      return node._grInflight.get(j);
    }
    const B = this._blockSize(node);
    const started = performance.now();
    const p = this.gr.request({
      op: spec.op, path: this._store().path, format: this._store().format, rate: spec.fsIn,
      ring: this._store().ring,
      k0: j * B, count: B, taps: Array.from(spec.taps), decim: spec.decim, offset: spec.offset,
      ...Object.fromEntries(['scale', 'audio_decim', 'mode', 'deemph_us', 'runin_s', 'phase', 'recipe', 'args']
        .filter((k) => spec[k] != null).map((k) => [k, spec[k]])),
    }, priority, key).then(({ bytes }) => {
      blocks.set(j, new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)));
      this.grStats.blocks++;
      this.grStats.ms += performance.now() - started;
    }, () => {
      // Off the end of the file, or the worker refused it: this block stays the JS engine's,
      // and is not asked for again — unless it is a radio's and simply has not been written
      // yet, which is a block to ask for again once it has, and not before RETRY_S has passed:
      // asked for at once, a refusal became a loop that never yielded.
      if (this.gr.stopped) return;
      const [, last] = this.span();
      if (this.capture && this.capture.live && ((j + 1) * B) / node.out.sampleRate > last - 0.5) {
        if (!node._grRetry) node._grRetry = new Map();
        node._grRetry.set(j, performance.now());
      } else {
        blocks.set(j, null);
      }
    }).finally(() => {
      node._grInflight.delete(j);
      if (blocks.size > MAX_BLOCKS) blocks.delete(blocks.keys().next().value);
    });
    node._grInflight.set(j, p);
    return p;
  }

  /** Where the signal ends now: a file's length, or a radio's newest sample. */
  _end() {
    if (!this.capture) return this.scene ? this.scene.durationS : 0;
    return this.capture.live ? this.span()[1] : this.duration();
  }

  /** The moments a block may come from: the file, or what of a radio's ring is on disk. */
  _onDisk() {
    if (this.capture && this.capture.live) {
      const [first, last] = this.span();
      // A block reads a little past its own end (the tuner's filter) and starts a little
      // before (the stereo PLL's run-in), so it stays clear of both edges of the ring.
      return [first + 0.1, last - 0.02];
    }
    return [0, this._end()];
  }

  _range(node, t0, t1) {
    const fs = node.out.sampleRate, B = this._blockSize(node);
    const [lo, hi] = this._onDisk();
    const live = !!(this.capture && this.capture.live);
    // Every block the span overlaps, as for a file; on a ring, none that is not wholly on disk.
    const a = Math.max(Math.floor((t0 * fs) / B), live ? Math.ceil((lo * fs) / B) : 0);
    const b = Math.min(Math.ceil((t1 * fs) / B), live ? Math.floor((hi * fs) / B) : Math.ceil((hi * fs) / B));
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
  async prepare(nodeId, at, spanS = 0, priority = PRIORITY.read) {
    if (!this.gr) return;
    const tuners = this._grNodesOf(nodeId);
    for (const n of tuners) n._grAt = at;
    const waits = [];
    for (const n of tuners) {
      const spec = this._grSpec(n);
      const blocks = this._blocksOf(n, spec.sig);
      // Wait only for the blocks this read touches. A tuner's IQ is read exactly, so that is
      // the span itself; anything read through the detector cache (`_detectCached`) is read in
      // whole 0.25 s blocks with a 30 ms margin, so it rounds out to those. Waiting on a margin
      // either side as well tripled what a retuned spectrum waited for, on one reserved lane.
      // The rest is fetched behind, at the prefetch's priority.
      const fs = n.out.sampleRate, B = this._blockSize(n), here = Math.floor((at * fs) / B);
      const exact = n.id === nodeId && n.out.kind === 'iq';
      const t0 = exact ? at - spanS : Math.floor((at - spanS) / BLOCK_S) * BLOCK_S - 0.03;
      const t1 = exact ? at : Math.ceil(at / BLOCK_S) * BLOCK_S + 0.03;
      const need = this._range(n, t0, t1).filter((j) => !blocks.has(j));
      need.sort((x, y) => Math.abs(x - here) - Math.abs(y - here));
      for (const j of need) waits.push(this._ensure(n, j, priority));
      for (const j of this._range(n, at - spanS - EDGE_S, at + EDGE_S)) {
        if (!blocks.has(j) && !need.includes(j)) this._ensure(n, j, PRIORITY.prefetch);
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
        if (this.gr.stopped) return;
        let next = null;
        const now = performance.now();
        const waiting = (n, k) => n._grRetry && n._grRetry.has(k) && now - n._grRetry.get(k) < RETRY_S * 1000;
        for (const id of this._watched) {
          const n = this.node(id);
          if (!n || !this._grKind(n) || n._grAt == null) { this._watched.delete(id); continue; }
          const blocks = this._blocksOf(n, this._grSpec(n).sig);
          const j = this._range(n, n._grAt, n._grAt + AHEAD_S).find((k) => !blocks.has(k) && !waiting(n, k));
          if (j != null) { next = [n, j]; break; }
        }
        if (!next) return;
        await this._ensure(next[0], next[1], PRIORITY.prefetch);
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
      if (kStart < 0 || tEnd > this._end()) { this.grStats.outside++; return super._readIQ(node, tEnd, count); }
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
    const kind = this._grKind(node);
    if (kind === 'fm' || kind === 'stereo' || kind === 'cw') {
      const out = this._fromBlocks(node, tEnd, count, kind === 'stereo' ? 2 : 1);
      if (out) return out;
    }
    return super._detectRaw(node, tEnd, count);
  }

  /** `count` samples ending at `tEnd` from a node's GNU Radio blocks, or null if any is missing. */
  _fromBlocks(node, tEnd, count, width) {
    const blocks = this._blocksOf(node, this._grSpec(node).sig);
    const fs = node.out.sampleRate, B = this._blockSize(node);
    const kEnd = Math.floor(tEnd * fs), kStart = kEnd - count;
    if (kStart < 0 || tEnd > this._end()) { this.grStats.outside++; return null; }
    const out = new Float32Array(count * width);
    for (let j = Math.floor(kStart / B); j * B < kEnd; j++) {
      const blk = blocks.get(j);
      if (!blk) {
        this.grStats.misses++;
        if (process.env.SDRFLEX_GR_DEBUG) {
          const caller = new Error().stack.split('\n').slice(3, 7).map((l) => l.trim().replace(/^at /, '').replace(/ \(.*\/(\w+\.js):(\d+):\d+\)/, ' $1:$2')).join(' < ');
          console.error(`gr miss ${node.op}: block ${j} ${blocks.has(j) ? '(refused)' : '(not fetched)'}, read ending ${tEnd.toFixed(3)} for ${(count / fs).toFixed(3)} s, playhead ${node._grAt == null ? '-' : node._grAt.toFixed(3)} | ${caller}`);
        }
        return null;
      }
      const a = Math.max(kStart, j * B), b = Math.min(kEnd, (j + 1) * B);
      out.set(blk.subarray((a - j * B) * width, (b - j * B) * width), (a - kStart) * width);
    }
    this.grStats.hits++;
    return out;
  }
}
