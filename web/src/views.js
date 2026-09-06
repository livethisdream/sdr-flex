// 2D canvas views: the spectrum trace that sits above the waterfall, plus the
// time-series and bit raster. All read their colors from CSS custom properties
// so there is one palette.

function css(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function fit(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  return dpr;
}

export class SpectrumTrace {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.avg = null;
    this.peak = null;
    this.dbMin = -74;
    this.dbMax = -18;
    this.avgN = 4;
    this.showPeak = true;
    this.viewLo = 0;
    this.viewHi = 1;
  }

  setRange(a, b) { this.dbMin = a; this.dbMax = b; }
  setViewRange(lo, hi) { this.viewLo = lo; this.viewHi = hi; }
  reset() { this.avg = null; this.peak = null; }

  push(row) {
    if (!this.avg || this.avg.length !== row.length) {
      this.avg = Float32Array.from(row);
      this.peak = Float32Array.from(row);
      return;
    }
    const a = 1 / Math.max(1, this.avgN);
    for (let i = 0; i < row.length; i++) {
      this.avg[i] += (row[i] - this.avg[i]) * a;
      this.peak[i] = Math.max(this.peak[i] - 0.06, row[i]);
    }
  }

  draw() {
    const c = this.ctx;
    const dpr = fit(this.canvas);
    const W = this.canvas.width, H = this.canvas.height;
    c.fillStyle = css('--stage', '#05070B');
    c.fillRect(0, 0, W, H);
    if (!this.avg) return;

    const span = Math.max(this.dbMax - this.dbMin, 0.001);
    const y = (db) => H - 3 * dpr - ((Math.min(Math.max(db, this.dbMin), this.dbMax) - this.dbMin) / span) * (H - 8 * dpr);
    const total = this.avg.length;
    const i0 = Math.max(0, Math.floor(this.viewLo * total));
    const i1 = Math.min(total, Math.ceil(this.viewHi * total));
    const n = Math.max(2, i1 - i0);
    const sx = W / (n - 1);

    c.strokeStyle = 'rgba(110,121,140,.16)';
    c.lineWidth = 1;
    for (let g = 1; g < 4; g++) {
      const gy = Math.round((H * g) / 4) + 0.5;
      c.beginPath(); c.moveTo(0, gy); c.lineTo(W, gy); c.stroke();
    }

    const path = (arr) => {
      c.beginPath();
      for (let i = 0; i < n; i++) {
        const px = i * sx, py = y(arr[i0 + i]);
        i ? c.lineTo(px, py) : c.moveTo(px, py);
      }
    };

    if (this.showPeak) {
      path(this.peak);
      c.strokeStyle = 'rgba(110,121,140,.62)';
      c.lineWidth = 1 * dpr;
      c.stroke();
    }

    path(this.avg);
    c.lineTo(W, H); c.lineTo(0, H); c.closePath();
    c.fillStyle = 'rgba(33,145,140,.20)';
    c.fill();

    path(this.avg);
    c.strokeStyle = css('--trace', '#D2E8E3');
    c.lineWidth = 1.2 * dpr;
    c.stroke();
  }
}

export class TimeSeries {
  constructor(canvas) { this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.threshold = null; }
  draw(data, spanS) {
    const c = this.ctx;
    const dpr = fit(this.canvas);
    const W = this.canvas.width, H = this.canvas.height;
    c.fillStyle = css('--stage', '#05070B');
    c.fillRect(0, 0, W, H);
    if (!data || !data.length) return;

    // An envelope has a floor at zero and belongs against it; a demodulated audio
    // waveform swings both ways and belongs about its own zero line. Drawing the
    // second against a zero baseline throws away half of it — which is what a
    // detector's output looked like before the audio detectors arrived.
    let hi = -Infinity, lo = Infinity;
    for (let i = 0; i < data.length; i++) { const v = data[i]; if (v > hi) hi = v; if (v < lo) lo = v; }
    const bipolar = lo < -Math.max(1e-9, hi * 0.02);
    const pad = 5 * dpr;
    let y;
    if (bipolar) {
      const amp = Math.max(Math.abs(lo), Math.abs(hi), 1e-6) * 1.1;
      const mid = H / 2;
      y = (v) => mid - (v / amp) * (H / 2 - pad);
      c.strokeStyle = css('--rule-lo', '#1B2130');
      c.lineWidth = 1 * dpr;
      c.beginPath(); c.moveTo(0, mid); c.lineTo(W, mid); c.stroke();
    } else {
      const top = Math.max(hi, 1e-6) * 1.15;
      y = (v) => H - 4 * dpr - (v / top) * (H - 10 * dpr);
    }

    // min/max envelope per pixel column — how a long capture draws at 2000 px
    const per = data.length / W;
    c.strokeStyle = css('--trace', '#D2E8E3');
    c.lineWidth = 1 * dpr;
    c.beginPath();
    for (let x = 0; x < W; x++) {
      let lo = Infinity, up = -Infinity;
      const s = Math.floor(x * per), e = Math.min(data.length, Math.floor((x + 1) * per) + 1);
      for (let i = s; i < e; i++) { if (data[i] < lo) lo = data[i]; if (data[i] > up) up = data[i]; }
      if (lo === Infinity) continue;
      c.moveTo(x + 0.5, y(lo)); c.lineTo(x + 0.5, y(up));
    }
    c.stroke();

    if (this.threshold != null) {
      const ty = y(this.threshold);
      c.strokeStyle = css('--accent', '#FF7A5C');
      c.setLineDash([4 * dpr, 4 * dpr]);
      c.beginPath(); c.moveTo(0, ty); c.lineTo(W, ty); c.stroke();
      c.setLineDash([]);
    }
  }
}

export class BitRaster {
  constructor(el) { this.el = el; }

  /** groups: [{ bits, t, durationS }] — each one burst, located in source time. */
  draw(groups, symbolUs) {
    if (!groups || !groups.length) {
      this.el.innerHTML =
        '<div class="empty">Nothing sliced yet. The burst train fires about once a second — ' +
        'if this stays empty, the threshold or symbol period in the strip below is wrong.</div>';
      return;
    }

    const rows = groups.slice(-8).reverse().map((g) => {
      const hex = [];
      for (let k = 0; k + 8 <= g.bits.length; k += 8) {
        hex.push(g.bits.slice(k, k + 8).reduce((a, b) => (a << 1) | b, 0).toString(16).padStart(2, '0'));
      }
      const tail = g.bits.length % 8;
      const cells = g.bits.map((b, j) =>
        `<i class="${b ? 'one' : 'zero'}${j === 15 ? ' mark' : ''}"></i>`).join('');
      return `<tr>
        <td class="bt">${g.t.toFixed(3)}</td>
        <td class="bc">${g.bits.length}</td>
        <td class="bd">${(g.durationS * 1e3).toFixed(1)}</td>
        <td class="bp"><span class="bits">${cells}</span></td>
        <td class="bh">${hex.join(' ')}${tail ? ` <span class="rem">+${tail}b</span>` : ''}</td>
      </tr>`;
    }).join('');

    this.el.innerHTML = `
      <table class="bits-table">
        <thead><tr>
          <th>time · s</th><th>bits</th><th>ms</th>
          <th>pattern <span class="key"><i class="one"></i>1 <i class="zero"></i>0</span></th>
          <th>hex</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="bits-foot">One row per burst, newest first · ${symbolUs ? symbolUs + ' µs/symbol' : ''}
        · the tick after bit 16 marks the end of the preamble</div>`;
  }
}
