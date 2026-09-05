// The friction contract, measured. Interaction count and pointer travel are budgets
// (<120 px per operation, <900 px for a full run), so the prototype counts them from
// the first commit rather than asserting them in a doc.

export class Metrics {
  constructor(el) {
    this.el = el;
    this.interactions = 0;
    this.totalTravel = 0;
    this.opTravel = 0;
    this.lastOpTravel = 0;
    this.frameTimes = [];
    this._last = null;
    this._opOpen = false;

    addEventListener('pointermove', (e) => {
      if (this._last) {
        const dx = e.clientX - this._last.x, dy = e.clientY - this._last.y;
        const d = Math.hypot(dx, dy);
        this.totalTravel += d;
        if (this._opOpen) this.opTravel += d;
      }
      this._last = { x: e.clientX, y: e.clientY };
    }, { passive: true });
  }

  /** A gesture that could become an operation has started (e.g. a drag released). */
  beginOp() { this._opOpen = true; this.opTravel = 0; }

  /** The operation completed — record what it cost. */
  endOp() {
    if (this._opOpen) { this.lastOpTravel = this.opTravel; this._opOpen = false; }
    this.interactions += 1;
    this.render();
  }

  interaction() { this.interactions += 1; this.render(); }

  frame(dtMs) {
    this.frameTimes.push(dtMs);
    if (this.frameTimes.length > 120) this.frameTimes.shift();
  }

  stats() {
    const f = this.frameTimes;
    if (f.length < 8) return { fps: 0, jitter: 0 };
    const mean = f.reduce((a, b) => a + b, 0) / f.length;
    const sorted = [...f].sort((a, b) => a - b);
    const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
    return { fps: 1000 / mean, jitter: Math.abs(p99 - mean) };
  }

  render() {
    if (!this.el) return;
    const s = this.stats();
    const travelOk = this.lastOpTravel === 0 || this.lastOpTravel < 120;
    const jitterOk = s.jitter < 4;
    this.el.innerHTML = `
      <span>interactions <b>${this.interactions}</b></span>
      <span>last op <b class="${travelOk ? 'ok' : 'bad'}">${Math.round(this.lastOpTravel)} px</b> <i>/ 120</i></span>
      <span>run <b class="${this.totalTravel < 900 ? 'ok' : 'bad'}">${Math.round(this.totalTravel)} px</b> <i>/ 900</i></span>
      <span>${s.fps.toFixed(1)} fps · jitter <b class="${jitterOk ? 'ok' : 'bad'}">${s.jitter.toFixed(1)} ms</b> <i>/ 4</i></span>`;
  }
}
