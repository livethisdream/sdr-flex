// The engine, over a socket.
//
// This class exists to answer one question: can the interface that was designed
// against an in-tab mock carry a real backend without the UI noticing? Everything here
// is in service of keeping that answer honest — the method names, arguments and return
// shapes are the ones `MockEngine` already had, and where something could not be done
// the same way the difference is written down rather than papered over.
//
// There is one real difference, and it is `frame`. The app calls it while it is
// painting, so it cannot wait for anything; a network cannot answer without waiting.
// The resolution is that `frame` is a *reader of the most recent answer* rather than a
// request:
//
//   - Live views: the last frame the server sent for that node and those options,
//     with a new request kicked off when none is in flight. Latest wins, one request
//     outstanding at a time, so the display runs at whatever rate the link supports
//     and a slow link degrades to a lower frame rate instead of a growing queue.
//   - Prefill: the waterfall knows all two hundred and sixty of its row times the
//     moment it decides to prefill, so it says so with `prefetch` and the rows arrive
//     in batches of sixty-four. Asking one at a time would be 260 round trips.
//
// The consequence is that a live display is one round trip behind the engine. On a
// tailnet that is a millisecond. It is the correct behavior for a remote engine and
// the reason the frame rate holds when the link gets worse.

import { Graph } from './graph.js';
import { encode, decode } from './proto.js';
import * as plugins from './plugins.js';

const PREFETCH_BATCH = 64;
const PREFETCH_MAX = 2048;     // rows kept from prefill; a waterfall is ~260

export class RemoteEngine extends Graph {
  constructor(url) {
    super();
    this.url = url || defaultUrl();
    this.ready = false;
    this.error = null;

    this._sock = null;
    this._next = 1;
    this._calls = new Map();       // id → { resolve, reject, onProgress, chunks }
    this._live = new Map();        // key → the most recent frame for it
    this._inflight = new Set();    // keys with a request outstanding
    this._pre = new Map();         // key|time → frame, from prefetch
    this._queue = [];              // frame requests waiting for the next flush
    this._flushing = false;
    this._batching = false;
    this._onStatus = () => {};
  }

  onStatus(fn) { this._onStatus = fn; }

  // ── connection ───────────────────────────────────────────────────────────
  connect() {
    return new Promise((resolve, reject) => {
      let opened = false;
      const s = new WebSocket(this.url);
      s.binaryType = 'arraybuffer';
      this._sock = s;
      s.onmessage = (ev) => this._onMessage(ev.data);
      s.onerror = () => {};
      s.onclose = () => {
        // Closing before it ever opened means nothing is listening. Saying so now
        // rather than at the timeout is the difference between a static host loading
        // instantly on the in-tab engine and appearing to hang for eight seconds.
        if (!opened) { this.error = 'nothing listening'; reject(new Error(`nothing listening at ${this.url}`)); return; }
        this.ready = false;
        this._onStatus({ connected: false });
        for (const c of this._calls.values()) c.reject(new Error('connection closed'));
        this._calls.clear();
        this._inflight.clear();
      };
      s.onopen = async () => {
        opened = true;
        this.ready = true;
        this._onStatus({ connected: true });
        try {
          const hello = await this.call('hello');
          this.server = hello;
          resolve(hello);
        } catch (e) { reject(e); }
      };
      // A socket that never opens has to fail visibly; a tab waiting forever on a
      // server that is not there looks exactly like a tab that is loading slowly.
      setTimeout(() => { if (!this.ready) { this.error = 'no answer'; reject(new Error(`no answer from ${this.url}`)); } }, 4000);
    });
  }

  call(m, a, onProgress) {
    return new Promise((resolve, reject) => {
      if (!this._sock || this._sock.readyState !== 1) { reject(new Error('not connected')); return; }
      const id = this._next++;
      this._calls.set(id, { resolve, reject, onProgress, chunks: null });
      this._sock.send(encode({ id, m, a }));
    });
  }

  _onMessage(buf) {
    const msg = decode(buf);
    const c = this._calls.get(msg.id);
    if (!c) return;

    if (msg.t === 'progress') { c.onProgress && c.onProgress(msg.v); return; }
    if (msg.t === 'chunk') {
      // a span arrives in pieces; hold them until the reply says how many there were
      (c.chunks || (c.chunks = [])).push(msg.v);
      return;
    }
    this._calls.delete(msg.id);
    if (msg.g) this._adopt(msg.g);
    if (msg.t === 'err') { c.reject(new Error(msg.e)); return; }

    if (c.chunks && msg.v && msg.v.floats != null) {
      const data = new Float32Array(msg.v.floats);
      for (const ch of c.chunks) data.set(ch.data, ch.off);
      const { floats, ...rest } = msg.v;
      c.resolve({ ...rest, data });
      return;
    }
    c.resolve(msg.v);
  }

