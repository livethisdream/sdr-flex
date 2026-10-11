// One connection, one engine.
//
// The dispatch table below is the whole contract between the two halves of the tool.
// It is deliberately the same set of calls `MockEngine` already had, because the point
// of the exercise was to find out whether the interface designed against a mock could
// carry a real backend without the client noticing — and the answer is only meaningful
// if the calls do not change to make it true.
//
// Two rules keep the mirror on the other end honest:
//
//  - Every reply except a frame carries a fresh graph snapshot. Snapshots are a few
//    kilobytes and replacing one wholesale cannot drift; deltas can, and the bug you
//    get when they do is a parameter that reads one value and behaves like another.
//  - The server keeps no clock. Every read carries the moment it wants, because the
//    playhead belongs to whoever is watching (see graph.js).

import { MockEngine as Engine } from '../web/src/engine.js';
import { encode, decode } from '../web/src/proto.js';
import { Radio, list as listDrivers } from './radio.js';
import * as adapters from './adapters.js';
import { version } from './version.js';
import { StreamOut } from './streamout.js';
import { GrPool, PRIORITY } from './gr/pool.js';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { GrEngine } from './gr/engine.js';
import { sceneRecording } from './gr/scene.js';
import os from 'node:os';
import fs from 'node:fs';
import { recipeGrc, programGrc } from './grc.js';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PROTOCOL = 1;

/** Sent as chunks rather than one reply, because a span can be hundreds of megabytes. */
const CHUNK_FLOATS = 1 << 20;

export class Session {
  constructor(conn, { library, log = () => {}, ringDir, pluginDir, sessions = false, recipeDir = null } = {}) {
    // Where recipes saved from the page are kept on this box, when it keeps anything.
    this.recipeDir = recipeDir;
    this.conn = conn;
    this.library = library;
    // Whether this box keeps saved sessions. Said here and served over HTTP: a session
    // is a document, not a graph operation (ADR-0042), and the dispatch table below is
    // the engine's own calls and nothing else.
    this.sessions = sessions;
    this.log = log;
    this.ringDir = ringDir;
    this.pluginDir = pluginDir;
    // GNU Radio as the engine (ADR-0044), one worker per session (ADR-0003). Opt-in while
    // the migration is under way; unset, nothing about the session changes.
    this.gr = process.env.SDRFLEX_ENGINE === 'gnuradio' ? new GrPool({ log }) : null;
    this.engine = this.gr
      ? new GrEngine({ latency: false }, this.gr, { scene: sceneRecording(ringDir || os.tmpdir(), { log }) })
      : new Engine({ latency: false });
    // Somebody else's decoders, offered to the graph. Only the server can know which of
    // them are installed, and only the server can run one (ADR-0013).
    this.engine.adapters = adapters.list();
    this.engine.adapter = (id) => (adapters.ADAPTERS[id] ? { id, ...adapters.ADAPTERS[id] } : null);
    this.engine.runAdapter = (n, at, span) => this._runAdapter(n, at, span);
    // The same programs, addressed by samples rather than by node. `Identify` runs
    // decoders over speculative demodulations of one span, none of which is a node and
    // none of which should become one just to be tried.
    this.engine.runAdapterData = (a) => adapters.run(a.adapter, a);
    this.radio = null;
    this.sinks = new Map();   // nodeId → StreamOut
    this.closed = false;
    if (process.env.SDRFLEX_GR_DEBUG) { this._loop = monitorEventLoopDelay({ resolution: 5 }); this._loop.enable(); }
    if (this.gr) {
      this.gr.start().then(() => log(`GNU Radio ${this.gr.version} worker up in ${this.gr.startMs.toFixed(0)} ms`),
                           (err) => log(`GNU Radio worker did not start: ${err.message}`));
    }

    conn.on('message', (buf) => this._onMessage(buf));
    conn.on('close', () => { this.closed = true; this.dispose(); });
  }

