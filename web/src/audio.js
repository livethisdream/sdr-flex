// The audio sink.
//
// It is not a node. A detector produces a real-valued stream; listening to one is a
// subscription to that stream, the same way the spectrum view is a subscription —
// which is why gain and squelch live here and not on the detector (docs/09).
//
// Scheduling: the engine is time-indexed, so audio is pulled forward in contiguous
// chunks and queued back-to-back against the AudioContext clock. Pulling one buffer
// per animation frame and playing it immediately is the usual approach and it clicks
// on every frame the browser is late for; keeping a lead of a few hundred
// milliseconds costs that much latency and nothing else.

const CHUNK_S = 0.12;          // one pull
const LEAD_S = 0.32;           // how far ahead of the clock to stay queued
const MAX_LEAD_S = 0.6;        // beyond this we are ahead of the user, not the buffer

/** RMS as a 0..1 meter reading over a 60 dB range — a linear bar spends nine tenths
 *  of its travel on the loudest tenth of the signals, which is no meter at all. */
export function meterLevel(rms) {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(1, (db + 60) / 60));
}

export class AudioSink {
  constructor() {
    this.ctx = null;
    this.gainNode = null;
    this.nodeId = null;
    this.gain = 0.5;
    this.squelch = 0;          // 0 = off; otherwise an RMS floor below which we mute
    this.on = false;
    this._next = 0;            // AudioContext time the next chunk starts at
    this._srcT = 0;            // signal time the next chunk starts at
    this._busy = false;
    this.level = 0;            // last chunk's RMS, for the meter
    this.muted = false;        // squelch closed
  }

  /** Browsers only allow this from a gesture, so it is called from the button. */
  async start(engine, nodeId, atTime) {
    if (!this.ctx) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return false;
      this.ctx = new C();
      this.gainNode = this.ctx.createGain();
      this.gainNode.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.gainNode.gain.value = this.gain;
    this.nodeId = nodeId;
    this.on = true;
    this._next = 0;
    this._srcT = atTime;
    return true;
  }

  stop() {
    this.on = false;
    this.nodeId = null;
    this.level = 0;
    if (this.ctx) this.gainNode.gain.value = 0;
  }

  setGain(g) {
    this.gain = g;
    if (this.gainNode && this.on) this.gainNode.gain.value = g;
  }

  /**
   * Keep the queue full. Called once a frame; does nothing most of the time.
   *
   * `atTime` is where the engine's playhead is. If the queue has drifted away from
   * it — a scrub, a channel switch, a pause — the queue is abandoned rather than
   * played out, because audio that is three seconds behind the waterfall is worse
   * than a gap.
   */
  async pump(engine, atTime) {
    if (!this.on || !this.ctx || this._busy) return;
    const now = this.ctx.currentTime;
    if (this._next < now) { this._next = now + 0.02; this._srcT = atTime; }
    if (Math.abs(this._srcT - atTime) > MAX_LEAD_S) { this._next = now + 0.02; this._srcT = atTime; }
    if (this._next - now > LEAD_S) return;

    this._busy = true;
    try {
      const n = engine.node(this.nodeId);
      if (!n || n.out.kind !== 'real') { this.stop(); return; }
      const count = Math.max(256, Math.round(n.out.sampleRate * CHUNK_S));
      const got = await engine.readAudio(this.nodeId, this._srcT, count);
      if (!got || !this.on) return;

      // A browser will resample an arbitrary rate for us, which is exactly the
      // conversion we would otherwise write — and it is allowed to do it in the
      // audio thread.
      const rate = Math.max(3000, Math.min(768000, got.sampleRate));
      const buf = this.ctx.createBuffer(1, got.data.length, rate);
      const ch = buf.getChannelData(0);

      let sum = 0, dc = 0;
      for (let i = 0; i < got.data.length; i++) dc += got.data[i];
      dc /= got.data.length || 1;
      for (let i = 0; i < got.data.length; i++) {
        const v = got.data[i] - dc;        // AM sits on a pedestal; a speaker cannot use it
        ch[i] = v;
        sum += v * v;
      }
      this.level = Math.sqrt(sum / (got.data.length || 1));
      this.muted = this.squelch > 0 && this.level < this.squelch;

      // A detector's output scale varies by orders of magnitude between signals —
      // FM comes out normalized to its deviation, SSB comes out at whatever the
      // antenna gave it. One AGC at the sink, bringing everything to the same
      // loudness and soft-clipping what is left, beats a gain control on every
      // detector and a surprise at every channel change.
      const TARGET = 0.25, MAX_GAIN = 400;
      const g = this.muted ? 0 : Math.min(MAX_GAIN, TARGET / Math.max(this.level, 1e-6));
      for (let i = 0; i < ch.length; i++) ch[i] = Math.tanh(ch[i] * g);

      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.gainNode);
      src.start(this._next);
      this._next += buf.duration;
      this._srcT += got.data.length / got.sampleRate;
    } finally {
      this._busy = false;
    }
  }
}