  // ── session ──────────────────────────────────────────────────────────────
  async createSession() {
    await this.call('createSession');
    return this.root;
  }

  /** What captures are on the box. The tab no longer holds the file (ADR-0029). */
  async listCaptures() {
    const r = await this.call('listCaptures');
    return r.captures;
  }

  /**
   * Open one by the id `listCaptures` gave. Not a file object: the samples live on the
   * server and a display asks for windows of them, so shipping the file to the browser
   * to ship windows of it back would be a strange use of a network.
   */
  async openCapture(id) {
    if (id && typeof id === 'object') {
      throw new Error('this engine reads captures from the server — choose one from the library');
    }
    this._forget();
    await this.call('openCapture', { id });
    this.t = 0;
    this.ended = false;
    return this.root;
  }

  // ── graph ────────────────────────────────────────────────────────────────
  async palette(nodeId) {
    const r = await this.call('palette', { nodeId });
    // A plugin loaded in this tab is an operation the server has never heard of, so
    // the two lists are merged here rather than there (see `runPlugin`).
    const n = this.node(nodeId);
    const ext = plugins.forKind(n.out.kind)
      .map((p) => ({ id: p.id, name: p.name, group: p.group || 'Decode',
                     in: p.in, out: p.out, external: true }));
    const have = new Set(r.ops.map((o) => o.id));
    return r.ops.concat(ext.filter((o) => !have.has(o.id)));
  }

  async addNode({ parent, op, selection, at }) {
    const spec = plugins.get(op);
    if (spec) return this._addPluginNode({ parent, op, spec });
    const r = await this.call('addNode', {
      parent, op, selection,
      at: at != null ? at : this.effectiveTime(parent),
    });
    this._forget();
    return this.node(r.id);
  }

  /**
   * A plugin node exists only in this tab.
   *
   * Plugins are JavaScript somebody dropped on the window. In a browser that is a
   * sandbox; on the server it would be arbitrary code running as the server, against
   * every capture on the box, at the invitation of anything that can reach the port.
   * That is a real change in posture and not one to make as a side effect of moving
   * the engine, so the boundary stays where it was: the server produces bytes, this
   * tab runs the decoder over them (ADR-0029).
   */
  _addPluginNode({ parent, op, spec }) {
    const p = this.node(parent);
    const id = `p${this._next++}`;
    const params = {};
    for (const pm of spec.params || []) {
      params[pm.id] = { value: pm.default, mode: pm.auto ? 'auto' : 'manual',
        auto: pm.auto ? { from: 'the default this decoder ships with', confident: false } : null };
    }
    const node = { id, parent, op, label: spec.name, params, plugin: op, local: true,
                   letter: null, stub: false,
                   out: { kind: spec.out, sampleRate: p.out.sampleRate, centerHz: p.out.centerHz } };
    this.nodes.set(id, node);
    return node;
  }

  async removeNode(id) {
    const local = [];
    const walk = (x) => { for (const c of this.children(x)) { walk(c.id); if (c.local) local.push(c.id); } };
    walk(id);
    const n = this.node(id);
    if (n && n.local) { for (const c of local) this.nodes.delete(c); this.nodes.delete(id); return; }
    await this.call('removeNode', { id });
    for (const c of local) this.nodes.delete(c);
    this._forget();
  }

  async setParam(nodeId, key, value, mode = 'manual') {
    const n = this.node(nodeId);
    if (n && n.local) {
      n.params[key] = { ...n.params[key], value, mode };
      n._records = null;
      return { node: n, rebuilt: false };
    }
    const r = await this.call('setParam', { nodeId, key, value, mode });
    this._forget();
    return { node: this.node(nodeId), rebuilt: r.rebuilt };
  }

  async setMode(nodeId, key, mode) {
    const n = this.node(nodeId);
    if (n && n.local) { n.params[key] = { ...n.params[key], mode }; return n; }
    await this.call('setMode', { nodeId, key, mode });
    return this.node(nodeId);
  }

  // ── bulk reads ───────────────────────────────────────────────────────────
  async readSpan(nodeId, t0, t1, onProgress) {
    return await this.call('readSpan', { nodeId, t0, t1 }, onProgress);
  }

  async sliceBytes(nodeId, onProgress) {
    const n = this.node(nodeId);
    if (!n) return null;
    const r = await this.call('sliceBytes',
      { nodeId, at: this.effectiveTime(nodeId) }, onProgress);
    if (!r) return null;
    n._sliced = r.sliced;
    return n._sliced;
  }

