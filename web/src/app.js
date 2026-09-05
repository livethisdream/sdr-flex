// M0 shell. Breadcrumb, view tabs, stacked spectrum + waterfall on one shared axis,
// contextual menu on drag-release, cell strip. The engine behind it is the mock
// (ADR-0021) — the client cannot tell, which is the point.

import { MockEngine, OPS, LATENCY } from './engine.js';
import { Waterfall } from './waterfall.js';
import { SpectrumTrace, TimeSeries, BitRaster } from './views.js';
import { ContextMenu } from './menu.js';
import { Strip } from './strip.js';
import { Metrics } from './metrics.js';
import { COLORMAPS, cssGradient } from './colormap.js';
import { WINDOWS } from './dsp.js';

const $ = (s, r = document) => r.querySelector(s);
const fmtHz = (hz) => (hz / 1e6).toFixed(4);
const fmtRate = (r) => (r >= 1e6 ? (r / 1e6).toFixed(3) + ' MS/s' : (r / 1e3).toFixed(1) + ' kS/s');

const VIEWS = {
  iq: ['Spectrum', 'Flow'],
  real: ['Time', 'Flow'],
  bits: ['Bits', 'Time', 'Flow'],
  events: ['Events', 'Flow'],
};

const defaultViewParams = () => ({
  bins: 1024, window: 'Hann', avg: 4,
  dbMin: -74, dbMax: -18, colormap: 'Viridis', speed: 60,
  trigger: 'auto', spanS: 0.12,
});

class App {
  constructor() {
    this.engine = new MockEngine();
    this.viewParams = new Map();   // nodeId -> params
    this.activeView = new Map();   // nodeId -> view name
    this.selection = null;
    this.metrics = new Metrics($('#metrics'));
    this.menu = new ContextMenu(document.body);
    this.strip = new Strip($('#strip'), $('#tip'));
    this.waterfall = new Waterfall($('#wf'), 260);
    this.trace = new SpectrumTrace($('#sp'));
    this.timeSeries = new TimeSeries($('#ts'));
    this.bitRaster = new BitRaster($('#bits'));
    this._rowAcc = 0;
    this._lastFrame = performance.now();
  }

  async start() {
    const root = await this.engine.createSession();
    this.current = root.id;
    this.vp(root.id);
    this.activeView.set(root.id, 'Spectrum');
    this.wire();
    this.refresh();
    requestAnimationFrame((t) => this.loop(t));
  }

  vp(id) {
    if (!this.viewParams.has(id)) this.viewParams.set(id, defaultViewParams());
    return this.viewParams.get(id);
  }

  node() { return this.engine.node(this.current); }

  /**
   * A drag box belongs to the node it was drawn on. Carrying it to another node,
   * or another tab, would leave a coral rectangle sitting over pixels it does not
   * describe — so navigation always clears it.
   */
  clearSelection() {
    this.selection = null;
    const box = $('#selbox');
    box.hidden = true;
    box.classList.remove('armed');
  }
  view() { return this.activeView.get(this.current) || VIEWS[this.node().out.kind][0]; }

  // ── chrome ───────────────────────────────────────────────────────────────
  refresh() {
    this.renderCrumbs();
    this.renderTabs();
    this.renderStrip();
    this.renderStage();
    this.renderStatus();
  }

  renderStatus() {
    const n = this.node();
    $('#status').innerHTML =
      `<span class="live">synthetic #0</span>` +
      `<span>${fmtHz(this.engine.root.out.centerHz)} MHz</span>` +
      `<span>${fmtRate(this.engine.root.out.sampleRate)}</span>` +
      `<span class="sp">viewing ${n.label || 'source'} · ${n.out.kind} · ${fmtRate(n.out.sampleRate)}</span>`;
  }

