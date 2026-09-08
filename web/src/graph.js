// The part of the engine that is not signal processing.
//
// Which node is where, what a node's time is, whether an ancestor pinned it, how the
// clock advances. None of it touches a sample, all of it is asked several times per
// animation frame, and the answers are needed *synchronously* — the client cannot
// wait a round trip to find out what to draw.
//
// So it lives here, and both engines extend it. The mock runs it beside the DSP; the
// remote client runs it against a mirror of the server's graph, kept current by the
// snapshot every mutating call returns. A graph is a few dozen nodes with a dozen
// parameters each — small enough that replacing it wholesale is cheaper, and far more
// obviously correct, than reconciling deltas.
//
// The consequence worth stating: the client owns the playhead. `tick` runs on the
// mirror, and every read the client asks for carries the absolute time it wants. The
// server therefore keeps no clock, which is why two clients cannot drag each other's
// playhead around and why a dropped connection loses nothing but pixels.

export class Graph {
  constructor() {
    this.nodes = new Map();
    this.root = null;
    this.letters = 0;      // channels are named in creation order, not by op
    this.t = 0;            // playhead, seconds since scene start
    this.playing = true;
    this.ended = false;
    this.capture = null;   // null means the synthetic scene
    this._last = performance.now();
  }

  /** How much signal there is, in seconds — a file ends, the scene does not. */
  duration() { return this.capture ? this.capture.durationS : Infinity; }

  /**
   * The moments a source can actually answer for, as [first, last] in seconds.
   *
   * A file's is its whole length and never moves. A live source's start moves forward
   * as the ring overwrites itself, so the earliest moment you can still look at is not
   * zero and does not stay put — which is the one way a live medium is genuinely not a
   * file, and the only place downstream has to know the difference (ADR-0030).
   */
  span() {
    const c = this.capture;
    if (!c) return [0, Infinity];
    if (!c.live) return [0, c.durationS];
    // On the server this is a radio and the window is a question you ask it; on the
    // client it is a snapshot and the window is two numbers that came over the wire.
    // Same graph code runs against both, so it accepts either.
    const w = typeof c.windowS === 'function' ? c.windowS() : c.windowS;
    return w || [0, c.durationS];
  }

  /** Is the source still being written? */
  isLive() { return !!(this.capture && this.capture.live); }

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

  isPinned(id) {
    let n = this.node(id);
    while (n) {
      const m = n.params && n.params.timeMode;
      if (m && m.value === 'pinned') return n;
      n = n.parent ? this.node(n.parent) : null;
    }
    return null;
  }

  /**
   * A pinned window is a clip, not a still frame — it has duration, so it plays.
   * Short bursts play slowed down, because an 80 ms window at 1× would loop a
   * dozen times a second and read as a strobe rather than a signal.
   */
  /** Derived so a window takes about four seconds to watch — overridable like anything else. */
  autoClipRate(n) {
    const d = Math.max(1e-4, n.params.t1.value - n.params.t0.value);
    return Math.min(1, d / 4);
  }

  clipRate(n) {
    const p = n.params.rate;
    if (p && p.mode === 'manual') return p.value;
    const v = this.autoClipRate(n);
    if (p) p.value = v;                  // keep the readout honest while auto
    return v;
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

  /** How much signal a node can see: its clip if pinned, else the whole capture. */
  _spanOf(nodeId) {
    const pin = this.isPinned(typeof nodeId === 'string' ? nodeId : nodeId.id);
    if (pin) return Math.max(1e-3, pin.params.t1.value - pin.params.t0.value);
    if (this.isLive()) { const [a, b] = this.span(); return Math.max(1e-3, b - a); }
    const d = this.duration();
    return isFinite(d) ? d : 2.0;
  }

  // ── transport ────────────────────────────────────────────────────────────
  tick() {
    const now = performance.now();
    const dt = (now - this._last) / 1000;
    this._last = now;
    const step = Math.min(dt, 0.1);
    if (this.playing) {
      this.t += step;
      const d = this.duration();
      // A file ends. Running the clock past it would scroll silence forever and look
      // exactly like a stall, so playback stops at the end and says so.
      //
      // A radio does not end — it just has not happened yet. The playhead rides the
      // head of the recording instead of stopping at it, and falls behind only when
      // the user scrubs back, which is the whole point of recording it.
      if (this.isLive()) {
        const [first, last] = this.span();
        if (this.t > last) this.t = last;
        // and it cannot sit on a moment that has been overwritten
        if (this.t < first) this.t = first;
      } else if (this.t >= d) {
        this.t = d; this.playing = false; this.ended = true;
      }
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

  /**
   * Replace the mirrored graph with the server's, keeping what is only the client's.
   *
   * `_t` is a clip's playhead and belongs to whoever is watching, so it survives the
   * swap; a snapshot that reset it would jump every pinned view back to the start of
   * its box on every parameter change.
   */
  _adopt(snapshot) {
    const keepT = new Map();
    for (const [id, n] of this.nodes) if (n._t != null) keepT.set(id, n._t);
    this.nodes = new Map();
    for (const n of snapshot.nodes) {
      if (keepT.has(n.id)) n._t = keepT.get(n.id);
      this.nodes.set(n.id, n);
    }
    this.root = snapshot.root ? this.nodes.get(snapshot.root) : null;
    this.letters = snapshot.letters;
    this.capture = snapshot.capture;
  }

  /** Everything the other side needs to answer the questions above. Sample-free. */
  _snapshot() {
    return {
      root: this.root ? this.root.id : null,
      letters: this.letters,
      capture: this.capture ? {
        label: this.capture.label, sampleRate: this.capture.sampleRate,
        centerHz: this.capture.centerHz, durationS: this.capture.durationS,
        format: this.capture.format, samples: this.capture.samples,
        // a live source is still being written, and says how far back it still goes
        live: !!this.capture.live,
        windowS: this.capture.live ? this.capture.windowS() : null,
        driver: this.capture.kind || null,
        status: this.capture.status || null,
      } : null,
      // `_`-prefixed fields are one side's private business: sliced byte caches,
      // plugin records and clip positions do not travel.
      nodes: [...this.nodes.values()].map((n) => {
        const out = {};
        for (const [k, v] of Object.entries(n)) if (k[0] !== '_') out[k] = v;
        return out;
      }),
    };
  }
}