  /** The decoder runs here; only its input crosses the wire, and that is kilobytes. */
  async runPlugin(nodeId) {
    const n = this.node(nodeId);
    if (!n || !n.plugin) return null;
    const p = this.node(n.parent);
    const src = p.out.kind === 'bytes' ? await this.sliceBytes(p.id) : null;
    if (!src) return { records: [], error: 'nothing upstream has produced bytes yet' };
    const args = {};
    for (const [k, v] of Object.entries(n.params)) args[k] = v.value;
    const out = plugins.run(n.plugin, src.bytes, args);
    n._records = out;
    return out;
  }

  async readAudio(nodeId, t0, count) {
    return await this.call('readAudio', { nodeId, t0, count });
  }

  // ── frames ───────────────────────────────────────────────────────────────
  /**
   * The most recent frame for this node, and a request for the next one.
   *
   * Returns `{ kind: 'pending' }` before the first has arrived. Every caller already
   * checks `kind` before using a frame, because the engine has always been able to
   * answer `stub` or `none`.
   */
  frame(nodeId, opts = {}) {
    const n = this.node(nodeId);
    if (!n) return { kind: 'none' };
    if (n.stub) return { kind: 'stub' };
    // A plugin node's records never left this tab, so neither does its frame.
    if (n.local) return { kind: 'events', run: n._records || null };
    if (n.out.kind === 'bytes') return { kind: 'bytes', sliced: n._sliced || null };

    const key = frameKey(nodeId, opts);
    if (opts.at != null) {
      const hit = this._pre.get(`${key}@${opts.at.toFixed(6)}`);
      if (hit) return hit;
      this._want(nodeId, opts, opts.at, key);
      return { kind: 'pending' };
    }
    if (!this._inflight.has(key)) this._want(nodeId, opts, this.effectiveTime(nodeId), key);
    return this._live.get(key) || { kind: 'pending' };
  }

  /**
   * "I am about to ask for frames at all of these moments."
   *
   * The waterfall settles its whole prefill plan before it draws the first row, so it
   * can say so, and 260 round trips become four. `MockEngine` does not implement this
   * and does not need to — it answers in microseconds.
   */
  prefetch(nodeId, opts, times) {
    const key = frameKey(nodeId, opts);
    const want = times.filter((t) => !this._pre.has(`${key}@${t.toFixed(6)}`));
    for (let i = 0; i < want.length; i += PREFETCH_BATCH) {
      const batch = want.slice(i, i + PREFETCH_BATCH);
      this.call('frames', { reqs: batch.map((at) => ({ nodeId, opts: { ...opts, at } })) })
        .then((r) => {
          r.frames.forEach((f, k) => this._pre.set(`${key}@${batch[k].toFixed(6)}`, f));
          this._trim();
        })
        .catch(() => {});
    }
  }

  _want(nodeId, opts, at, key) {
    this._inflight.add(key);
    this._queue.push({ nodeId, opts: { ...opts, at }, key, live: opts.at == null });
    this._schedule();
  }

  /**
   * Everything the app asked for while painting one frame goes in one message.
   *
   * `frame` is called several times per animation frame — the spectrum, the trace,
   * sometimes a second view — and a microtask fires once the whole paint has run, so
   * the batch is complete by the time it flushes without anyone having to say so.
   */
  _schedule() {
    if (this._batching) return;
    this._batching = true;
    queueMicrotask(() => { this._batching = false; this._flush(); });
  }

  _flush() {
    if (this._flushing || !this._queue.length || !this.ready) return;
    const batch = this._queue;
    this._queue = [];
    this._flushing = true;
    this.call('frames', { reqs: batch.map((b) => ({ nodeId: b.nodeId, opts: b.opts })) })
      .then((r) => {
        r.frames.forEach((f, i) => {
          const b = batch[i];
          if (b.live) this._live.set(b.key, f);
          else this._pre.set(`${b.key}@${b.opts.at.toFixed(6)}`, f);
          this._inflight.delete(b.key);
        });
        this._trim();
      })
      .catch(() => { for (const b of batch) this._inflight.delete(b.key); })
      .finally(() => { this._flushing = false; if (this._queue.length) this._flush(); });
  }

  _trim() {
    if (this._pre.size <= PREFETCH_MAX) return;
    const drop = this._pre.size - PREFETCH_MAX;
    let i = 0;
    for (const k of this._pre.keys()) { if (i++ >= drop) break; this._pre.delete(k); }
  }

  /** Anything cached describes a graph that just changed. */
  _forget() {
    this._live.clear();
    this._pre.clear();
    this._inflight.clear();
    this._queue.length = 0;
  }
}

/** Options that change what is computed. `at` is not one — it keys the cache instead. */
function frameKey(nodeId, o) {
  return `${nodeId}|${o.bins || ''}|${o.window || ''}|${o.spanS || ''}|${o.trigger || ''}|${o.avg || ''}`;
}

function defaultUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}
