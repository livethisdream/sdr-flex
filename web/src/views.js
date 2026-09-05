// 2D canvas views: the spectrum trace that sits above the waterfall, plus the
// time-series and bit raster. All read their colours from CSS custom properties
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
  }

  setRange(a, b) { this.dbMin = a; this.dbMax = b; }
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
    const n = this.avg.length;
    const sx = W / (n - 1);

    c.strokeStyle = 'rgba(110,121,140,.16)';
    c.lineWidth = 1;
    for (let g = 1; g < 4; g++) {
      const gy = Math.round((H * g) / 4) + 0.5;
      c.beginPath(); c.moveTo(0, gy); c.lineTo(W, gy); c.stroke();
    }

    const path = (arr) => {
      c.beginPath();
      for (let i = 0; i < n; i++) { const px = i * sx, py = y(arr[i]); i ? c.lineTo(px, py) : c.moveTo(px, py); }
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

    let hi = 0;
    for (let i = 0; i < data.length; i++) if (data[i] > hi) hi = data[i];
    hi = Math.max(hi, 1e-6) * 1.15;
    const y = (v) => H - 4 * dpr - (v / hi) * (H - 10 * dpr);

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
  draw(bits) {
    if (!bits || !bits.length) { this.el.innerHTML = '<div class="empty">No bits yet — the burst train fires about once a second.</div>'; return; }
    const groups = [];
    let cur = [];
    for (const b of bits) {
      if (b === null) { if (cur.length) groups.push(cur); cur = []; } else cur.push(b);
    }
    if (cur.length) groups.push(cur);

    this.el.innerHTML = groups.slice(-6).map((g, i) => {
      const cells = g.map((b, j) => `<i class="${b ? 'one' : 'zero'}${j < 16 ? ' pre' : ''}"></i>`).join('');
      const hex = [];
      for (let k = 0; k + 8 <= g.length; k += 8) {
        hex.push(g.slice(k, k + 8).reduce((a, b) => (a << 1) | b, 0).toString(16).padStart(2, '0'));
      }
      return `<div class="brow"><span class="bn">#${i + 1}</span><span class="bits">${cells}</span><span class="bhex">${hex.join(' ')}</span></div>`;
    }).join('');
  }
}
