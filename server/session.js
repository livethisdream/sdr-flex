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

export const PROTOCOL = 1;

/** Sent as chunks rather than one reply, because a span can be hundreds of megabytes. */
const CHUNK_FLOATS = 1 << 20;

export class Session {
  constructor(conn, { library, log = () => {} }) {
    this.conn = conn;
    this.library = library;
    this.log = log;
    this.engine = new Engine({ latency: false });
    this.closed = false;

    conn.on('message', (buf) => this._onMessage(buf));
    conn.on('close', () => { this.closed = true; this.dispose(); });
  }

  dispose() {
    if (this.engine.capture && this.engine.capture.close) this.engine.capture.close();
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
      this._send(m === 'frames'
        ? { id, t: 'ok', v }
        : { id, t: 'ok', v, g: this.engine._snapshot() });
    } catch (e) {
      this.log(`${m} failed: ${e.stack || e.message}`);
      this._send({ id, t: 'err', e: e.message || String(e) });
    }
  }
}

const METHODS = {
  async hello() {
    return { protocol: PROTOCOL, engine: 'node', captures: !!this.library };
  },

  async createSession() {
    const root = await this.engine.createSession();
    return { root: root.id };
  },

  async listCaptures() {
    return { captures: this.library ? this.library.list() : [] };
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

  async sliceBytes({ nodeId, at }, id) {
    const r = await this.engine.sliceBytes(nodeId, (frac) => {
      this._send({ id, t: 'progress', v: frac });
    }, at);
    return r ? { sliced: strip(r) } : null;
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