  /**
   * Feed an external decoder the span its parent can see.
   *
   * The whole span, not a display window: these programs are written to read a file to
   * the end and exit, and a decoder given the two hundred milliseconds that happen to
   * be on screen finds nothing and says nothing about why.
   */
  async _runAdapter(n, at, span = null) {
    const e = this.engine;
    const p = e.node(n.parent);
    if (!p) return { records: [], error: 'nothing upstream' };
    const pin = e.isPinned(p.id);
    const now = at != null ? at : e.t;
    // A span given explicitly is one block of a capture being decoded as it plays, and
    // it outranks both the pin and the whole-capture default: the caller already knows
    // which seconds it wants and why.
    const t0 = span ? span.t0 : pin ? pin.params.t0.value : 0;
    const t1 = span ? span.t1 : pin ? pin.params.t1.value
      : (isFinite(e.duration()) ? e.duration() : now);
    const got = await e.readSpan(p.id, t0, t1);
    if (!got) return { records: [], error: 'nothing upstream has produced samples yet' };

    const params = {};
    for (const [k, v] of Object.entries(n.params)) params[k] = v.value;
    const out = await adapters.run(n.adapter, {
      data: got.data, kind: got.kind, sampleRate: got.sampleRate,
      centerHz: p.out.centerHz, params,
    });
    return { ...out, note: `${out.note} · ${(t1 - t0).toFixed(1)} s` };
  }

  dispose() {
    if (this._loop) {
      const h = this._loop, ms = (v) => (v / 1e6).toFixed(1);
      this.log(`event loop delay: p50 ${ms(h.percentile(50))} ms, p95 ${ms(h.percentile(95))}, p99 ${ms(h.percentile(99))}, max ${ms(h.max)}`);
      h.disable(); this._loop = null;
    }
    if (this.gr) {
      const st = this.engine.grStats;
      if (st) this.log(`GNU Radio: ${st.blocks} blocks in ${st.ms.toFixed(0)} ms` +
        ` (${st.blocks ? (st.ms / st.blocks).toFixed(1) : '-'} ms each), ${st.hits} reads from them, ${st.misses} fell back to JS,` +
        ` ${st.waits} frame or audio calls waited for a block, ${st.outside} outside the capture`);
      this.gr.stop(); this.gr = null;
    }
    for (const sink of this.sinks.values()) sink.close();
    this.sinks.clear();
    for (const s of (this.streams || new Map()).values()) s.stream.close();
    this.streams = null;
    // A radio is a process and a file on disk; a tab going away has to take both with
    // it, or a box accumulates dead dongles and gigabytes of ring nobody is watching.
    if (this.radio) { this.radio.stop(); this.radio = null; }
    else if (this.engine.capture && this.engine.capture.close) this.engine.capture.close();
    this.engine.capture = null;
  }

  _send(msg) { if (!this.closed) this.conn.send(encode(msg)); }

  async _onMessage(buf) {
    let msg;
    try { msg = decode(buf); } catch (e) { this.log(`undecodable message: ${e.message}`); return; }
    const { id, m, a } = msg;
    const fn = METHODS[m];
    if (!fn) { this._send({ id, t: 'err', e: `no method ${m}` }); return; }
    try {
      const v = await fn.call(this, a || {}, id);
      if (this.closed) return;
      // `frames` is the hot path and answers many times a second; it is the one reply
      // that does not carry the graph, because nothing it does can change the graph.
      // `frames` is the hot path and does not carry the graph, but a live source moves
      // on its own — so it carries the two numbers that say how far back history now
      // goes. Thirty times a second, for free, the mirror stays honest about a window
      // nothing the client did has changed.
      // `decodeTo` is asked a few times a second while a decoder is open and cannot change
      // the graph either, so it does not carry it. It carries a live source's window, as
      // `frames` does: with the Events pane open nothing asks for frames, and a mirror that
      // never heard the radio move held the playhead where the pane was opened.
      if (m === 'decodeTo') {
        this._send({ id, t: 'ok', v, live: this.engine.isLive() ? this.engine.span() : null });
        return;
      }
      this._send(m === 'frames'
        ? { id, t: 'ok', v, live: this.engine.isLive() ? this.engine.span() : null,
            radio: this.radio ? { status: this.radio.status, dropped: this.radio.ring?.dropped || 0 } : null }
        : { id, t: 'ok', v, g: this.engine._snapshot() });
    } catch (e) {
      this.log(`${m} failed: ${e.stack || e.message}`);
      this._send({ id, t: 'err', e: e.message || String(e) });
    }
  }
}