  renderCrumbs() {
    const path = this.engine.path(this.current);
    const el = $('#crumbs');
    el.innerHTML = path.map((n, i) => {
      const sibs = this.engine.children(n.parent).length;
      const label = n.op === 'core.source' ? n.label : `${n.letter} · ${n.label}`;
      return `<button class="crumb${n.id === this.current ? ' cur' : ''}${OPS[n.op] && OPS[n.op].external ? ' ext' : ''}" data-id="${n.id}">${label}${sibs > 1 ? ' <i>▾</i>' : ''}</button>` +
        (i < path.length - 1 ? '<span class="sepc">›</span>' : '');
    }).join('');

    // children of the current node hang off the end, so the tree stays reachable
    const kids = this.engine.children(this.current);
    if (kids.length) {
      el.innerHTML += '<span class="sepc">›</span>' + kids.map((k) =>
        `<button class="crumb dim" data-id="${k.id}">${k.letter} · ${k.label}</button>`).join('');
    }

    for (const b of el.querySelectorAll('.crumb')) {
      b.addEventListener('click', () => { this.clearSelection(); this.current = b.dataset.id; this.metrics.interaction(); this.refresh(); });
    }
  }

  renderTabs() {
    const n = this.node();
    const views = VIEWS[n.out.kind] || ['Flow'];
    if (!views.includes(this.view())) this.activeView.set(n.id, views[0]);
    const el = $('#tabs');
    el.innerHTML = views.map((v) =>
      `<button class="tab${v === this.view() ? ' on' : ''}" data-v="${v}">${v}</button>`).join('') +
      '<button class="tab plus" title="operations valid here">+</button>';

    for (const b of el.querySelectorAll('.tab[data-v]')) {
      b.addEventListener('click', () => { this.clearSelection(); this.activeView.set(n.id, b.dataset.v); this.metrics.interaction(); this.refresh(); });
    }
    el.querySelector('.plus').addEventListener('click', async (e) => {
      const r = e.target.getBoundingClientRect();
      this.metrics.beginOp();
      this.openMenu(r.left, r.bottom + 4, null);
    });
  }

  renderStage() {
    const v = this.view();
    $('#pane-spectrum').hidden = v !== 'Spectrum';
    $('#pane-time').hidden = v !== 'Time';
    $('#pane-bits').hidden = v !== 'Bits';
    $('#pane-flow').hidden = v !== 'Flow';
    $('#pane-events').hidden = v !== 'Events';
    if (v === 'Spectrum') {
      const p = this.vp(this.current);
      $('#cbar').style.background = cssGradient(p.colormap);
      this.waterfall.setColormap(p.colormap);
      this.waterfall.setRange(p.dbMin, p.dbMax);
      this.trace.setRange(p.dbMin, p.dbMax);
      this.trace.avgN = p.avg;
      this.renderAxis();
      this.renderCbarLabels();
    }
    if (v === 'Spectrum') this.renderMarkers();
    if (v === 'Flow') this.renderFlow();
    if (v === 'Events') $('#pane-events').innerHTML = '<div class="empty">Event streams arrive with the external decoders at M4.5.</div>';
  }

  /**
   * Every child tuner is a band on this node's spectrum, labelled and clickable.
   * The analysis tree ought to be visible on the signal it describes, not only in
   * the breadcrumb — and it answers "what did that box I drew become?".
   */
  renderMarkers() {
    const n = this.node();
    const lo = n.out.centerHz - n.out.sampleRate / 2;
    const host = $('#markers');
    const kids = this.engine.children(n.id).filter((k) => k.params && k.params.centerHz && k.params.widthHz);
    host.innerHTML = kids.map((k) => {
      const w = k.params.widthHz.value;
      const left = ((k.params.centerHz.value - w / 2 - lo) / n.out.sampleRate) * 100;
      const width = (w / n.out.sampleRate) * 100;
      if (left > 100 || left + width < 0) return '';
      return `<button class="marker" data-id="${k.id}" style="left:${left}%;width:${width}%"
                title="${k.letter} · ${k.label}"><span>${k.letter}</span></button>`;
    }).join('');
    for (const m of host.querySelectorAll('.marker')) {
      m.addEventListener('pointerdown', (e) => e.stopPropagation());
      m.addEventListener('click', (e) => {
        e.stopPropagation();
        this.clearSelection();
        this.current = m.dataset.id;
        this.metrics.interaction();
        this.refresh();
      });
    }
  }

