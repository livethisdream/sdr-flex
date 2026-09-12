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

export const PROTOCOL = 1;

/** Sent as chunks rather than one reply, because a span can be hundreds of megabytes. */
const CHUNK_FLOATS = 1 << 20;

export class Session {
  constructor(conn, { library, log = () => {}, ringDir, pluginDir } = {}) {
    this.conn = conn;
    this.library = library;
    this.log = log;
    this.ringDir = ringDir;
    this.pluginDir = pluginDir;
    this.engine = new Engine({ latency: false });
    // Somebody else's decoders, offered to the graph. Only the server can know which of
    // them are installed, and only the server can run one (ADR-0013).
    this.engine.adapters = adapters.list();
    this.engine.adapter = (id) => (adapters.ADAPTERS[id] ? { id, ...adapters.ADAPTERS[id] } : null);
    this.engine.runAdapter = (n, at) => this._runAdapter(n, at);
    // The same programs, addressed by samples rather than by node. `Identify` runs
    // decoders over speculative demodulations of one span, none of which is a node and
    // none of which should become one just to be tried.
    this.engine.runAdapterData = (a) => adapters.run(a.adapter, a);
    this.radio = null;
    this.closed = false;

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
  async _runAdapter(n, at) {
    const e = this.engine;
    const p = e.node(n.parent);
    if (!p) return { records: [], error: 'nothing upstream' };
    const pin = e.isPinned(p.id);
    const now = at != null ? at : e.t;
    const t0 = pin ? pin.params.t0.value : 0;
    const t1 = pin ? pin.params.t1.value : (isFinite(e.duration()) ? e.duration() : now);
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

const METHODS = {
  async hello() {
    const table = adapters.list();
    return { protocol: PROTOCOL, engine: 'node', captures: !!this.library, radios: true,
             plugins: !!this.pluginDir,
             adapters: table.filter((a) => a.available).length,
             // The whole table, not just the count. It is a few hundred bytes, it is
             // sent once, and the client needs it to work out what `Identify` is about
             // to try *before* the first decoder answers — a panel that can only grow
             // as results land reads as "nothing found" for the first second.
             adapterTable: table };
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

  async addNode({ parent, op, selection, at }) {
    const n = await this.engine.addNode({ parent, op, selection, at });
    return { id: n.id };
  },

  async removeNode({ id }) {
    await this.engine.removeNode(id);
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
    return { rebuilt: r.rebuilt };
  },

  async setMode({ nodeId, key, mode }) {
    await this.engine.setMode(nodeId, key, mode);
    return {};
  },

  /**
   * A batch, not a call. The waterfall prefills two hundred and sixty rows at
   * arbitrary moments, and asking for those one at a time over a network is two
   * hundred and sixty round trips for what the engine computes in a few milliseconds.
   */
  async frames({ reqs }) {
    return { frames: reqs.map(({ nodeId, opts }) => {
      try { return this.engine.frame(nodeId, opts || {}); } catch { return { kind: 'none' }; }
    }) };
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

  async readAudio({ nodeId, t0, count }) {
    return await this.engine.readAudio(nodeId, t0, count);
  },
};

/** `_sliced` carries whatever the slicer cached; only the parts a view reads travel. */
function strip(r) {
  const { key, ...rest } = r;
  return rest;
}
