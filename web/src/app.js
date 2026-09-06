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
    this.tabs = new Map();         // channelId -> 'spectrum' | 'flow' | blockNodeId
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
    this.channel = root.id;        // where the breadcrumb is
    this.current = root.id;        // whose result is on screen
    this.vp(root.id);
    this.tabs.set(root.id, 'spectrum');
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
  /**
   * A *channel* is a node that carries IQ — the source, a tuner, a gate. Everything
   * downstream of one until the next channel is a *block*, and blocks are tabs rather
   * than places you navigate to: a channel is a workspace you stay in while you flip
   * between the results of what you applied to it.
   *
   * This is also exactly where the engine splits flowgraph fragments (ADR-0004), so
   * the unit of navigation and the unit of execution are the same thing.
   */
  isChannel(n) { return !!(n && n.out && n.out.kind === 'iq'); }

  blocksOf(channelId) {
    const out = [];
    const walk = (id) => {
      for (const c of this.engine.children(id)) {
        if (this.isChannel(c)) continue;      // that is a channel of its own
        out.push(c);
        walk(c.id);
      }
    };
    walk(channelId);
    return out;
  }

  tabKey() { return this.tabs.get(this.channel) || 'spectrum'; }

  setTab(key) {
    this.tabs.set(this.channel, key);
    this.current = (key === 'spectrum' || key === 'flow') ? this.channel : key;
  }

  view() {
    const k = this.tabKey();
    if (k === 'spectrum') return 'Spectrum';
    if (k === 'flow') return 'Flow';
    const n = this.engine.node(k);
    return n ? VIEWS[n.out.kind][0] : 'Spectrum';
  }

  // ── chrome ───────────────────────────────────────────────────────────────
  refresh() {
    this.renderCrumbs();
    this.renderTabs();
    this.renderStrip();
    this.renderStage();
    this.renderStatus();
  }

  renderStatus() {
    const ch = this.engine.node(this.channel);
    const n = this.node();
    const where = n.id === ch.id ? '' : ` › ${n.letter} · ${n.label}`;
    $('#status').innerHTML =
      `<span class="live">synthetic #0</span>` +
      `<span>${fmtHz(this.engine.root.out.centerHz)} MHz</span>` +
      `<span>${fmtRate(this.engine.root.out.sampleRate)}</span>` +
      `<span class="sp">${ch.op === 'core.source' ? ch.label : ch.letter + ' · ' + ch.label}` +
      ` · ${fmtRate(ch.out.sampleRate)}` +
      `${ch.params && ch.params.timeMode && ch.params.timeMode.value === 'pinned'
          ? ` · <b class="pin">pinned ${ch.params.t0.value.toFixed(2)}–${ch.params.t1.value.toFixed(2)} s</b>` : ''}` +
      `${where}</span>`;
  }

  renderCrumbs() {
    // Channels only — blocks are tabs, not destinations. Siblings stay on screen at
    // the current level: a set of channels off one source is the normal case
    // (UC-3 watches three at once), and losing them on selection makes the tool feel
    // like it forgot what you built.
    const cur = this.engine.node(this.channel);
    const ancestors = this.engine.path(this.channel).filter((n) => this.isChannel(n)).slice(0, -1);
    const siblings = cur.parent
      ? this.engine.children(cur.parent).filter((n) => this.isChannel(n))
      : [cur];
    const kids = this.engine.children(this.channel).filter((k) => this.isChannel(k));

    const name = (n) => (n.op === 'core.source' ? n.label : `${n.letter} · ${n.label}`);
    const el = $('#crumbs');
    let html = ancestors.map((n) =>
      `<button class="crumb" data-id="${n.id}">${name(n)}</button><span class="sepc">›</span>`).join('');

    html += `<span class="sibs">` + siblings.map((n) =>
      `<button class="crumb${n.id === this.channel ? ' cur' : ''}" data-id="${n.id}">${name(n)}</button>`
    ).join('') + `</span>`;

    if (kids.length) {
      html += '<span class="sepc">›</span>' + kids.map((k) =>
        `<button class="crumb dim" data-id="${k.id}">${name(k)}</button>`).join('');
    }
    el.innerHTML = html;

    for (const b of el.querySelectorAll('.crumb')) {
      b.addEventListener('click', () => { this.goChannel(b.dataset.id); });
    }
  }

  goChannel(id) {
    this.clearSelection();
    this._pinKey = null;
    this.trace.reset();
    this.channel = id;
    if (!this.tabs.has(id)) this.tabs.set(id, 'spectrum');
    this.setTab(this.tabKey());
    this.metrics.interaction();
    this.refresh();
  }

  renderTabs() {
    const blocks = this.blocksOf(this.channel);
    const key = this.tabKey();
    if (key !== 'spectrum' && key !== 'flow' && !blocks.some((b) => b.id === key)) this.setTab('spectrum');

    const items = [{ k: 'spectrum', label: 'Spectrum' }]
      .concat(blocks.map((b) => ({ k: b.id, label: `${b.letter} · ${b.label}`, kind: b.out.kind, ext: OPS[b.op] && OPS[b.op].external })))
      .concat([{ k: 'flow', label: 'Flow' }]);

    const ch = this.engine.node(this.channel);
    const chip = `<span class="chchip">${ch.op === 'core.source' ? ch.label : ch.letter + ' · ' + ch.label}</span>`;

    const el = $('#tabs');
    el.innerHTML = chip + items.map((it) =>
      `<button class="tab${it.k === this.tabKey() ? ' on' : ''}${it.ext ? ' ext' : ''}" data-k="${it.k}">` +
      `${it.label}${it.kind ? `<span class="tk">${it.kind}</span>` : ''}</button>`).join('') +
      '<button class="tab plus" title="operations valid here">+</button>';

    for (const b of el.querySelectorAll('.tab[data-k]')) {
      b.addEventListener('click', () => {
        this.clearSelection();
        this.setTab(b.dataset.k);
        this.metrics.interaction();
        this.refresh();
      });
    }
    el.querySelector('.plus').addEventListener('click', (e) => {
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
      m.addEventListener('click', (e) => { e.stopPropagation(); this.goChannel(m.dataset.id); });
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
      el.addEventListener('click', () => {
        const n = this.engine.node(el.dataset.id);
        if (this.isChannel(n)) { this.goChannel(n.id); return; }
        let ch = this.engine.node(n.parent);
        while (ch && !this.isChannel(ch)) ch = this.engine.node(ch.parent);
        this.clearSelection();
        if (ch) this.channel = ch.id;
        this.setTab(n.id);
        this.metrics.interaction();
        this.refresh();
      });
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
      const live = !n.params.timeMode || n.params.timeMode.value === 'live';
      for (const [key, pr] of Object.entries(n.params)) {
        if (live && (key === 't0' || key === 't1')) continue;
        const meta = {
          centerHz: { label: 'center', unit: 'MHz', fmt: fmtHz, step: 200, type: 'num' },
          widthHz: { label: 'width', unit: 'kHz', fmt: (v) => (v / 1e3).toFixed(1), step: 200, min: 1000, type: 'num' },
          decim: { label: 'decim', unit: '', fmt: (v) => String(v), step: 0.08, min: 1, max: 64, integer: true, type: 'num' },
          taps: { label: 'taps', unit: '', fmt: (v) => String(v), step: 0.4, min: 9, max: 255, integer: true, type: 'num' },
          timeMode: { label: 'window', unit: '', type: 'enum', values: ['live', 'pinned'], fmt: String },
          t0: { label: 'from', unit: 's', fmt: (v) => v.toFixed(3), step: 0.002, type: 'num' },
          t1: { label: 'to', unit: 's', fmt: (v) => v.toFixed(3), step: 0.002, type: 'num' },
          threshold: { label: 'threshold', unit: '', fmt: (v) => v.toFixed(3), step: 0.0006, min: 0, type: 'num' },
          symbolUs: { label: 'symbol', unit: 'µs', fmt: (v) => String(Math.round(v)), step: 0.7, min: 20, integer: true, type: 'num' },
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
        this.vp(node.id);
        if (this.isChannel(node)) {
          this.channel = node.id;              // a new channel is a new workspace
          this.tabs.set(node.id, 'spectrum');
          this.current = node.id;
          this.trace.reset();
        } else {
          this.setTab(node.id);                // a block is a tab on the one you are in
        }
        this._tsCache = null;
        this._bitsSeen = false;
        this.metrics.endOp();
        this.refresh();
      });
    });
  }

  /** Absolute time at a y pixel on the waterfall. */
  timeAtY(yPx, wfRect) {
    const p = this.vp(this.current);
    const spanS = this.waterfall.rows / Math.max(1, p.speed);
    const frac = Math.max(0, Math.min(1, (yPx - wfRect.top) / wfRect.height));
    return this.engine.effectiveTime(this.channel) - frac * spanS;
  }

  defaultSelection() {
    const n = this.node();
    const w = n.out.sampleRate / 8;
    return { f0: n.out.centerHz - w / 2, f1: n.out.centerHz + w / 2 };
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
      const wf = $('#wf').getBoundingClientRect();
      stage.setPointerCapture(e.pointerId);
      // the spectrum trace has no time axis, so a box there is frequency-only;
      // the waterfall has both, so a box there can pin a window too
      this.drag = { x0: e.clientX - r.left, y0: e.clientY, x1: e.clientX - r.left, y1: e.clientY,
                    r, wf, inWf: e.clientY >= wf.top };
      box.hidden = false;
      box.style.top = '';
      box.style.height = '';
      this.menu.close();
    });

    stage.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const d = this.drag;
      d.x1 = e.clientX - d.r.left;
      d.y1 = e.clientY;
      const a = Math.min(d.x0, d.x1), b = Math.max(d.x0, d.x1);
      box.style.left = a + 'px';
      box.style.width = Math.max(2, b - a) + 'px';
      if (d.inWf && Math.abs(d.y1 - d.y0) > 8) {
        const top = Math.max(d.wf.top, Math.min(d.y0, d.y1));
        const bot = Math.min(d.wf.bottom, Math.max(d.y0, d.y1));
        box.style.top = (top - d.r.top) + 'px';
        box.style.height = Math.max(2, bot - top) + 'px';
      } else {
        box.style.top = '';
        box.style.height = '';
      }
    });

    stage.addEventListener('pointerup', (e) => {
      if (!this.drag) return;
      const d = this.drag;
      this.drag = null;
      if (Math.abs(d.x1 - d.x0) < 6) { this.clearSelection(); return; }

      const n = this.node();
      const lo = n.out.centerHz - n.out.sampleRate / 2;
      const toHz = (px) => lo + (px / d.r.width) * n.out.sampleRate;
      const f0 = toHz(Math.min(d.x0, d.x1)), f1 = toHz(Math.max(d.x0, d.x1));

      let label = `${((f1 - f0) / 1e3).toFixed(1)} kHz`;
      const sel = { f0, f1 };
      if (d.inWf && Math.abs(d.y1 - d.y0) > 8) {
        const t0 = this.timeAtY(Math.max(d.y0, d.y1), d.wf);
        const t1 = this.timeAtY(Math.min(d.y0, d.y1), d.wf);
        sel.t0 = t0;
        sel.t1 = t1;
        label += ` · ${((t1 - t0) * 1e3).toFixed(0)} ms`;
      }
      this.selection = sel;
      box.dataset.label = label;
      box.classList.add('armed');

      this.metrics.beginOp();
      this.openMenu(e.clientX + 14, e.clientY + 14, this.selection);
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
      const pin = this.engine.isPinned(this.channel);
      const pinKey = pin ? `${pin.id}:${pin.params.t0.value}:${pin.params.t1.value}:${p.bins}:${p.window}` : null;

      if (pin) {
        // a pinned window does not scroll — paint it once as a fixed spectrogram
        if (this._pinKey !== pinKey) {
          this._pinKey = pinKey;
          const rows = this.waterfall.rows;
          const t0 = pin.params.t0.value, t1 = pin.params.t1.value;
          this.trace.reset();
          for (let i = 0; i < rows; i++) {
            const at = t0 + ((rows - 1 - i) / (rows - 1)) * (t1 - t0);
            const f = this.engine.frame(this.current, { bins: p.bins, window: p.window, at });
            if (f.kind === 'spectrum') { this.waterfall.push(f.data); this.trace.push(f.data); }
          }
        }
        this.trace.draw();
        this.waterfall.draw();
      } else {
        this._pinKey = null;
        const f = this.engine.frame(this.current, { bins: p.bins, window: p.window });
        if (f.kind === 'spectrum') {
          this.trace.push(f.data);
          this._rowAcc += dt / 1000;
          const interval = 1 / Math.max(1, p.speed);
          if (this._rowAcc >= interval) { this._rowAcc = 0; this.waterfall.push(f.data); }
          this.trace.draw();
          this.waterfall.draw();
        }
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