  renderAxis() {
    const n = this.node();
    const lo = n.out.centerHz - n.out.sampleRate / 2;
    const hi = n.out.centerHz + n.out.sampleRate / 2;
    $('#axis').innerHTML = [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const hz = lo + (hi - lo) * f;
      return `<span>${fmtHz(hz)}${f === 0.5 ? ' MHz' : ''}</span>`;
    }).join('');
  }

  /** The Time pane gets a real axis in ms, and says whether it is latched. */
  renderTimeAxis(f) {
    const el = $('#taxis');
    if (!el) return;
    const ms = f.spanS * 1e3;
    el.innerHTML = [0, 0.25, 0.5, 0.75, 1].map((k) => {
      const v = k * ms;
      return `<span>${v.toFixed(ms < 20 ? 2 : 1)}${k === 1 ? ' ms' : ''}</span>`;
    }).join('');
    const badge = $('#trig');
    if (badge) {
      badge.textContent = f.triggered ? `⊓ triggered · burst at ${f.t0.toFixed(3)} s` : '~ free-running';
      badge.className = 'trig' + (f.triggered ? ' on' : '');
    }
  }

  renderCbarLabels() {
    const p = this.vp(this.current);
    $('#cb-hi').textContent = `${Math.round(p.dbMax)} dBFS`;
    $('#cb-lo').textContent = `${Math.round(p.dbMin)}`;
  }

  renderFlow() {
    const walk = (id, depth) => {
      const n = this.engine.node(id);
      const spec = OPS[n.op];
      const kids = this.engine.children(id);
      return `<div class="fnode${id === this.current ? ' cur' : ''}${spec && spec.external ? ' ext' : ''}" style="margin-left:${depth * 22}px" data-id="${id}">
          <span class="fn">${n.op === 'core.source' ? n.label : `${n.letter} · ${n.label}`}</span>
          <span class="fk">${n.out.kind}</span>
          <span class="fr">${fmtRate(n.out.sampleRate)}</span>
        </div>` + kids.map((k) => walk(k.id, depth + 1)).join('');
    };
    $('#pane-flow').innerHTML =
      `<div class="flowwrap"><div class="flowhead">Compiled graph — read-only. Export to <code>.grc</code> arrives with the real engine at M1.</div>${walk(this.engine.root.id, 0)}</div>`;
    for (const el of $('#pane-flow').querySelectorAll('.fnode')) {
      el.addEventListener('click', () => { this.clearSelection(); this.current = el.dataset.id; this.metrics.interaction(); this.refresh(); });
    }
  }

  // ── strip ────────────────────────────────────────────────────────────────
  renderStrip() {
    const n = this.node();
    const p = this.vp(this.current);
    const groups = [];

    const nodeCells = [];
    if (n.op === 'core.source') {
      nodeCells.push(
        { key: 'centerHz', label: 'center', unit: 'MHz', type: 'ro', value: n.out.centerHz, fmt: fmtHz },
        { key: 'sampleRate', label: 'rate', unit: 'kS/s', type: 'ro', value: n.out.sampleRate, fmt: (v) => (v / 1e3).toFixed(0) });
    } else {
      for (const [key, pr] of Object.entries(n.params)) {
        const meta = {
          centerHz: { label: 'center', unit: 'MHz', fmt: fmtHz, step: 200, type: 'num' },
          widthHz: { label: 'width', unit: 'kHz', fmt: (v) => (v / 1e3).toFixed(1), step: 200, min: 1000, type: 'num' },
          decim: { label: 'decim', unit: '', fmt: (v) => String(v), step: 0.08, min: 1, max: 64, integer: true, type: 'num' },
          taps: { label: 'taps', unit: '', fmt: (v) => String(v), step: 0.4, min: 9, max: 255, integer: true, type: 'num' },
          threshold: { label: 'threshold', unit: '', fmt: (v) => v.toFixed(3), step: 0.0006, min: 0, type: 'num' },
          symbolUs: { label: 'symbol', unit: 'µs', fmt: (v) => String(Math.round(v)), step: 0.7, min: 20, integer: true, type: 'num' },
          t0: { label: 'from', unit: 's', fmt: (v) => v.toFixed(3), step: 0.002, type: 'num' },
          t1: { label: 'to', unit: 's', fmt: (v) => v.toFixed(3), step: 0.002, type: 'num' },
        }[key] || { label: key, unit: '', fmt: String, type: 'num', step: 1 };
        nodeCells.push({
          key, ...meta, value: pr.value, mode: pr.mode, canAuto: !!pr.auto,
          autoNote: pr.auto ? pr.auto.from : null,
          autoValue: pr.auto ? pr.auto.suggested ?? pr.auto.initial : null,
        });
      }
      nodeCells.push({ key: 'out', label: 'out', unit: 'kS/s', type: 'ro', value: n.out.sampleRate, fmt: (v) => (v / 1e3).toFixed(1) });
    }
    groups.push({ key: 'node', title: n.op === 'core.source' ? 'Source' : `${n.letter} · ${n.label}`, cells: nodeCells });

    if (this.view() === 'Time') {
      groups.push({
        key: 'view', title: 'Time',
        cells: [
          { key: 'trigger', label: 'trigger', unit: '', type: 'enum', value: p.trigger, values: ['auto', 'free'] },
          { key: 'spanS', label: 'span', unit: 'ms', type: 'num', value: p.spanS,
            fmt: (v) => (v * 1e3).toFixed(0), step: 0.0008, min: 0.002, max: 1.0 },
        ],
      });
    }

    if (this.view() === 'Spectrum') {
      groups.push({
        key: 'view', title: 'Spectrum + waterfall',
        cells: [
          { key: 'bins', label: 'fft', unit: 'bins', type: 'enum', value: String(p.bins), values: ['256', '512', '1024', '2048', '4096'] },
          { key: 'window', label: 'window', unit: '', type: 'enum', value: p.window, values: WINDOWS },
          { key: 'avg', label: 'avg', unit: 'frames', type: 'num', value: p.avg, fmt: (v) => String(v), step: 0.06, min: 1, max: 40, integer: true },
          { key: 'dbMin', label: 'min', unit: 'dBFS', type: 'num', value: p.dbMin, fmt: (v) => String(Math.round(v)), step: 0.35, min: -160, max: -10 },
          { key: 'dbMax', label: 'max', unit: 'dBFS', type: 'num', value: p.dbMax, fmt: (v) => String(Math.round(v)), step: 0.35, min: -150, max: 20 },
          { key: 'colormap', label: 'colormap', unit: '', type: 'enum', value: p.colormap, values: COLORMAPS },
          { key: 'speed', label: 'speed', unit: 'rows/s', type: 'num', value: p.speed, fmt: (v) => String(Math.round(v)), step: 0.35, min: 2, max: 120, integer: true },
        ],
      });
    }

    this.strip.render(groups);
    this.strip.onScrub = (g, k, v) => this.onParam(g, k, v);
    this.strip.onMode = (g, k, mode) => this.onMode(g, k, mode);
  }

  async onParam(group, key, value) {
    if (group === 'view') {
      const p = this.vp(this.current);
      if (key === 'bins') { p.bins = parseInt(value, 10); this.trace.reset(); }
      else if (key === 'window') p.window = value;
      else if (key === 'trigger') { p.trigger = value; this._tsCache = null; }
      else if (key === 'colormap') { p.colormap = value; this.waterfall.setColormap(value); $('#cbar').style.background = cssGradient(value); }
      else p[key] = value;
      if (key === 'dbMin' && p.dbMin > p.dbMax - 5) p.dbMin = p.dbMax - 5;
      if (key === 'dbMax' && p.dbMax < p.dbMin + 5) p.dbMax = p.dbMin + 5;
      this.waterfall.setRange(p.dbMin, p.dbMax);
      this.trace.setRange(p.dbMin, p.dbMax);
      this.trace.avgN = p.avg;
      this.renderCbarLabels();
      this.renderStrip();
      return;
    }
    const n = this.node();
    if (!n.params[key]) return;
    const wasAuto = n.params[key].mode === 'auto';
    if (wasAuto && n.params[key].auto) n.params[key].auto.suggested = n.params[key].value;
    await this.engine.setParam(this.current, key, value, 'manual');
    this.renderStrip();
    this.renderAxis();
    this.renderCrumbs();
  }

  async onMode(group, key, mode) {
    if (group === 'view') return;
    await this.engine.setMode(this.current, key, mode);
    this.metrics.interaction();
    this.renderStrip();
  }

  // ── selection + menu ─────────────────────────────────────────────────────
  openMenu(x, y, selection) {
    this.engine.palette(this.current).then((ops) => {
      const usable = selection ? ops : ops.filter((o) => !o.fromSelection);
      this.menu.open(x, y, usable.length ? usable : ops, async (opId) => {
        const sel = selection || this.defaultSelection();
        const node = await this.engine.addNode({ parent: this.current, op: opId, selection: sel });
        this.clearSelection();
        this.current = node.id;
        this.vp(node.id);
        this.metrics.endOp();
        this.trace.reset();
        this.refresh();
      });
    });
  }

  defaultSelection() {
    const n = this.node();
    const w = n.out.sampleRate / 8;
    return { f0: n.out.centerHz - w / 2, f1: n.out.centerHz + w / 2, t0: this.engine.t - 0.05, t1: this.engine.t };
  }

  wire() {
    const stage = $('#stage');
    const box = $('#selbox');

    // clicking the box you already drew reopens its menu, so dismissing it is not
    // a dead end with an orphaned rectangle and nowhere to go
    box.addEventListener('pointerdown', (e) => e.stopPropagation());
    box.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this.selection) return;
      const r = box.getBoundingClientRect();
      this.metrics.beginOp();
      this.openMenu(r.left + 8, r.bottom + 8, this.selection);
    });

    stage.addEventListener('pointerdown', (e) => {
      if (this.view() !== 'Spectrum') return;
      if (e.target.closest('#cbar-wrap') || e.target.closest('#markers')) return;
      const r = stage.getBoundingClientRect();
      const x0 = e.clientX - r.left;
      stage.setPointerCapture(e.pointerId);
      this.drag = { x0, x1: x0, r };
      box.hidden = false;
      this.menu.close();
    });

    stage.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      this.drag.x1 = e.clientX - this.drag.r.left;
      const a = Math.min(this.drag.x0, this.drag.x1), b = Math.max(this.drag.x0, this.drag.x1);
      box.style.left = a + 'px';
      box.style.width = Math.max(2, b - a) + 'px';
    });

    stage.addEventListener('pointerup', (e) => {
      if (!this.drag) return;
      const { x0, x1, r } = this.drag;
      this.drag = null;
      if (Math.abs(x1 - x0) < 6) { box.hidden = true; return; }

      const n = this.node();
      const lo = n.out.centerHz - n.out.sampleRate / 2;
      const toHz = (px) => lo + (px / r.width) * n.out.sampleRate;
      const f0 = toHz(Math.min(x0, x1)), f1 = toHz(Math.max(x0, x1));
      this.selection = { f0, f1, t0: this.engine.t - 0.05, t1: this.engine.t };
      box.dataset.label = `${((f1 - f0) / 1e3).toFixed(1)} kHz`;
      box.classList.add('armed');
      this._menuAt = { x: e.clientX + 14, y: e.clientY + 14 };

      // the gesture completes itself: the menu opens where the drag was released
      this.metrics.beginOp();
      this.openMenu(this._menuAt.x, this._menuAt.y, this.selection);
    });

    // colour bar: dragging the handles is where dB range lives (ADR-0019, tier A)
    const cb = $('#cbar-wrap');
    cb.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      const r = cb.getBoundingClientRect();
      const p = this.vp(this.current);
      const frac = 1 - (e.clientY - r.top) / r.height;
      const which = frac > 0.5 ? 'dbMax' : 'dbMin';
      cb.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const f = Math.max(0, Math.min(1, 1 - (ev.clientY - r.top) / r.height));
        const v = -160 + f * 180;
        p[which] = which === 'dbMax' ? Math.max(v, p.dbMin + 5) : Math.min(v, p.dbMax - 5);
        this.waterfall.setRange(p.dbMin, p.dbMax);
        this.trace.setRange(p.dbMin, p.dbMax);
        this.renderCbarLabels();
        this.renderStrip();
      };
      const up = () => { cb.removeEventListener('pointermove', move); cb.removeEventListener('pointerup', up); };
      cb.addEventListener('pointermove', move);
      cb.addEventListener('pointerup', up);
    });

    $('#play').addEventListener('click', () => {
      this.engine.playing = !this.engine.playing;
      $('#play').textContent = this.engine.playing ? '❚❚' : '▶';
      this.metrics.interaction();
    });

    addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.key === ' ') { e.preventDefault(); $('#play').click(); }
      if (e.key === '/') { e.preventDefault(); this.metrics.beginOp(); const r = $('#stage').getBoundingClientRect(); this.openMenu(r.left + r.width / 2, r.top + 60, this.selection); }
      if (e.key === 'Escape') { this.clearSelection(); this.menu.close(); }
    });

    addEventListener('resize', () => this.renderStage());
  }

  // ── loop ─────────────────────────────────────────────────────────────────
  loop(ts) {
    const dt = ts - this._lastFrame;
    this._lastFrame = ts;
    this.metrics.frame(dt);
    this.engine.tick();

    const v = this.view();
    const p = this.vp(this.current);

    if (v === 'Spectrum') {
      const f = this.engine.frame(this.current, { bins: p.bins, window: p.window });
      if (f.kind === 'spectrum') {
        this.trace.push(f.data);
        this._rowAcc += dt / 1000;
        const interval = 1 / Math.max(1, p.speed);
        if (this._rowAcc >= interval) { this._rowAcc = 0; this.waterfall.push(f.data); }
        this.trace.draw();
        this.waterfall.draw();
      }
    } else if (v === 'Time') {
      // a triggered display is latched, so it is recomputed a few times a second
      // and simply redrawn in between — free-run still needs every frame
      this._tsAcc = (this._tsAcc || 0) + dt;
      const live = p.trigger === 'free';
      if (live || this._tsAcc > 220 || !this._tsCache) {
        this._tsAcc = 0;
        const f = this.engine.frame(this.current, { spanS: p.spanS, trigger: p.trigger });
        if (f.kind === 'timeseries') {
          const n = this.node();
          this.timeSeries.threshold = null;
          for (const c of this.engine.children(n.id)) if (c.op === 'core.pwm_slicer') this.timeSeries.threshold = c.params.threshold.value;
          this._tsCache = f;
        } else if (f.kind === 'bits') {
          this.timeSeries.threshold = this.node().params.threshold.value;
          this._tsCache = { data: f.env, spanS: f.env.length / f.sampleRate, t0: this.engine.t - f.env.length / f.sampleRate, triggered: false };
        }
      }
      if (this._tsCache) {
        this.timeSeries.draw(this._tsCache.data, this._tsCache.spanS);
        this.renderTimeAxis(this._tsCache);
      }
    } else if (v === 'Bits') {
      // decoded records do not need 60 fps, and a one-second window is expensive
      this._bitsAcc = (this._bitsAcc || 0) + dt;
      if (this._bitsAcc > 250 || !this._bitsSeen) {
        this._bitsAcc = 0;
        this._bitsSeen = true;
        const f = this.engine.frame(this.current, {});
        if (f.kind === 'bits') this.bitRaster.draw(f.groups, f.symbolUs);
      }
    }

    $('#clock').textContent = this.engine.t.toFixed(3) + ' s';
    requestAnimationFrame((t) => this.loop(t));
  }
}

new App().start().catch((e) => {
  document.body.innerHTML = `<pre class="fatal">${e && e.stack ? e.stack : e}</pre>`;
});

export { LATENCY };