// How long a batch of frames runs before letting other requests in.
const YIELD_MS = 8;
// A decoder fed as the capture plays: how far ahead of the feed the playhead may get before
// the stream starts again from it, how much is fed per read, how long a stream nobody is
// asking about is kept, and how long a feed waits for what it made the decoder print.
const STREAM_JUMP_S = 10;
const STREAM_RUNIN_S = 2;
const STREAM_CHUNK = 1 << 16;
const STREAM_IDLE_MS = 60_000;
const STREAM_SETTLE_MS = 30;

/**
 * The recipes on this box (ADR-0043), read once from their .grc files by server/gr/recipes.py:
 * the files are YAML, and GNU Radio's Python reads YAML already. A box without GNU Radio has
 * none to offer, which the CW node does not need — it is a node of its own either way.
 */
let RECIPES = null;
const RECIPE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'gr', 'recipes.py');
const SHIPPED_RECIPES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'recipes');
function recipeList(log, mineDir) {
  if (RECIPES) return RECIPES;
  const r = spawnSync(process.env.SDRFLEX_GR_PYTHON || 'python3',
                      [RECIPE_SCRIPT, SHIPPED_RECIPES, ...(mineDir ? [mineDir] : [])], { encoding: 'utf8', timeout: 20_000 });
  try {
    const got = JSON.parse(r.stdout);
    for (const e of got.errors) log(`recipe not loaded: ${e}`);
    RECIPES = got.recipes;
  } catch {
    RECIPES = [];
  }
  return RECIPES;
}

