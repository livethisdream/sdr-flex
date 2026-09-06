// M0 shell. Breadcrumb, view tabs, stacked spectrum + waterfall on one shared axis,
// contextual menu on drag-release, cell strip. The engine behind it is the mock
// (ADR-0021) — the client cannot tell, which is the point.

import { MockEngine, OPS, LATENCY } from './engine.js';
import { Waterfall } from './waterfall.js';
import { SpectrumTrace, TimeSeries, BitRaster } from './views.js';
import { ContextMenu } from './menu.js';
import { Strip } from './strip.js';
import { Metrics } from './metrics.js';
import { AudioSink, meterLevel } from './audio.js';
import { COLORMAPS, cssGradient } from './colormap.js';
import { WINDOWS } from './dsp.js';

const $ = (s, r = document) => r.querySelector(s);
const fmtHz = (hz) => (hz / 1e6).toFixed(4);
const fmtRate = (r) => (r >= 1e6 ? (r / 1e6).toFixed(3) + ' MS/s' : (r / 1e3).toFixed(1) + ' kS/s');

// The spectrum trace is redrawn every animation frame, but it does not need a
// freshly computed spectrum every time: 25 a second reads as continuous and
// costs a third of what 60 does. Waterfall rows keep their own clock on top.
const SPEC_PERIOD = 1 / 25;

const VIEWS = {
  iq: ['Spectrum', 'Flow'],
  real: ['Time', 'Flow'],
  bits: ['Bits', 'Time', 'Flow'],
  events: ['Events', 'Flow'],
};

