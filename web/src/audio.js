// The audio sink's runtime.
//
// The sink itself is a node in the graph (ADR-0027) — this is just the machinery
// that keeps a browser's audio clock fed. One entry per `core.audio` node, each with
// its own gain, which is what makes several audible channels a mixer rather than a
// special case.
//
// Scheduling: the engine is time-indexed, so audio is pulled forward in contiguous
// chunks and queued back-to-back against the AudioContext clock. Pulling one buffer
// per animation frame and playing it immediately is the usual approach and it clicks
// on every frame the browser is late for; keeping a lead of a few hundred
// milliseconds costs that much latency and nothing else.

const CHUNK_S = 0.12;          // one pull
const LEAD_S = 0.32;           // how far ahead of the clock to stay queued
const MAX_DRIFT_S = 0.6;       // beyond this the queue is stale, not merely behind

/** RMS as a 0..1 meter reading over a 60 dB range — a linear bar spends nine tenths
 *  of its travel on the loudest tenth of the signals, which is no meter at all. */
export function meterLevel(rms) {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(1, (db + 60) / 60));
}

export class AudioMixer {
  constructor() {
    this.ctx = null;
    this.voices = new Map();     // nodeId → { gain, next, srcT, level, muted, busy }
  }

  get count() { return this.voices.size; }
  has(id) { return this.voices.has(id); }
  voice(id) { return this.voices.get(id) || null; }
  level(id) { const v = this.voices.get(id); return v ? v.level : 0; }
  isMuted(id) { const v = this.voices.get(id); return !!(v && v.muted); }

  /**
   * Browsers only open an AudioContext from a gesture. Adding a Listen node is one,
   * which is the nicest possible answer: the thing that starts the audio is the same
   * thing that says audio should exist.
   */
  async add(id, atTime, volume = 0.5) {
    if (this.voices.has(id)) return true;
    if (!this.ctx) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return false;
      this.ctx = new C();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    gain.connect(this.ctx.destination);
    this.voices.set(id, { gain, next: 0, srcT: atTime, level: 0, muted: false, busy: false });
    return true;
  }

  remove(id) {
    const v = this.voices.get(id);
    if (!v) return;
    try { v.gain.disconnect(); } catch (e) { /* already gone */ }
    this.voices.delete(id);
  }

  removeAll() { for (const id of [...this.voices.keys()]) this.remove(id); }

  setVolume(id, value) {
    const v = this.voices.get(id);
    if (v) v.gain.gain.value = value;
  }

  /**
   * Keep every voice's queue full. Called once a frame; does nothing most of the time.
   *
   * `timeOf(id)` gives the engine playhead for that node. If a queue has drifted away
   * from it — a scrub, a pause, a pinned clip looping — it is abandoned rather than
   * played out, because audio three seconds behind the waterfall is worse than a gap.
   */
  pump(engine, timeOf) {
    if (!this.ctx) return;
    for (const [id, v] of this.voices) this._pumpOne(engine, id, v, timeOf(id));
  }

  async _pumpOne(engine, id, v, atTime) {
    if (v.busy || atTime == null) return;
    const now = this.ctx.currentTime;
    if (v.next < now || Math.abs(v.srcT - atTime) > MAX_DRIFT_S) { v.next = now + 0.02; v.srcT = atTime; }
    if (v.next - now > LEAD_S) return;

    v.busy = true;
    try {
      const n = engine.node(id);
      const src = n && engine.node(n.parent);
      if (!src || src.out.kind !== 'real') { this.remove(id); return; }
      const count = Math.max(256, Math.round(src.out.sampleRate * CHUNK_S));
      const got = await engine.readAudio(src.id, v.srcT, count);
      if (!got || !this.voices.has(id)) return;

      // A browser will resample an arbitrary rate for us, which is exactly the
      // conversion we would otherwise write — and it is allowed to do it in the
      // audio thread.
      const rate = Math.max(3000, Math.min(768000, got.sampleRate));
      const buf = this.ctx.createBuffer(1, got.data.length, rate);
      const ch = buf.getChannelData(0);

      let dc = 0;
      for (let i = 0; i < got.data.length; i++) dc += got.data[i];
      dc /= got.data.length || 1;
      let sum = 0;
      for (let i = 0; i < got.data.length; i++) {
        const x = got.data[i] - dc;         // AM sits on a pedestal; a speaker cannot use it
        ch[i] = x;
        sum += x * x;
      }
      v.level = Math.sqrt(sum / (got.data.length || 1));
      const squelch = (n.params.squelch && n.params.squelch.value) || 0;
      v.muted = squelch > 0 && v.level < squelch;

      // A detector's output scale varies by orders of magnitude between signals — FM
      // comes out normalized to its deviation, SSB comes out at whatever the antenna
      // gave it. One AGC at the sink, bringing everything to the same loudness and
      // soft-clipping what is left, beats a gain control on every detector and a
      // surprise at every channel change.
      const TARGET = 0.25, MAX_GAIN = 400;
      const g = v.muted ? 0 : Math.min(MAX_GAIN, TARGET / Math.max(v.level, 1e-6));
      for (let i = 0; i < ch.length; i++) ch[i] = Math.tanh(ch[i] * g);

      const node = this.ctx.createBufferSource();
      node.buffer = buf;
      node.connect(v.gain);
      node.start(v.next);
      v.next += buf.duration;
      v.srcT += got.data.length / got.sampleRate;
    } finally {
      v.busy = false;
    }
  }
}