export const METHODS = {
  async hello() {
    const table = adapters.list();
    return { protocol: PROTOCOL, engine: 'node', captures: !!this.library, radios: true,
             plugins: !!this.pluginDir, sessions: !!this.sessions,
             // Which build answered. The page is served by this same process, so this is
             // the version of the client too — one number, not two that can disagree.
             version: version(),
             adapters: table.filter((a) => a.available).length,
             // The whole table, not just the count. It is a few hundred bytes, it is
             // sent once, and the client needs it to work out what `Identify` is about
             // to try *before* the first decoder answers — a panel that can only grow
             // as results land reads as "nothing found" for the first second.
             adapterTable: table,
             recipes: recipeList(this.log, this.recipeDir) };
  },

  async createSession() {
    const root = await this.engine.createSession();
    return { root: root.id };
  },

  async listCaptures() {
    return { captures: this.library ? this.library.list() : [] };
  },

  /**
   * The plugin sources this box keeps, for the tab to load and run.
   *
   * Sent as text rather than served as a URL so there is one path into the loader and
   * one place that validates a manifest, whether the file was dropped on the window or
   * found in a directory.
   */
  async listPlugins() {
    return { plugins: this.pluginDir ? this.pluginDir.list() : [] };
  },

  /** Every driver this build knows, and whether its program is on this box. */
  async listRadios() {
    return { drivers: listDrivers() };
  },

  async openRadio({ kind, tuning, ringSeconds }) {
    const radio = new Radio({
      kind,
      ringSeconds: Math.min(600, Math.max(5, ringSeconds || 60)),
      ringDir: this.ringDir,
      log: this.log,
    });
    await radio.start(tuning || {});
    if (this.radio) this.radio.stop();
    else if (this.engine.capture && this.engine.capture.close) this.engine.capture.close();
    this.radio = radio;
    const root = await this.engine.openRadio(radio);
    return { root: root.id, label: radio.label, format: radio.format,
             sampleRate: radio.sampleRate, centerHz: radio.centerHz };
  },

  async stopRadio() {
    if (this.radio) { this.radio.stop(); this.radio = null; this.engine.capture = null; }
    return {};
  },

  async openCapture({ id }) {
    if (!this.library) throw new Error('this server has no capture library');
    const old = this.engine.capture;
    const cap = this.library.open(id);
    const root = await this.engine.openCapture(cap);
    if (old && old.close) old.close();
    return { root: root.id };
  },

  async palette({ nodeId }) {
    return { ops: await this.engine.palette(nodeId) };
  },

  async addNode({ parent, op, selection, at, withNode = null, recipe = null }) {
    const n = await this.engine.addNode({ parent, op, selection, at, withNode, recipe });
    return { id: n.id };
  },

  async removeNode({ id }) {
    // A sink removed is a sink that stops: ADR-0027's whole point is that taking one
    // off the graph makes something real stop happening.
    const sink = this.sinks.get(id);
    if (sink) { sink.close(); this.sinks.delete(id); }
    await this.engine.removeNode(id);
    // And a decoder being fed stops with its node, or with any node above it.
    for (const [nodeId, s] of this.streams || []) {
      if (!this.engine.node(nodeId)) { s.stream.close(); this.streams.delete(nodeId); }
    }
    return {};
  },

  async setParam({ nodeId, key, value, mode }) {
    // Retuning a radio is not setting a parameter on a node, it is starting a new
    // recording: none of these programs can be retuned in flight, so the process
    // restarts and the ring starts over. Saying so is better than a knob that looks
    // continuous and silently throws away everything behind it.
    const n = this.engine.node(nodeId);
    if (this.radio && n && n.op === 'core.source' && (key === 'centerHz' || key === 'sampleRate')) {
      await this.radio.retune({ [key]: value });
      await this.engine.openRadio(this.radio);
      return { rebuilt: true, retuned: true };
    }
    const r = await this.engine.setParam(nodeId, key, value, mode);
    if (process.env.SDRFLEX_GR_DEBUG) this._lastSet = { nodeId, t: performance.now() };
    return { rebuilt: r.rebuilt };
  },

  async setMode({ nodeId, key, mode }) {
    await this.engine.setMode(nodeId, key, mode);
    return {};
  },

  async renameNode({ nodeId, name }) {
    await this.engine.renameNode(nodeId, name);
    return {};
  },

  /**
   * A batch, not a call. The waterfall prefills two hundred and sixty rows at
   * arbitrary moments, and asking for those one at a time over a network is two
   * hundred and sixty round trips for what the engine computes in a few milliseconds.
   */
  async frames({ reqs, prefill = null, prefillKey = null }) {
    // A waterfall prefill is several batches sent at once, and a retune starts a new one. The
    // newest is the one anyone will see: an older one stops where it is and answers the rows it
    // got to, rather than holding the server for seconds computing rows for a picture that is
    // already gone. Batches that run side by side otherwise pile up until none finishes.
    if (prefill != null) {
      if (!this._prefills) this._prefills = new Map();
      if (prefill > (this._prefills.get(prefillKey) || 0)) this._prefills.set(prefillKey, prefill);
    }
    const stale = () => prefill != null && this._prefills.get(prefillKey) !== prefill;
    // The GNU Radio engine fetches the blocks these reads will touch first; the reads
    // themselves are synchronous.
    const t0 = performance.now();
    if (this.engine.prepare) {
      for (const { nodeId, opts, live } of reqs) {
        if (stale()) return { frames: [] };
        const at = opts && opts.at != null ? opts.at : this.engine.effectiveTime(nodeId);
        await this.engine.prepare(nodeId, at, this.engine.frameSpan(nodeId, opts || {}),
                                  live ? PRIORITY.frame : PRIORITY.read);
      }
    }
    const t1 = performance.now();
    // A waterfall's prefill asks for 64 rows at once, and computing them in one go held the
    // server's thread for up to 250 ms — after a retune, the retuned spectrum waited behind
    // the waterfall refilling its history. So a batch gives way every few milliseconds, and a
    // live view's request runs in between its rows.
    const frames = [];
    let since = performance.now();
    for (const { nodeId, opts } of reqs) {
      try { frames.push(this.engine.frame(nodeId, opts || {})); } catch { frames.push({ kind: 'none' }); }
      if (reqs.length > 1 && performance.now() - since > YIELD_MS) {
        await new Promise((r) => setImmediate(r));
        since = performance.now();
        if (stale()) break;
      }
    }
    if (process.env.SDRFLEX_GR_DEBUG && performance.now() - t1 > 30) {
      this.log(`slow frame compute ${(performance.now() - t1).toFixed(0)} ms: ${reqs.map(({ nodeId, opts }) => `${this.engine.node(nodeId)?.op}${opts?.domain ? '/' + opts.domain : ''}${opts?.at != null ? '@' + opts.at.toFixed(2) : ''}`).join(', ')}`);
    }
    if (this._lastSet && reqs.length === 1 && reqs[0].nodeId === this._lastSet.nodeId && reqs[0].live) {
      this.log(`retune -> its frame computed, server side: ${(performance.now() - this._lastSet.t).toFixed(1)} ms (request arrived ${(t0 - this._lastSet.t).toFixed(1)} ms after setParam returned)`);
      this._lastSet = null;
    }
    if (process.env.SDRFLEX_GR_DEBUG && reqs.length === 1) {
      const { nodeId, opts } = reqs[0], n = this.engine.node(nodeId);
      this.log(`frame ${n ? n.op : '?'}${opts && opts.domain ? '/' + opts.domain : ''}: prepare ${(t1 - t0).toFixed(1)} ms, compute ${(performance.now() - t1).toFixed(1)} ms`);
    }
    return { frames };
  },

  async readSpan({ nodeId, t0, t1 }, id) {
    const got = await this.engine.readSpan(nodeId, t0, t1, (frac) => {
      this._send({ id, t: 'progress', v: frac });
    });
    if (!got) return null;
    // One reply would be a 200 MB message. Chunks let the client allocate once and
    // fill as they land, and keep a slow export from looking like a hung socket.
    const { data, ...rest } = got;
    for (let off = 0; off < data.length; off += CHUNK_FLOATS) {
      this._send({ id, t: 'chunk', v: { off, data: data.subarray(off, Math.min(data.length, off + CHUNK_FLOATS)) } });
    }
    return { ...rest, floats: data.length };
  },

  /**
   * A resource grid. One Float32Array of cell amplitudes, which the wire format carries
   * as a payload rather than as JSON — a 512 × 64 grid is 32k numbers and a JSON array of
   * those is a megabyte of text for 128 kB of data.
   */
  async sliceGrid({ nodeId, at }) {
    const r = await this.engine.sliceGrid(nodeId, at);
    return r ? { grid: strip(r) } : null;
  },

  async sliceBytes({ nodeId, at }, id) {
    const r = await this.engine.sliceBytes(nodeId, (frac) => {
      this._send({ id, t: 'progress', v: frac });
    }, at);
    return r ? { sliced: strip(r) } : null;
  },

  /**
   * Every decoder that could read this stream, run over one span.
   *
   * Each result goes back the moment it lands, on the same per-call progress channel
   * the waterfall and the exporter already use. Eight subprocesses is several seconds
   * even when they all succeed, and a report that fills in row by row is the difference
   * between watching it work and wondering whether it has hung.
   */
  async identify({ nodeId, at }, id) {
    const r = await this.engine.identify(nodeId, {
      at,
      onResult: (row) => this._send({ id, t: 'progress', v: row }),
    });
    return r || null;
  },

  /** Frames and their CRC. A built-in, so it runs where the bytes are. */
  async runRecords({ nodeId, at }) {
    const r = await this.engine.runRecords(nodeId, at);
    return r || null;
  },

  /**
   * Push one chunk of a stream sink's parent out to the network.
   *
   * Driven by the client, one chunk at a time, exactly the way the audio mixer is
   * driven — because the client owns the clock (ADR-0029) and a server-side loop
   * sending on its own schedule would be a second clock disagreeing with the first.
   * The playhead the chunk is taken from is the client's, and when it stops, this
   * stops, with no timer anywhere to unwind.
   *
   * The conversion is the adapters' own, so a sink and a decoder agree about what
   * `s16 at 48 kHz` means, and a format nobody can produce is rejected in one place.
   */
  async streamPush({ nodeId, t0, seconds }) {
    const e = this.engine;
    const n = e.node(nodeId);
    if (!n || n.op !== 'core.stream') return null;
    const p = e.node(n.parent);
    if (!p) return { error: 'nothing upstream' };

    const host = String(n.params.host.value || '127.0.0.1');
    const port = Number(n.params.port.value) || 7355;
    let sink = this.sinks.get(nodeId);
    // Re-made when the address changes, rather than mutated: a socket that quietly
    // starts pointing somewhere else is the kind of thing nobody can debug from the
    // receiving end.
    if (sink && (sink.host !== host || sink.port !== port)) { sink.close(); sink = null; }
    if (!sink) { sink = new StreamOut({ host, port, log: this.log }); this.sinks.set(nodeId, sink); }

    const got = await e.readSpan(p.id, t0, t0 + seconds);
    if (!got) return { ...sink.status(), sentNow: 0 };

    const format = String(n.params.format.value || 's16');
    let bytes;
    if (format === 'raw' && got.data instanceof Uint8Array) {
      bytes = Buffer.from(got.data.buffer, got.data.byteOffset, got.data.byteLength);
    } else {
      const want = { format: format === 'raw' ? 'cf32' : format,
                     rate: Number(n.params.rate.value) || got.sampleRate };
      bytes = adapters.convert(got.data, got.kind, got.sampleRate, want).bytes;
    }
    const sentNow = sink.write(bytes);
    return { ...sink.status(), sentNow };
  },

  /** Stop sending and let the socket go. */
  async streamStop({ nodeId }) {
    const sink = this.sinks.get(nodeId);
    if (sink) { sink.close(); this.sinks.delete(nodeId); }
    return { stopped: true };
  },

  /** One block of it, for a decoder being watched while the capture plays. */
  /**
   * Decode up to `t` seconds, continuously (adapters.DecoderStream): what the decoder has said
   * since the last call, the line it is partway through, and how far it has been fed.
   *
   * The stream picks up where the last call left it, so the samples it sees are one unbroken
   * run. It starts again, a run-in before `t`, when that cannot be true: a seek backwards, a jump forward
   * too far to feed, or a change to the decoder or anything upstream of it. `from` says where
   * the current run began, so the client can drop what an earlier run said about the same
   * stretch rather than show it twice.
   */
  async decodeTo({ nodeId, t }) {
    const e = this.engine, n = e.node(nodeId);
    const a = n && n.adapter ? adapters.spec(n.adapter) : null;
    if (!a || !a.stream) return null;
    const p = e.node(n.parent);
    if (!p || (p.out.kind !== 'iq' && p.out.kind !== 'real')) return { records: [], error: 'nothing upstream' };
    if (!this.streams) this.streams = new Map();
    const now = performance.now();
    for (const [id, s] of this.streams) {
      if (now - s.used > STREAM_IDLE_MS) { s.stream.close(); this.streams.delete(id); }
    }
    const fs = p.out.sampleRate;
    const params = {};
    for (const [k, v] of Object.entries(n.params)) params[k] = v.value;
    const sig = `${e._chainSig(p)}|${JSON.stringify(params)}`;
    const kNow = Math.floor(t * fs), kFirst = Math.ceil(e.span()[0] * fs);
    let s = this.streams.get(nodeId);
    if (!s || s.sig !== sig || s.stream.closed || kNow < s.k - fs * 0.05 || kNow - s.k > fs * STREAM_JUMP_S) {
      if (s) s.stream.close();
      // A little before the playhead: playback that has just started has already moved on by
      // the time it first asks, and a decoder started mid-character needs one to find its feet.
      const k = Math.max(kFirst, kNow - Math.round(STREAM_RUNIN_S * fs));
      s = { sig, k, from: k / fs, busy: false,
            stream: new adapters.DecoderStream(n.adapter, { kind: p.out.kind, sampleRate: fs, centerHz: p.out.centerHz, params }) };
      this.streams.set(nodeId, s);
    }
    s.used = now;
    // One feed at a time: a second call while one is feeding reports, and leaves the feeding
    // to the first.
    if (!s.busy) {
      s.busy = true;
      try {
        while (s.k < kNow && !s.stream.closed) {
          const count = Math.min(kNow - s.k, STREAM_CHUNK);
          // Half a sample past the last one, so the engine's floor lands on it exactly.
          const tEnd = (s.k + count + 0.5) / fs;
          if (e.prepare) await e.prepare(p.id, tEnd, count / fs);
          const data = p.out.kind === 'iq' ? e._readIQ(p, tEnd, count) : e._detectMono(p, tEnd, count);
          s.k += count;
          await s.stream.write(data, s.k / fs);
        }
      } finally {
        s.busy = false;
      }
      // What those samples made the decoder print arrives a moment after they went in.
      await new Promise((r) => setTimeout(r, STREAM_SETTLE_MS));
    }
    return { ...s.stream.take(), at: s.k / fs, from: s.from };
  },

  /**
   * A chain as GNU Radio Companion (server/grc.js): `recipe`, a hier block that comes back into
   * the menu, or `program`, a flowgraph a desktop can run. Written here from the graph, never
   * from text the page sends. `keep` puts a recipe in this box's recipes, beside the shipped
   * ones; a name already taken is refused rather than overwritten (ADR-0043: the page adds
   * recipes and never replaces one).
   */
  async exportGrc({ nodeId, title, as = 'recipe', keep = false }) {
    const name = String(title || '').trim().slice(0, 60);
    if (!name) throw new Error('a recipe needs a name');
    const out = as === 'program' ? programGrc(this.engine, nodeId, name) : recipeGrc(this.engine, nodeId, name);
    if (as === 'recipe' && keep) {
      if (!this.recipeDir) throw new Error('this box keeps nothing — download the file instead');
      const taken = new Set(recipeList(this.log, this.recipeDir).map((r) => r.name));
      if (taken.has(out.name)) throw new Error(`there is already a recipe called ${out.name}; pick another name`);
      fs.mkdirSync(this.recipeDir, { recursive: true });
      fs.writeFileSync(path.join(this.recipeDir, `${out.name}.grc`), out.text, { flag: 'wx' });
      RECIPES = null;
      out.recipes = recipeList(this.log, this.recipeDir);
      out.kept = true;
    }
    return out;
  },

  async runRecordsSpan({ nodeId, t0, t1 }) {
    const r = await this.engine.runRecordsSpan(nodeId, t0, t1);
    return r || null;
  },

  async readAudio({ nodeId, t0, count }) {
    if (this.engine.prepare) {
      const n = this.engine.node(nodeId);
      const fs = n ? n.out.sampleRate : 0;
      if (fs) await this.engine.prepare(nodeId, t0 + count / fs, count / fs);
    }
    return await this.engine.readAudio(nodeId, t0, count);
  },
};

/** `_sliced` carries whatever the slicer cached; only the parts a view reads travel. */
function strip(r) {
  const { key, ...rest } = r;
  return rest;
}
