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

// Eight seconds, which is the number the workflow note has always used. Long enough for
// a packet protocol to repeat itself and short enough that trying every decoder is a
// wait rather than an errand.
const IDENTIFY_WINDOW_S = 8;

/**
 * Every input a node reads, in order, the first being the primary.
 *
 * `parent` keeps its name and keeps meaning the primary — it is the edge navigation
 * follows, so "parent" is exactly what it is — and `inputs` is the whole list for the
 * data flow. Renaming thirty-two call sites to `inputs[0]` would have said the same thing
 * and touched every read in the engine to do it.
 */
export function inputsOf(n) {
  if (!n) return [];
  if (n.inputs && n.inputs.length) return n.inputs;
  return n.parent ? [n.parent] : [];
}

export class Graph {
  constructor() {
    this.nodes = new Map();
    this.root = null;
    this.letters = 0;      // channels are named in creation order, not by op
    this.t = 0;            // playhead, seconds since scene start
    this.playing = true;
    this.ended = false;
    // A pinned clip has always looped — that is what makes a 40 ms burst watchable at
    // all. A whole capture stopping dead at its end was the odd one out, and on a
    // fixture two thirds of a second long it is the only thing you ever see.
    this.loop = true;
    // How fast the clock runs against the wall.
    //
    // Slowing a recording down is the oldest trick in listening to radio: a weak voice
    // through noise, or fast Morse, is legible at half speed when it is not at full.
    // It belongs on the *clock* rather than on the speaker, because everything here
    // follows the clock — the waterfall, the playhead, the decoders reading blocks as
    // it plays — and audio that slowed down on its own would simply drift away from
    // the picture of it.
    this.speed = 1;
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

  /**
   * How much signal `Identify` looks at.
   *
   * A pinned channel is a clip and the clip is the question, so that wins outright.
   * Otherwise a bounded window ending at the playhead, because this runs every decoder
   * that fits rather than one — eight resamples of a hundred seconds at 2 MS/s is
   * minutes of waiting for an answer the first eight seconds would have given. A
   * medium shorter than the window is taken whole, and the window is reported alongside
   * the results so a negative is readable: "nothing in these eight seconds" is a
   * different claim from "nothing in this capture", and only one of them is true.
   *
   * To ask about a different eight seconds, move the playhead — or pin the part you
   * mean, which is the gesture the tool already teaches.
   */
  identifyWindow(nodeId, now, seconds = IDENTIFY_WINDOW_S) {
    const pin = this.isPinned(nodeId);
    if (pin) return { t0: pin.params.t0.value, t1: pin.params.t1.value, pinned: true };
    const d = this.duration();
    if (isFinite(d)) {
      const t1 = Math.min(d, Math.max(now, seconds));
      return { t0: Math.max(0, t1 - seconds), t1, pinned: false };
    }
    // Live: the past is however far back the ring still goes (ADR-0005).
    const [first] = this.span();
    return { t0: Math.max(isFinite(first) ? first : 0, now - seconds), t1: now, pinned: false };
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

  /**
   * The nodes whose **primary** input is this one.
   *
   * This is the navigation question — "what did I make from this" — and it is what the
   * breadcrumb, the tab bar and the flow view's indentation are drawn from. A node with a
   * second input is not a child of that second one, because you did not get to it that
   * way (ADR-0038).
   */
  children(id) {
    return [...this.nodes.values()].filter((n) => n.parent === id);
  }

  /**
   * The nodes that **read** this one, by any input.
   *
   * A different question from `children`, and the two were the same until a node could
   * have two inputs. This is the one removal and invalidation want: a merge downstream of
   * a branch you are deleting has to go too, even though it lives in another part of the
   * tree and would never have been walked to from here.
   */
  consumers(id) {
    return [...this.nodes.values()].filter((n) => inputsOf(n).includes(id));
  }

  /** Every node that reads this one, directly or through others. */
  allConsumers(id) {
    const seen = new Set();
    const walk = (at) => {
      for (const c of this.consumers(at)) {
        if (seen.has(c.id)) continue;      // a diamond reaches the same node twice
        seen.add(c.id);
        walk(c.id);
      }
    };
    walk(id);
    return [...seen].map((i) => this.node(i)).filter(Boolean);
  }

  /**
   * Are this node's frequencies baseband offsets rather than RF?
   *
   * True once anything in the chain has been demodulated: a composite's 19 kHz is 19 kHz
   * from DC, and so is the 19 kHz of a tuner drawn on it. It decides the unit an axis is
   * labelled in and nothing else — the numbers themselves are already right either way,
   * which is the point of carrying `centerHz` through as provenance (ADR-0036).
   *
   * Derived by walking rather than stored, for the reason `delayOf` is: a stored copy
   * goes stale and `setParam` propagates one level.
   */
  isBaseband(id) {
    let n = this.node(id);
    while (n) {
      if (n.out && n.out.kind === 'real') return true;
      n = n.parent ? this.node(n.parent) : null;
    }
    return false;
  }

  /**
   * Could this node be the second input of that one?
   *
   * No if it is that node, and no if it reads it — directly or at any remove — because an
   * input that is downstream of the node asking for it is a cycle, and a cycle in this
   * engine is not an error message, it is `_detect` calling itself until the stack ends.
   * Refused when it is chosen rather than discovered at the next frame (ADR-0038).
   */
  canFeed(candidateId, nodeId) {
    if (candidateId === nodeId) return false;
    if (!this.node(candidateId)) return false;
    // A node still being built is not in the map yet, and nothing can be downstream of a
    // node that does not exist — so the answer is yes rather than "I cannot tell". Asking
    // the other way round returned false for every second input chosen at creation.
    if (!this.node(nodeId)) return true;
    return !this.allConsumers(nodeId).some((n) => n.id === candidateId);
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
    // Clamped against the wall rather than against the capture: a tab that was in the
    // background for a minute should not fast-forward a minute when it comes back, and
    // that is true whatever speed it is playing at.
    const step = Math.min(dt, 0.1) * (this.speed || 1);
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
        // Looping is not the same as running past the end: the clock wraps to the
        // start of the medium, so what scrolls past is the signal again rather than
        // silence forever, which is the thing that looks like a stall.
        if (this.loop && isFinite(d) && d > 0) {
          this.t = this.t % d;
          this.wrapped = (this.wrapped || 0) + 1;
        } else {
          this.t = d; this.playing = false; this.ended = true;
        }
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
   * Everything `_`-prefixed is the client's own and never travels — a clip's playhead,
   * a cached slice, a decoder's records. The snapshot deliberately omits those
   * (`_snapshot` strips them), so a swap that did not carry them over would throw away
   * state the server has no way to give back: a pinned view would jump to the start of
   * its box on every parameter change, and a pane that had just finished slicing would
   * find its results on an object nothing points at any more.
   */
  _adopt(snapshot) {
    const mine = new Map();
    for (const [id, n] of this.nodes) {
      const priv = {};
      for (const k of Object.keys(n)) if (k[0] === '_') priv[k] = n[k];
      if (Object.keys(priv).length) mine.set(id, priv);
    }
    this.nodes = new Map();
    for (const n of snapshot.nodes) {
      if (mine.has(n.id)) Object.assign(n, mine.get(n.id));
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