const defaultViewParams = () => ({
  bins: 1024, window: 'Hann', avg: 4,
  dbMin: -74, dbMax: -18, dbAuto: true, colormap: 'Viridis', speed: 60,
  trigger: 'auto', spanS: 0.12,
  zoomLo: 0, zoomHi: 1,
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
    this.audio = new AudioSink();
    this._rowAcc = 0;
    this._tmax = 0;                       // the furthest the session has played to
    this.split = 0.34;
    try { const v = parseFloat(localStorage.getItem('sdrflex.split')); if (v > 0) this.split = v; } catch (_) { /* private mode */ }
    this._specAcc = 0;
    this._specData = null;
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
    if (!this.viewParams.has(id)) {
      const p = defaultViewParams();
      // A trigger latches onto an amplitude edge, which is what you want for a
      // keyed signal and nonsense for continuous audio: an FM channel has no edges
      // to find, so an armed trigger just shows a window that never settles.
      const n = this.engine.node(id);
      if (n && (n.op === 'core.fm_discriminator' || n.op === 'core.ssb' || n.op === 'core.cw')) {
        p.trigger = 'free';
        p.spanS = 0.04;
      }
      this.viewParams.set(id, p);
    }
    return this.viewParams.get(id);
  }

  node() { return this.engine.node(this.current); }

  /**
   * A drag box belongs to the node it was drawn on. Carrying it to another node,
   * or another tab, would leave a coral rectangle sitting over pixels it does not
   * describe — so navigation always clears it.
   */
  clearSelection() {
    // the freeze existed so the drag could mean something; it should not outlive it
    if (this._frozeForDrag) { this._frozeForDrag = false; this.setPlaying(true); }
    this.selection = null;
    const box = $('#selbox');
    box.hidden = true;
    box.classList.remove('armed', 'clamped');
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

  /** How a node is written down. Only channels carry a letter (engine.addNode). */
  tag(n) { return n.letter ? `${n.letter} · ${n.label}` : n.label; }

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
    // the subscription is to one node's output, so leaving that node ends it
    if (this.audio.on && key !== this.tabKey()) this.audio.stop();
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
    this.renderTopbar();
    this.renderTabs();
    this.renderStrip();
    this.renderStage();
    this.renderListen();
  }

  /**
   * One row for "what radio, and where am I in it". The device *is* the root of the
   * path, so its facts live on the root crumb rather than in a second bar: naming the
   * source twice and the current channel three times was the top of the screen
   * describing itself instead of the signal.
   */
  renderTopbar() {
    const root = this.engine.root;
    const cur = this.engine.node(this.channel);
    const ancestors = this.engine.path(this.channel).filter((n) => this.isChannel(n)).slice(0, -1);
    const siblings = cur.parent
      ? this.engine.children(cur.parent).filter((n) => this.isChannel(n))
      : [cur];
    const kids = this.engine.children(this.channel).filter((k) => this.isChannel(k));

    const pin = (n) => (n.params && n.params.timeMode && n.params.timeMode.value === 'pinned'
      ? ` <b class="pin" title="pinned ${n.params.t0.value.toFixed(2)}–${n.params.t1.value.toFixed(2)} s">⊓</b>` : '');
    const crumb = (n, cls) =>
      `<button class="crumb ${cls}" data-id="${n.id}">${this.tag(n)}${pin(n)}` +
      (cls === 'cur' && n.id !== root.id
        ? `<i class="x" data-del="${n.id}" role="button" tabindex="0" title="remove ${this.tag(n)} and everything under it">✕</i>` : '') +
      `</button>`;

    // The device's center and rate are its node's parameters, so they live in the
    // strip when the source is selected. Repeating them here made the top row a
    // second readout of something already on screen.
    let html =
      `<button class="dev${this.channel === root.id ? ' cur' : ''}" data-id="${root.id}">` +
      `<span class="live"></span>${root.label}</button>`;

    for (const n of ancestors) {
      if (n.id === root.id) continue;
      html += `<span class="sepc">›</span>` + crumb(n, '');
    }
    if (!(siblings.length === 1 && siblings[0].id === root.id)) {
      html += `<span class="sepc">›</span><span class="sibs">` +
        siblings.map((n) => crumb(n, n.id === this.channel ? 'cur' : '')).join('') + `</span>`;
    }
    if (kids.length) {
      html += `<span class="sepc">›</span>` + kids.map((k) => crumb(k, 'dim')).join('');
    }

    const el = $('#topbar');
    el.innerHTML = html;
    for (const b of el.querySelectorAll('[data-id]')) {
      b.addEventListener('click', () => { this.goChannel(b.dataset.id); });
    }
    this.wireRemove(el);
  }

  /**
   * Removal lives on the thing being removed, and only while it is the current one.
   * An ✕ on every crumb and every tab is a row of ways to lose work; an ✕ on the
   * one you are looking at is the answer to "how do I get rid of this?" in the
   * place the question is asked.
   */
  wireRemove(el) {
    for (const x of el.querySelectorAll('[data-del]')) {
      x.addEventListener('click', (e) => { e.stopPropagation(); this.removeNode(x.dataset.del); });
      x.addEventListener('pointerdown', (e) => e.stopPropagation());
      x.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); this.removeNode(x.dataset.del); }
      });
    }
  }

  /**
   * Take a node and everything downstream of it out of the graph, then land
   * somewhere that still exists: the parent channel, on its own spectrum.
   */
  async removeNode(id) {
    const n = this.engine.node(id);
    if (!n || n.id === this.engine.root.id) return;
    const parent = n.parent;
    this.metrics.beginOp();
    this.clearSelection();
    this.strip.closePop();
    await this.engine.removeNode(id);
    let ch = this.engine.node(parent);
    while (ch && !this.isChannel(ch)) ch = this.engine.node(ch.parent);
    this.channel = (ch || this.engine.root).id;
    this.tabs.delete(id);
    this.setTab('spectrum');
    this.resetSpectrum();
    this._tsCache = null;
    this._bitsSeen = false;
    this.metrics.endOp();
    this.refresh();
  }

  goChannel(id) {
    if (this.audio.on) this.audio.stop();
    this.clearSelection();
    this.channel = id;
    this.resetSpectrum();
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
      .concat(blocks.map((b) => ({ k: b.id, label: this.tag(b), kind: b.out.kind, del: b.id, ext: OPS[b.op] && OPS[b.op].external })))
      .concat([{ k: 'flow', label: 'Flow' }]);

    const el = $('#tabs');
    el.innerHTML = items.map((it) =>
      `<button class="tab${it.k === this.tabKey() ? ' on' : ''}${it.ext ? ' ext' : ''}" data-k="${it.k}">` +
      `${it.label}${it.kind ? `<span class="tk">${it.kind}</span>` : ''}` +
      (it.del && it.k === this.tabKey()
        ? `<i class="x" data-del="${it.del}" role="button" tabindex="0" title="remove ${it.label} and everything after it">✕</i>` : '') +
      `</button>`).join('') +
      '<button class="tab plus" title="operations valid here">+</button>';

    this.wireRemove(el);
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
      this.waterfall.setViewRange(p.zoomLo, p.zoomHi);
      this.trace.setViewRange(p.zoomLo, p.zoomHi);
      this.trace.avgN = p.avg;
      this.renderAxis();
      this.renderCbarLabels();
    }
    if (v === 'Spectrum') this.renderMarkers();
    if (v === 'Flow') this.renderFlow();
    if (v === 'Events') $('#pane-events').innerHTML = '<div class="empty">Event streams arrive with the external decoders at M4.5.</div>';
  }

  /**
   * Every child tuner is a band on this node's spectrum, labeled and clickable.
   * The analysis tree ought to be visible on the signal it describes, not only in
   * the breadcrumb — and it answers "what did that box I drew become?".
   */
  renderMarkers() {
    const n = this.node();
    const { lo, hi } = this.viewHz();
    const span = hi - lo;
    const host = $('#markers');
    const kids = this.engine.children(n.id).filter((k) => k.params && k.params.centerHz && k.params.widthHz);
    host.innerHTML = kids.map((k) => {
      const w = k.params.widthHz.value;
      const left = ((k.params.centerHz.value - w / 2 - lo) / span) * 100;
      const width = (w / span) * 100;
      if (left > 100 || left + width < 0) return '';
      return `<button class="marker" data-id="${k.id}" style="left:${left}%;width:${width}%"
                title="${this.tag(k)}"><span>${k.letter}</span></button>`;
    }).join('');
    for (const m of host.querySelectorAll('.marker')) {
      m.addEventListener('pointerdown', (e) => e.stopPropagation());
      m.addEventListener('click', (e) => { e.stopPropagation(); this.goChannel(m.dataset.id); });
    }
  }

  /** The frequency window currently on screen, in Hz. */
  viewHz() {
    const n = this.node();
    const p = this.vp(this.current);
    const lo = n.out.centerHz - n.out.sampleRate / 2;
    return {
      lo: lo + p.zoomLo * n.out.sampleRate,
      hi: lo + p.zoomHi * n.out.sampleRate,
    };
  }

  renderAxis() {
    const { lo, hi } = this.viewHz();
    const p = this.vp(this.current);
    const z = 1 / Math.max(1e-6, p.zoomHi - p.zoomLo);
    $('#axis').innerHTML = [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const hz = lo + (hi - lo) * f;
      return `<span>${fmtHz(hz)}${f === 0.5 ? ' MHz' : ''}</span>`;
    }).join('') + (z > 1.02 ? `<span class="zoomtag">${z.toFixed(1)}×</span>` : '');
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
          <span class="fn">${this.tag(n)}</span>
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
        if (ch && ch.id !== this.channel) { this.channel = ch.id; this.resetSpectrum(); }
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
        if (live && (key === 't0' || key === 't1' || key === 'rate')) continue;
        const meta = {
          centerHz: { label: 'center', unit: 'MHz', fmt: fmtHz, step: 200, type: 'num' },
          widthHz: { label: 'width', unit: 'kHz', fmt: (v) => (v / 1e3).toFixed(1), step: 200, min: 1000, type: 'num' },
          decim: { label: 'decim', unit: '', fmt: (v) => String(v), step: 0.08, min: 1, max: 64, integer: true, type: 'num' },
          taps: { label: 'taps', unit: '', fmt: (v) => String(v), step: 0.4, min: 9, max: 255, integer: true, type: 'num' },
          timeMode: { label: 'window', unit: '', type: 'enum', values: ['live', 'pinned'], fmt: String },
          rate: { label: 'rate', unit: '×', type: 'num', fmt: (v) => (v < 0.1 ? v.toFixed(3) : v.toFixed(2)),
                  step: 0.0012, min: 0.001, max: 4, logish: true },
          t0: { label: 'from', unit: 's', fmt: (v) => v.toFixed(3), step: 0.002, type: 'num' },
          t1: { label: 'to', unit: 's', fmt: (v) => v.toFixed(3), step: 0.002, type: 'num' },
          threshold: { label: 'threshold', unit: '', fmt: (v) => v.toFixed(3), step: 0.0006, min: 0, type: 'num' },
          symbolUs: { label: 'symbol', unit: 'µs', fmt: (v) => String(Math.round(v)), step: 0.7, min: 20, integer: true, type: 'num' },
          deviationHz: { label: 'deviation', unit: 'Hz', fmt: (v) => String(Math.round(v)), step: 12, min: 100, integer: true, type: 'num' },
          sideband: { label: 'sideband', unit: '', type: 'enum', values: ['usb', 'lsb'], fmt: String },
          bfoHz: { label: 'bfo', unit: 'Hz', fmt: (v) => String(Math.round(v)), step: 1.5, min: -3000, max: 3000, integer: true, type: 'num' },
          offsetHz: { label: 'offset', unit: 'Hz', fmt: (v) => String(Math.round(v)), step: 2.5, integer: true, type: 'num' },
          pitchHz: { label: 'pitch', unit: 'Hz', fmt: (v) => String(Math.round(v)), step: 2, min: 200, max: 2000, integer: true, type: 'num' },
          gain: { label: 'gain', unit: '×', fmt: (v) => (v < 10 ? v.toFixed(1) : String(Math.round(v))), step: 0.02, min: 0.1, max: 60, type: 'num' },
        }[key] || { label: key, unit: '', fmt: String, type: 'num', step: 1 };
        nodeCells.push({
          key, ...meta, value: pr.value, mode: pr.mode, canAuto: !!pr.auto,
          autoNote: pr.auto ? pr.auto.from : null,
          autoValue: pr.auto ? pr.auto.suggested ?? pr.auto.initial : null,
        });
      }
      nodeCells.push({ key: 'out', label: 'out', unit: 'kS/s', type: 'ro', value: n.out.sampleRate, fmt: (v) => (v / 1e3).toFixed(1) });
    }
    groups.push({ key: 'node', title: n.op === 'core.source' ? 'src' : (n.letter || n.label), cells: nodeCells });

    if (this.view() === 'Time') {
      groups.push({
        key: 'view', title: 'view',
        cells: [
          { key: 'trigger', label: 'trigger', unit: '', type: 'enum', value: p.trigger, values: ['auto', 'free'] },
          { key: 'spanS', label: 'span', unit: 'ms', type: 'num', value: p.spanS,
            fmt: (v) => (v * 1e3).toFixed(0), step: 0.0008, min: 0.002, max: 1.0 },
        ],
      });
    }

    if (this.view() === 'Spectrum') {
      groups.push({
        key: 'view', title: 'view',
        cells: [
          { key: 'bins', label: 'fft', unit: 'bins', type: 'enum', value: String(p.bins), values: ['256', '512', '1024', '2048', '4096'] },
          { key: 'colormap', label: 'colormap', unit: '', type: 'enum', value: p.colormap, values: COLORMAPS },
          { key: 'speed', label: 'speed', unit: 'rows/s', type: 'num', value: p.speed, fmt: (v) => String(Math.round(v)), step: 0.35, min: 2, max: 120, integer: true },
          { key: 'dbMin', label: 'min', unit: 'dBFS', type: 'num', value: p.dbMin, fmt: (v) => String(Math.round(v)), step: 0.35, min: -160, max: -10,
            canAuto: true, mode: p.dbAuto ? 'auto' : 'manual', autoNote: 'the tenth percentile of what is on screen' },
          { key: 'dbMax', label: 'max', unit: 'dBFS', type: 'num', value: p.dbMax, fmt: (v) => String(Math.round(v)), step: 0.35, min: -150, max: 20,
            canAuto: true, mode: p.dbAuto ? 'auto' : 'manual', autoNote: 'the strongest bin on screen' },
          { key: 'window', label: 'window', unit: '', type: 'enum', value: p.window, values: WINDOWS },
          { key: 'avg', label: 'avg', unit: 'frames', type: 'num', value: p.avg, fmt: (v) => String(v), step: 0.06, min: 1, max: 40, integer: true },
        ],
      });
    }

    // Listening is a subscription to this node, so its controls belong with the
    // node's — but only while it is running. A volume slider on a silent tool is a
    // control for something that is not happening.
    if (this.audio.on) {
      groups.push({
        key: 'audio', title: 'listen',
        cells: [
          { key: 'gain', label: 'volume', unit: '', type: 'num', value: this.audio.gain,
            fmt: (v) => (v * 100).toFixed(0) + '%', step: 0.004, min: 0, max: 1 },
          { key: 'squelch', label: 'squelch', unit: '', type: 'num', value: this.audio.squelch,
            fmt: (v) => (v > 0 ? v.toFixed(3) : 'off'), step: 0.0004, min: 0, max: 0.4 },
        ],
      });
    }

    this.strip.render(groups);
    this.strip.onScrub = (g, k, v) => this.onParam(g, k, v);
    this.strip.onMode = (g, k, mode) => this.onMode(g, k, mode);
  }

  async onParam(group, key, value) {
    if (group === 'audio') {
      if (key === 'gain') this.audio.setGain(value);
      else this.audio.squelch = value;
      this.renderStrip();
      return;
    }
    if (group === 'view') {
      const p = this.vp(this.current);
      if (key === 'bins') { p.bins = parseInt(value, 10); this.resetSpectrum(); }
      else if (key === 'window') p.window = value;
      else if (key === 'trigger') { p.trigger = value; this._tsCache = null; }
      else if (key === 'spanS') { p.spanS = value; this._tsCache = null; }
      else if (key === 'colormap') { p.colormap = value; this.waterfall.setColormap(value); $('#cbar').style.background = cssGradient(value); }
      else p[key] = value;
      if (key === 'dbMin' || key === 'dbMax') p.dbAuto = false;
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
    if (group === 'view') {
      if (key === 'dbMin' || key === 'dbMax') {
        this.vp(this.current).dbAuto = mode === 'auto';
        this.renderStrip();
      }
      return;
    }
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
          this.resetSpectrum();
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

  /**
   * Wipe the spectrum display and refill it with *this* channel's past.
   *
   * Clearing alone would leave several seconds of empty waterfall after every
   * switch. The history is not lost, though — a source is a time-indexed medium
   * (ADR-0005), so the engine can be asked for any past moment. The rows are
   * recomputed a few per frame so the switch stays responsive.
   */
  resetSpectrum() {
    this.trace.reset();
    this.waterfall.clear();
    this._rowAcc = 0;
    this._specAcc = 0;
    this._specData = null;
    const p = this.vp(this.current);
    const span = this.waterfall.rows / Math.max(1, p.speed);
    this._prefill = {
      row: 0,
      rows: this.waterfall.rows,
      t1: this.engine.effectiveTime(this.channel),
      span,
    };
  }

  /**
   * The moment one prefill row should show. Rows go in oldest first, so row 0 is
   * the far end of the history and the last row is the present.
   *
   * A pinned channel has no history outside the box the user drew, so the fill
   * walks backwards through the clip and wraps at its edges — the same samples
   * the clip is about to replay, in the order it will replay them.
   */
  prefillTime(pf, pin) {
    const frac = pf.rows > 1 ? pf.row / (pf.rows - 1) : 1;
    if (!pin) return Math.max(0, pf.t1 - pf.span * (1 - frac));
    const t0 = pin.params.t0.value;
    const d = Math.max(1e-4, pin.params.t1.value - t0);
    const back = pf.span * this.engine.clipRate(pin) * (1 - frac);
    return t0 + (((pf.t1 - back - t0) % d) + d) % d;
  }

  /**
   * Says what the stage is doing when it is not doing the obvious thing. A pinned
   * window and a paused clock both look identical to a broken display otherwise —
   * a static waterfall with no explanation reads as "nothing is playing".
   */
  /**
   * A sensible dB window for this data.
   *
   * Narrowing a channel narrows its FFT bins, so its noise floor sits ten or more
   * dB below the source's. A range inherited from the parent leaves a tuner
   * rendering entirely under the colormap floor — indistinguishable from a display
   * that has stopped. So the range is derived per channel, like everything else
   * that can be (ADR-0017), and pinned the moment the user touches it.
   */
  fitRange(data) {
    const s = Float32Array.from(data).sort();
    const n = s.length;
    const floor = s[(n * 0.10) | 0];
    const peak = s[n - 1];
    const lo = floor - 4;
    const hi = Math.max(peak + 6, lo + 25);
    return { lo, hi };
  }

  applyAutoRange(data, snap) {
    const p = this.vp(this.current);
    if (!p.dbAuto || !data) return;
    const { lo, hi } = this.fitRange(data);
    const k = snap ? 1 : 0.12;
    p.dbMin += (lo - p.dbMin) * k;
    p.dbMax += (hi - p.dbMax) * k;
    this.waterfall.setRange(p.dbMin, p.dbMax);
    this.trace.setRange(p.dbMin, p.dbMax);
    this.renderCbarLabels();
  }

  setStageBadge(text) {
    const el = $('#stagebadge');
    if (!el) return;
    el.textContent = text;
    el.hidden = !text;
    el.classList.toggle('pin', text.startsWith('⊓'));
  }

  setPlaying(on) {
    this.engine.playing = on;
    const b = $('#play');
    b.textContent = on ? '❚❚' : '▶';
    b.classList.toggle('paused', !on);
  }

  /**
   * The listen button exists when the current node has something to listen to, and
   * says what it is doing while it does it: lit when on, dimmed while the squelch
   * holds it closed, with a level bar so silence is distinguishable from failure.
   */
  renderListen() {
    const el = $('#listen');
    if (!el) return;
    const n = this.node();
    const can = !!(n && n.out && n.out.kind === 'real');
    el.hidden = !can;
    if (!can && this.audio.on) this.audio.stop();
    el.classList.toggle('on', this.audio.on);
    el.classList.toggle('sq', this.audio.muted);
    el.title = this.audio.on ? 'stop listening' : 'listen';
    const lvl = el.querySelector('.lvl');
    if (lvl) {
      const v = this.audio.on ? meterLevel(this.audio.level) : 0;
      lvl.style.transform = `scaleX(${v.toFixed(3)})`;
    }
  }

  /** The spectrum's share of the stage. The waterfall takes what is left. */
  setSplit(frac) {
    this.split = Math.max(0.1, Math.min(0.85, frac));
    $('#stage').style.setProperty('--split', (this.split * 100).toFixed(1) + '%');
  }

  /**
   * Where the scrubber's handle sits, and what moving it means.
   *
   * A pinned channel is a clip, so the rail is the clip: end to end is the box the
   * user drew. Everything else runs from the start of the session to the furthest
   * it has reached — the source is time-indexed (ADR-0005), so the past is not a
   * recording that had to be kept, it is simply an argument.
   */
  scrubSpan() {
    const pin = this.engine.isPinned(this.channel);
    if (pin) return { t0: pin.params.t0.value, t1: pin.params.t1.value, pin };
    return { t0: 0, t1: Math.max(0.001, this._tmax), pin: null };
  }

  scrubFrac() {
    const { t0, t1, pin } = this.scrubSpan();
    const at = pin ? this.engine.clipPos(pin) : this.engine.t;
    return Math.max(0, Math.min(1, (at - t0) / Math.max(1e-6, t1 - t0)));
  }

  scrubTo(frac) {
    const { t0, t1, pin } = this.scrubSpan();
    const at = t0 + (t1 - t0) * frac;
    if (pin) pin._t = at;
    else this.engine.t = Math.max(0, at);
    $('#clock').textContent = at.toFixed(3) + ' s';
    $('#track i').style.left = (frac * 100).toFixed(2) + '%';
  }

  /** Keyboard zoom works about the center, since there is no pointer to anchor to. */
  zoomKey(factor) {
    if (this.view() !== 'Spectrum') return;
    const p = this.vp(this.current);
    const width = p.zoomHi - p.zoomLo;
    const center = (p.zoomLo + p.zoomHi) / 2;
    const w = Math.min(1, Math.max(1 / 512, width * factor));
    let lo = Math.max(0, Math.min(1 - w, center - w / 2));
    p.zoomLo = lo;
    p.zoomHi = lo + w;
    this.renderStage();
  }

  /**
   * Does this drag mean to constrain time?
   *
   * A hand wobbles. Treating a few pixels of vertical drift as a time selection
   * turned ordinary frequency drags into pinned channels — which are static by
   * design, so the tuner looked broken. A time gesture has to be deliberate:
   * clearly vertical in absolute terms, and a real fraction of the box's width.
   */
  /**
   * The y below which the waterfall holds no samples yet. A time box must stop
   * there: dragging into blank rows would ask to pin a window that never existed,
   * and silently dropping the request is worse than not letting it be made.
   */
  historyEdgeY(wfRect) {
    const frac = Math.min(1, this.waterfall.filled / this.waterfall.rows);
    return wfRect.top + frac * wfRect.height;
  }

  wantsTime(d) {
    if (!d.inWf) return false;
    const dy = Math.abs(d.y1 - d.y0);
    const dx = Math.abs(d.x1 - d.x0);
    return dy > 24 && dy > dx * 0.25;
  }

  /**
   * Absolute time at a y pixel on the waterfall, clamped to history that exists.
   * Only the filled rows correspond to real samples; the rest is the colormap floor.
   */
  timeAtY(yPx, wfRect) {
    const p = this.vp(this.current);
    const rows = this.waterfall.rows;
    const filled = Math.max(1, this.waterfall.filled);
    const now = this.engine.effectiveTime(this.channel);
    const frac = Math.max(0, Math.min(1, (yPx - wfRect.top) / wfRect.height));
    const secsPerRow = 1 / Math.max(1, p.speed);
    const back = Math.min(frac * rows, filled) * secsPerRow;
    return Math.max(0, now - back);
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
      try { stage.setPointerCapture(e.pointerId); } catch (err) { /* not an active pointer */ }
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
      if (!this.drag || this.pinch) return;
      const d = this.drag;
      d.x1 = e.clientX - d.r.left;
      d.y1 = e.clientY;
      const a = Math.min(d.x0, d.x1), b = Math.max(d.x0, d.x1);
      box.style.left = a + 'px';
      box.style.width = Math.max(2, b - a) + 'px';
      if (this.wantsTime(d)) {
        // Selecting time on a scrolling waterfall is not hard, it is incoherent: the
        // rows move under the pointer while you drag, so the box lands on samples
        // that were never inside it. The moment a drag acquires a time extent, the
        // display freezes — no mode to learn, and the burst stops running away.
        if (this.engine.playing) { this.setPlaying(false); this._frozeForDrag = true; }
        const edge = this.historyEdgeY(d.wf);
        const top = Math.max(d.wf.top, Math.min(d.y0, d.y1));
        const bot = Math.min(edge, Math.max(d.y0, d.y1));
        box.style.top = (top - d.r.top) + 'px';
        box.style.height = Math.max(2, bot - top) + 'px';
        box.classList.toggle('clamped', Math.max(d.y0, d.y1) > edge + 2);
      } else {
        box.style.top = '';
        box.style.height = '';
      }
    });

    stage.addEventListener('pointerup', (e) => {
      if (!this.drag || this.pinch) { this.drag = null; return; }
      const d = this.drag;
      this.drag = null;
      if (Math.abs(d.x1 - d.x0) < 6) { this.clearSelection(); return; }

      const { lo, hi } = this.viewHz();
      const toHz = (px) => lo + (px / d.r.width) * (hi - lo);
      const f0 = toHz(Math.min(d.x0, d.x1)), f1 = toHz(Math.max(d.x0, d.x1));

      let label = `${((f1 - f0) / 1e3).toFixed(1)} kHz`;
      const sel = { f0, f1 };
      if (this.wantsTime(d)) {
        const edge = this.historyEdgeY(d.wf);
        const t0 = this.timeAtY(Math.min(edge, Math.max(d.y0, d.y1)), d.wf);
        const t1 = this.timeAtY(Math.min(d.y0, d.y1), d.wf);
        // only pin over history that exists; a window before the capture began
        // would pin the channel to nothing at all
        if (t1 - t0 > 0.002) {
          sel.t0 = t0;
          sel.t1 = t1;
          label += ` · ${((t1 - t0) * 1e3).toFixed(0)} ms`;
        }
      }
      this.selection = sel;
      box.dataset.label = label;
      box.classList.add('armed');

      this.metrics.beginOp();
      this.openMenu(e.clientX + 14, e.clientY + 14, this.selection);
    });

    // walking away from the menu should leave the app as it found it
    this.menu.onClose = () => {
      if (this._frozeForDrag) { this._frozeForDrag = false; this.setPlaying(true); }
    };

    // ── zoom: a view transform on the axis, not a change to the signal ──────
    const MIN_SPAN = 1 / 512;                 // never past a couple of FFT bins

    const applyZoom = (factor, anchorFrac) => {
      const p = this.vp(this.current);
      const width = p.zoomHi - p.zoomLo;
      const anchor = p.zoomLo + anchorFrac * width;
      let w = Math.min(1, Math.max(MIN_SPAN, width * factor));
      let lo = anchor - anchorFrac * w;
      lo = Math.max(0, Math.min(1 - w, lo));
      p.zoomLo = lo;
      p.zoomHi = lo + w;
      this.renderStage();
    };

    const panBy = (fracOfWindow) => {
      const p = this.vp(this.current);
      const w = p.zoomHi - p.zoomLo;
      let lo = Math.max(0, Math.min(1 - w, p.zoomLo + fracOfWindow * w));
      p.zoomLo = lo;
      p.zoomHi = lo + w;
      this.renderStage();
    };

    const resetZoom = () => {
      const p = this.vp(this.current);
      p.zoomLo = 0; p.zoomHi = 1;
      this.renderStage();
    };
    this.resetZoom = resetZoom;

    stage.addEventListener('wheel', (e) => {
      if (this.view() !== 'Spectrum') return;
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      const at = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      if (e.shiftKey) panBy(e.deltaY * 0.0015);
      else applyZoom(e.deltaY > 0 ? 1.18 : 1 / 1.18, at);
    }, { passive: false });

    stage.addEventListener('dblclick', () => { if (this.view() === 'Spectrum') resetZoom(); });

    // pinch: two pointers set both the scale and where it is anchored
    const pts = new Map();
    const pinchState = () => {
      const [a, b] = [...pts.values()];
      const r = stage.getBoundingClientRect();
      return {
        dist: Math.abs(a.x - b.x) || 1,
        mid: Math.max(0, Math.min(1, ((a.x + b.x) / 2 - r.left) / r.width)),
      };
    };
    stage.addEventListener('pointerdown', (e) => {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        // a second finger means zoom, not selection — abandon any box in progress
        this.drag = null;
        $('#selbox').hidden = true;
        this.pinch = pinchState();
      }
    });
    const endPointer = (e) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) this.pinch = null;
    };
    stage.addEventListener('pointerup', endPointer);
    stage.addEventListener('pointercancel', endPointer);
    stage.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2 && this.pinch) {
        const now = pinchState();
        const factor = this.pinch.dist / now.dist;
        if (isFinite(factor) && factor > 0) applyZoom(factor, now.mid);
        this.pinch = now;
      }
    });

    // color bar: dragging the handles is where dB range lives (ADR-0019, tier A)
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
        p.dbAuto = false;
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

    // ── splitter ───────────────────────────────────────────────────────────
    // How much room the spectrum gets against the waterfall is a matter of what you
    // are doing — reading a modulation shape wants the trace, watching for a burst
    // wants the history — so it is a layout preference, kept per browser (ADR-0019),
    // not a signal parameter.
    const split = $('#splitter');
    this.setSplit(this.split);
    split.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      split.setPointerCapture(e.pointerId);
      split.classList.add('drag');
      const stageEl = $('#stage');
      const move = (ev) => {
        const r = stageEl.getBoundingClientRect();
        this.setSplit((ev.clientY - r.top) / r.height);
      };
      const up = () => {
        split.classList.remove('drag');
        split.removeEventListener('pointermove', move);
        split.removeEventListener('pointerup', up);
        try { localStorage.setItem('sdrflex.split', String(this.split)); } catch (_) { /* private mode */ }
        this.metrics.interaction();
      };
      split.addEventListener('pointermove', move);
      split.addEventListener('pointerup', up);
    });

    // ── scrubber ───────────────────────────────────────────────────────────
    const track = $('#track');
    track.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      track.setPointerCapture(e.pointerId);
      track.classList.add('drag');
      // scrubbing is looking, not playing: the clock stops and stays stopped
      this.setPlaying(false);
      const at = (ev) => {
        const r = track.getBoundingClientRect();
        this.scrubTo(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)));
      };
      at(e);
      const up = () => {
        track.classList.remove('drag');
        track.removeEventListener('pointermove', at);
        track.removeEventListener('pointerup', up);
        // one refill at the end, not one per pixel
        this.resetSpectrum();
        this._tsCache = null;
        this._bitsSeen = false;
        this.metrics.interaction();
      };
      track.addEventListener('pointermove', at);
      track.addEventListener('pointerup', up);
    });

    // ── listen ─────────────────────────────────────────────────────────────
    // A browser will only open an AudioContext from a gesture, so the button is the
    // only place this can start — which is fine, because listening should be a
    // decision anyway. A tool that starts making noise on its own is a tool people
    // mute at the operating system and then wonder why it is silent.
    const listen = $('#listen');
    listen.addEventListener('click', async () => {
      if (this.audio.on) { this.audio.stop(); }
      else {
        const n = this.node();
        if (!n || n.out.kind !== 'real') return;
        const ok = await this.audio.start(this.engine, n.id, this.engine.effectiveTime(n.id));
        if (!ok) this.setStageBadge('this browser has no audio output');
      }
      this.renderListen();
      this.renderStrip();
      this.metrics.interaction();
    });

    const step = (dt) => {
      this.engine.t = Math.max(0, this.engine.t + dt);
      this.resetSpectrum();
      this._tsCache = null;
      this._bitsSeen = false;
      this.metrics.interaction();
    };
    $('#back').addEventListener('click', () => step(-1));
    $('#fwd').addEventListener('click', () => step(1));

    // the budgets readout is a development instrument, reachable by key alone
    this.toggleBudgets = () => {
      $('#metrics').hidden = !$('#metrics').hidden;
      this.metrics.render();
    };

    $('#play').addEventListener('click', () => {
      this.setPlaying(!this.engine.playing);
      this.metrics.interaction();
    });

    addEventListener('keydown', (e) => {
      // Escape means "never mind" wherever it is pressed. Behind the input guard it
      // did not, so dismissing the menu from its own search box left the selection
      // box armed on the stage with nothing behind it.
      if (e.key === 'Escape') { this.clearSelection(); this.menu.close(); return; }
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.key === ' ') { e.preventDefault(); $('#play').click(); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); $('#back').click(); }
      if (e.key === 'ArrowRight') { e.preventDefault(); $('#fwd').click(); }
      if (e.key === 'm' || e.key === 'M') { this.toggleBudgets(); }
      if (e.key === '=' || e.key === '+') { e.preventDefault(); this.zoomKey(1 / 1.4); }
      if (e.key === '-' || e.key === '_') { e.preventDefault(); this.zoomKey(1.4); }
      if (e.key === '0') { e.preventDefault(); this.resetZoom && this.resetZoom(); }
      // `/` in an open menu asks for its search box; the menu handles that itself
      if (e.key === '/' && this.menu.el.hidden) { e.preventDefault(); this.metrics.beginOp(); const r = $('#stage').getBoundingClientRect(); this.openMenu(r.left + r.width / 2, r.top + 60, this.selection); }
    });

    addEventListener('resize', () => { this.renderStage(); this.renderStrip(); });
  }

  // ── loop ─────────────────────────────────────────────────────────────────
  loop(ts) {
    try {
      this._frame(ts);
    } catch (err) {
      // One bad frame should cost a frame, not the session. Before this, a throw
      // stopped the loop re-arming and only a reload brought anything back.
      if (!this._errShown) { this._errShown = true; console.error(err); this.setStageBadge('⚠ render error — see console'); }
    }
    requestAnimationFrame((t) => this.loop(t));
  }

  _frame(ts) {
    const dt = ts - this._lastFrame;
    this._lastFrame = ts;
    this.metrics.frame(dt);
    this.engine.tick();

    const v = this.view();
    const p = this.vp(this.current);

    if (v === 'Spectrum') {
      const pin = this.engine.isPinned(this.channel);

      if (pin) {
        const r = this.engine.clipRate(pin);
        this.setStageBadge(
          `⊓ clip ${pin.params.t0.value.toFixed(3)}–${pin.params.t1.value.toFixed(3)} s` +
          ` · ×${r < 0.1 ? r.toFixed(3) : r.toFixed(2)}` +
          (this.engine.playing ? '' : ' · paused'));
      } else {
        this.setStageBadge(this.engine.playing ? '' : '▶ paused');
      }

      const pf = this._prefill;
      if (pf) {
        // Oldest first, as many rows as fit in a slice of the frame. Timing the work
        // beats predicting it: the cost per row varies with decimation, cache state
        // and machine, and a formula tuned to one of those is wrong for the others.
        const deadline = performance.now() + 6;
        for (let k = 0; pf.row < pf.rows; k++, pf.row++) {
          if (k > 0 && performance.now() > deadline) break;
          const at = this.prefillTime(pf, pin);
          const f = this.engine.frame(this.current, { bins: p.bins, window: p.window, at });
          if (f.kind === 'spectrum') {
            if (pf.row === 0) this.applyAutoRange(f.data, true);
            this.waterfall.push(f.data);
            this.trace.push(f.data);
          }
        }
        if (pf.row >= pf.rows) this._prefill = null;
        this.trace.draw();
        this.waterfall.draw();
      } else if (!this.engine.playing) {
        // Paused means the display holds. Pushing rows while the clock is stopped
        // scrolls the same spectrum over and over, which looks like motion and is
        // the opposite of what pause promises.
        this.trace.draw();
        this.waterfall.draw();
      } else {
        // One spectrum feeds both views, and neither wants 60 a second: the
        // waterfall takes `speed` rows, the trace only has to look alive. A
        // frame per animation frame spent most of the budget computing data
        // nobody ever saw — on a narrow channel that alone was the stall.
        this._rowAcc += dt / 1000;
        this._specAcc += dt / 1000;
        const interval = 1 / Math.max(1, p.speed);
        const rowDue = this._rowAcc >= interval;
        if (rowDue || this._specAcc >= SPEC_PERIOD || this._specData?.length !== p.bins) {
          this._specAcc = 0;
          const f = this.engine.frame(this.current, { bins: p.bins, window: p.window });
          if (f.kind === 'spectrum') this._specData = f.data;
        }
        if (this._specData) {
          this._autoAcc = (this._autoAcc || 0) + 1;
          if (this._autoAcc > 20) { this._autoAcc = 0; this.applyAutoRange(this._specData, false); }
          this.trace.push(this._specData);
          if (rowDue) { this._rowAcc = 0; this.waterfall.push(this._specData); }
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

    // The sink runs its own clock; this only tops the queue up and reports the level.
    if (this.audio.on) {
      if (this.engine.playing) this.audio.pump(this.engine, this.engine.effectiveTime(this.current));
      this.renderListen();
    }

    if (this.engine.t > this._tmax) this._tmax = this.engine.t;
    const cp = this.engine.isPinned(this.channel);
    $('#clock').textContent = (cp ? this.engine.clipPos(cp) : this.engine.t).toFixed(3) + ' s';
    $('#track i').style.left = (this.scrubFrac() * 100).toFixed(2) + '%';
  }
}

const app = new App();
// a handle for the console and for tests; nothing in the app reads it back
window.sdrflex = app;
app.start().catch((e) => {
  document.body.innerHTML = `<pre class="fatal">${e && e.stack ? e.stack : e}</pre>`;
});

export { LATENCY };
