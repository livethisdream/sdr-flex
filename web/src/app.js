// M0 shell. Breadcrumb, view tabs, stacked spectrum + waterfall on one shared axis,
// contextual menu on drag-release, cell strip. The engine behind it is the mock
// (ADR-0021) — the client cannot tell, which is the point.

import { MockEngine, OPS, LATENCY, demodsFor, cleanName } from './engine.js';
import { RemoteEngine } from './remote.js';
import { Waterfall } from './waterfall.js';
import { SpectrumTrace, TimeSeries, BitRaster } from './views.js';
import { ContextMenu } from './menu.js';
import { IdentifyPanel } from './identview.js';
import { plan as identifyPlan } from './identify.js';
import { Strip } from './strip.js';
import { HOTKEYS, KEY_FOR, opForKey, firstOpNamed } from './keys.js';
import { delayOf } from './delay.js';
import { Metrics } from './metrics.js';
import { fromFiles, FORMATS } from './capture.js';
import * as out from './export.js';
import * as plugins from './plugins.js';
import { AudioMixer, meterLevel } from './audio.js';
import { COLORMAPS, cssGradient, floorColor, lut, DEFAULT_COLORMAP } from './colormap.js';
import { WINDOWS, spectrumHasSignal } from './dsp.js';
// Only for its SIGNALS table: the synthetic scene is the one source whose contents are
// known in advance, so it is the one source that can just say what is in it.
import * as scene from './scene.js';
import { CRCS } from './frames.js';
import * as resume from './resume.js';

// How much capture one streamed decode covers.
//
// Short enough that a burst shows up while you are still looking at the place it
// happened, long enough that the cost of starting a process is not most of the work. An
// M17 packet is about a fifth of a second, so this is the latency between hearing one
// and reading it — and it divides the symbol sync's ten-second fit blocks, so a block
// of decoding never needs a grid that is not already measured.
const STREAM_BLOCK_S = 5;

// The speeds the transport cycles through.
//
// Halving each time, because halving is what the ear hears as a step and each one is an
// octave down: a voice at a quarter speed is two octaves below where it was said, which
// is about as far as speech stays speech. Nothing faster than real time — this exists
// for hearing something, and a recording played faster is not easier to hear.
const SPEEDS = [1, 0.5, 0.25];

// How often a running stream sink is fed, in milliseconds of wall clock.
//
// The same trade the audio mixer makes — long enough that a datagram carries useful
// samples and the round trip is not most of the work, short enough that the far end is
// not waiting on a buffer — with one number underneath it that was measured rather than
// picked. Nothing paces the datagrams inside a chunk: `send` on a connectionless socket
// queues and returns, deliberately, so a sink cannot stall the read loop for something
// that may not even be listening. The pacing *is* this tick.
//
// So a chunk has to fit in what a socket will take at once. On loopback, the most
// forgiving path there is, 64 kB in one burst arrives whole, 96 kB loses four datagrams
// and 128 kB loses thirty-six — the receiving buffer saturates a little over ninety.
// A quarter second of 48 kHz s16 is 24 kB, two dozen datagrams, about 2.5x of headroom
// on the friendliest link. The loss when it comes is silent, which is why that margin
// is not thinner. `web/test/streamout.test.mjs` pins it.
const SINK_CHUNK_MS = 250;

const $ = (s, r = document) => r.querySelector(s);

/** Safe inside an attribute as well as in text — a name is whatever somebody typed. */
const attr = (x) => String(x ?? '').replace(/[<>&"']/g, (c) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtHz = (hz) => (hz / 1e6).toFixed(4);
const fmtRate = (r) => (r >= 1e6 ? (r / 1e6).toFixed(3) + ' MS/s' : (r / 1e3).toFixed(1) + ' kS/s');

// The spectrum trace is redrawn every animation frame, but it does not need a
// freshly computed spectrum every time: 25 a second reads as continuous and
// costs a third of what 60 does. Waterfall rows keep their own clock on top.
const SPEC_PERIOD = 1 / 25;

// How often what is on screen is written down for a reload to find. Three seconds is
// under the time it takes to turn one parameter and look at the result, and the write is
// skipped entirely when nothing changed.
const KEEP_PERIOD_MS = 3000;

const VIEWS = {
  iq: ['Spectrum', 'Flow'],
  // A real stream reads two ways — the waveform, and the baseband spectrum the
  // waveform is made of. Which one is `domain` in the view parameters below, because
  // it is one node and one set of samples drawn against two axes, not two blocks.
  real: ['Time', 'Spectrum', 'Flow'],
  bits: ['Bits', 'Time', 'Flow'],
  events: ['Events', 'Flow'],
  grid: ['Grid', 'Flow'],
  audio: ['Listen', 'Flow'],
  file: ['Export', 'Flow'],
  sink: ['Stream', 'Flow'],
  bytes: ['Bytes', 'Flow'],
};

const defaultViewParams = () => ({
  bins: 1024, window: 'Hann', avg: 4,
  // Named in colormap.js, with the reason, because four other places reach for the same
  // default and one of them used to disagree.
  dbMin: -74, dbMax: -18, dbAuto: true, colormap: DEFAULT_COLORMAP, speed: 60,
  trigger: 'auto', spanS: 0.12,
  domain: 'time', channel: 'sum',
  zoomLo: 0, zoomHi: 1,
});

/** What a long free-text value looks like on a bar that has room for about twenty. */
function shorten(v, max = 22) {
  const s = v == null || v === '' ? 'default' : String(v);
  return s.length <= max ? s : s.slice(0, max - 1) + '\u2026';
}

/**
 * A set of choices, on a pill an inch wide.
 *
 * Read as text, `POCSAG512 POCSAG1200 POCSAG2400` truncates to the first name and a
 * half, which says neither which ones nor how many — and how many is the thing about a
 * set that fits. The membership is read in the popover, where it is also changed.
 */
function fmtSet(v) {
  const on = String(v == null ? '' : v).trim().split(/\s+/).filter(Boolean);
  if (!on.length) return 'none';
  return on.length === 1 ? shorten(on[0], 16) : `${shorten(on[0], 12)} +${on.length - 1}`;
}

class App {
  constructor() {
    this.engine = new MockEngine();
    this.viewParams = new Map();   // nodeId -> params
    this.tabs = new Map();         // channelId -> 'spectrum' | 'flow' | blockNodeId
    // The node whose name is being edited, and the draft so far. Held here rather than
    // in the DOM because the rows it lives in are rebuilt from state, and a live source
    // rebuilds them without being asked.
    this.renaming = null;          // { id, draft } | null
    this.selection = null;
    this.metrics = new Metrics($('#metrics'));
    this.menu = new ContextMenu(document.body);
    this.ident = new IdentifyPanel(document.body);
    this.strip = new Strip($('#strip'), $('#tip'));
    this.waterfall = new Waterfall($('#wf'), 260);
    this.trace = new SpectrumTrace($('#sp'));
    this.timeSeries = new TimeSeries($('#ts'));
    this.bitRaster = new BitRaster($('#bits'));
    this.mixer = new AudioMixer();
    this._rowAcc = 0;
    this._tmax = 0;                       // the furthest the session has played to
    this.split = 0.34;
    this.theme = 'auto';
    try { const t = localStorage.getItem('sdrflex.theme'); if (t) this.theme = t; } catch (_) { /* private mode */ }
    try { const v = parseFloat(localStorage.getItem('sdrflex.split')); if (v > 0) this.split = v; } catch (_) { /* private mode */ }
    this._specAcc = 0;
    this._specData = null;
    this._lastFrame = performance.now();
  }

  async start() {
    await this.connectEngine();
    await this.loadPlugins();
    let want = true;
    try { want = localStorage.getItem('sdrflex.loop') !== '0'; } catch { /* no store */ }
    this.setLoop(want);
    let speed = 1;
    try { speed = Number(localStorage.getItem('sdrflex.speed')) || 1; } catch { /* no store */ }
    this.setSpeed(speed);
    const root = await this.engine.createSession();
    this.channel = root.id;        // where the breadcrumb is
    this.current = root.id;        // whose result is on screen
    this.vp(root.id);
    this.tabs.set(root.id, 'spectrum');
    this.wire();
    this.refresh();
    // Written down every few seconds, and asked about on the way out. See resume.js for
    // what a recipe is and why it is not a snapshot.
    this._keeper = setInterval(() => this.keep(), KEEP_PERIOD_MS);
    addEventListener('beforeunload', (e) => {
      this.keep();
      if (this.engine.nodes.size <= 1) return;
      // The browser shows its own wording, and there is no way to say what is at stake.
      // The point is only the pause: a reload is one key away from a tab close and this
      // tool has no document to have saved.
      e.preventDefault();
      e.returnValue = '';
    });
    this.offerResume();
    requestAnimationFrame((t) => this.loop(t));
  }

  /**
   * Write down what is on screen, if it has changed.
   *
   * On a timer rather than at every call site that mutates the graph. There are a dozen
   * of those and there will be more; one of them being forgotten is a reload that loses
   * exactly the work somebody just did, which is the failure this is here to stop. A
   * recipe is a few kilobytes of JSON and this compares it against the last one written
   * before touching the store, so the cost of a quiet minute is one `stringify`.
   *
   * **An empty graph does not erase what is stored.** A page that has just loaded has an
   * empty graph, and this timer runs three seconds later — so deleting on empty would
   * throw away last session's work while the offer to restore it was still on screen.
   * What is stored is replaced by the next thing worth storing, and cleared by dismissing
   * the offer; nothing else removes it.
   */
  keep() {
    try {
      const r = resume.recipe(this.engine, {
        source: this.openedFrom, current: this.current, channel: this.channel, tabs: this.tabs,
      });
      if (!r) return;
      const text = JSON.stringify(r.nodes) + JSON.stringify(r.source);
      if (text === this._kept) return;
      this._kept = text;
      resume.keep(r);
    } catch (err) { /* a browser with no store is a browser that does not resume */ }
  }

  /**
   * Offer back what was open last time, if it can be put back.
   *
   * An offer and not an action. Restoring by itself would be right about nine times out
   * of ten and infuriating the tenth — somebody who opened the tool to look at something
   * else would have to undo a chain they did not ask for, and this tool has no undo.
   */
  async offerResume() {
    const bar = $('#resume');
    if (!bar) return;
    const saved = resume.saved();
    if (!saved) return;
    let captures = [];
    if (saved.source && saved.source.kind === 'library') {
      try { captures = await this.engine.listCaptures(); } catch { captures = []; }
    }
    const can = resume.canReplay(saved, { captures, remote: !!this.remote });
    const what = `${saved.nodes.length} node${saved.nodes.length === 1 ? '' : 's'} on ` +
                 `${saved.source.label || 'a capture'}`;
    $('#resume-text').textContent = can.ok ? `Last time: ${what}` : `Last time: ${what} — ${can.why}`;
    $('#resume-go').hidden = !can.ok;
    bar.hidden = false;

    const close = (forget) => { bar.hidden = true; if (forget) resume.forget(); };
    $('#resume-no').onclick = () => close(true);
    $('#resume-go').onclick = async () => {
      close(false);
      this.metrics.beginOp();
      try {
        if (can.open) {
          this.mixer.removeAll();
          await this.engine.openCapture(can.open.id);
          this.afterOpen();
          this.openedFrom = { kind: 'library', id: can.open.id, label: can.open.label };
        }
        const done = await resume.replay(this.engine, saved);
        if (done.map.size) {
          const land = saved.view && saved.view.current && done.map.get(saved.view.current);
          const chan = saved.view && saved.view.channel && done.map.get(saved.view.channel);
          if (chan) this.channel = chan;
          if (land) { this.current = land; this.vp(land); }
          for (const [id, tab] of saved.view?.tabs || []) {
            const to = done.map.get(id);
            if (to) this.tabs.set(to, tab);
          }
        }
        this.refresh();
        this.notify(done.skipped.length
          ? `restored ${done.made.length} of ${saved.nodes.length} — ` +
            `${done.skipped.map((k) => k.op).join(', ')} did not come back`
          : `restored ${done.made.length} node${done.made.length === 1 ? '' : 's'}`,
        done.skipped.length ? 12000 : 6000);
      } catch (err) {
        this.notify(`could not restore that: ${err.message}`, 9000);
      }
      this.metrics.endOp();
    };
    // It is an offer about the past, and the moment somebody does something it is about
    // the past of a different session.
    addEventListener('pointerdown', function once(e) {
      if (bar.contains(e.target)) return;
      removeEventListener('pointerdown', once, true);
      bar.hidden = true;
    }, true);
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

  /**
   * How a node is written down. Only channels carry a letter (engine.addNode).
   *
   * A name, where somebody has given one, stands in for what the node does — that is
   * what renaming means. The letter stays either way, because it is the handle the
   * channel markers and the torn-off tiles use, and `titleOf` keeps the operation
   * reachable on hover so a renamed node never becomes one nobody can identify.
   */
  tag(n) {
    const what = n.name || n.label;
    return n.letter ? `${n.letter} · ${what}` : what;
  }

  /** What to say on hover: the operation, once a name has replaced it. */
  titleOf(n) { return n.name ? `${n.name} — ${n.label}` : n.label; }

  /** Everything under a node, in any direction — used to stop what is about to vanish. */
  /**
   * The nodes this one could take as its second input.
   *
   * Same kind of stream, and not itself or anything that reads it — a cycle is refused
   * where it is chosen rather than found as a stack overflow at the next frame. A
   * different sample rate is *not* filtered out: the merge reports that in a sentence,
   * and seeing the candidate and being told why it will not work is how somebody learns
   * to set both tuners to the same decimation.
   */
  eligibleInputs(n) {
    return [...this.engine.nodes.values()]
      // The primary is in the list on purpose: a node against itself is how you square
      // one, and squaring the pilot is exactly how a 38 kHz reference gets made.
      .filter((x) => x.out && x.out.kind === n.out.kind)
      .filter((x) => this.engine.canFeed(x.id, n.id));
  }

  /** What to call a node in a list of them, or what an empty choice reads as. */
  nodeLabel(id) {
    const n = id && this.engine.node(id);
    return n ? this.tag(n) : 'none';
  }

  descendants(id) {
    const out = [];
    const walk = (nid) => { for (const c of this.engine.children(nid)) { out.push(c); walk(c.id); } };
    walk(id);
    return out;
  }

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
    if (!n) return 'Spectrum';
    // Read on the frequency axis, a detector's output gets the spectrum pane itself
    // — trace over waterfall, one shared axis (ADR-0020). It is the same picture of a
    // different signal, so it is the same view rather than a second one that would
    // have to grow its own zoom, its own dB range and its own colormap.
    if (n.out.kind === 'real' && this.vp(k).domain === 'frequency') return 'Spectrum';
    return VIEWS[n.out.kind][0];
  }

  /**
   * Is the spectrum on screen one-sided?
   *
   * A real stream's spectrum is its own mirror image, so it runs DC to fs/2 and has a
   * `domain` to choose. Anything complex — including a tuner drawn *on* a real stream —
   * is two-sided about its own centre like any other channel.
   */
  onRealSpectrum() {
    const n = this.node();
    return !!n && n.out.kind === 'real';
  }

  /**
   * Are the numbers on the axis baseband offsets rather than RF?
   *
   * A separate question from the one above, and it used to be the same one because only a
   * real stream could be in baseband. A tuner on a composite is complex, two-sided, and
   * still measured in kilohertz from DC.
   */
  basebandUnits() {
    return this.engine.isBaseband(this.current);
  }

  /**
   * What the spectrum pane asks the engine for. IQ has only the one answer; a real
   * stream has to say which axis it wants, or it gets the waveform.
   */
  frameOpts(p) {
    const o = { bins: p.bins, window: p.window };
    if (this.onRealSpectrum()) o.domain = 'frequency';
    if (this.channels() > 1) o.channel = p.channel;
    return o;
  }

  /** How many channels the current node carries. One, unless a stereo decoder said so. */
  channels() {
    const n = this.node();
    return (n && n.out.channels) || 1;
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
    // Audio outlives the tab you started it on — that is what makes several channels
    // a mixer rather than a mode — so a channel you have navigated away from has to
    // say it is still making noise.
    const audible = this.audibleChannels();
    const spk = (n) => (audible.has(n.id) ? ' <b class="spk" title="audible">\u{1F508}</b>' : '');
    const crumb = (n, cls) => {
      if (this.renaming && this.renaming.id === n.id) return this.renameField(n, `crumb ${cls} naming`);
      return `<button class="crumb ${cls}" data-id="${n.id}"` +
        (n.id === root.id ? '' : ` data-menu="${n.id}"`) +
        ` title="${attr(this.titleOf(n))}">${this.tag(n)}${pin(n)}${spk(n)}` +
        (cls === 'cur' && n.id !== root.id
          ? `<i class="x" data-del="${n.id}" role="button" tabindex="0" title="remove ${attr(this.tag(n))} and everything under it">✕</i>` : '') +
        `</button>`;
    };

    // The device's center and rate are its node's parameters, so they live in the
    // strip when the source is selected. Repeating them here made the top row a
    // second readout of something already on screen.
    // The device chip is the root of the path, so it is also where you change what
    // the path starts from. Clicking the one you are already on opens a capture —
    // the same place a source picker will live once there is more than one source.
    const onRoot = this.channel === root.id;
    let html =
      `<button class="dev${onRoot ? ' cur' : ''}" data-id="${root.id}"` +
      ` title="${onRoot ? 'open a capture' : root.label}">` +
      `<span class="live${this.engine.capture ? ' file' : ''}"></span>${root.label}` +
      `${onRoot ? '<i class="devopen">open…</i>' : ''}</button>`;

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
      b.addEventListener('click', () => {
        if (b.classList.contains('dev') && b.classList.contains('cur')) { $('#file').click(); return; }
        this.goChannel(b.dataset.id);
      });
    }
    this.wireRemove(el);
    this.wireNodeMenu(el);
    this.wireRename(el);
  }

  /**
   * The menu on a name.
   *
   * Renaming had nowhere to live. `✕` is already on the current crumb and the current
   * tab, and 08-ui-principles names that row as the most horizontally constrained in the
   * layout — a second icon beside it doubles the clutter on the two most-used navigation
   * rows to expose something used once per channel. So the two things you can do *to* a
   * node rather than *with* it are grouped behind one press, on the node itself.
   *
   * Right-click on a pointer, long-press on a touch screen, and nowhere else: this is not
   * a discoverable gesture and it is not meant to be the only way to do anything. Removal
   * keeps its `✕`, and a node that is never renamed never has to know this menu exists.
   *
   * Menu depth stays 1 (ADR-0018) — it is the same flat widget the operations palette
   * uses, with two entries instead of twenty.
   */
  nodeMenuAt(id, x, y) {
    const n = this.engine.node(id);
    if (!n || n.id === this.engine.root.id) return;
    const items = [{ id: 'rename', name: n.name ? 'Rename…' : 'Give it a name…', group: 'node' }];
    // Only offered once there is something to undo, because "use its operation name" on
    // a node already called what it does is a menu entry that does nothing.
    if (n.name) items.push({ id: 'clear', name: `Call it “${n.label}” again`, group: 'node' });
    items.push({ id: 'remove', name: 'Remove', group: 'node' });
    this.menu.open(x, y, items, (op) => {
      if (op === 'rename') this.beginRename(id);
      else if (op === 'clear') this.commitRename(id, '');
      else if (op === 'remove') this.removeNode(id);
    });
  }

  /**
   * Right-click, or hold.
   *
   * The long press is written out rather than left to the browser's own context menu,
   * because on a touch screen there is no right button and the browser's long-press is a
   * text-selection callout. Cancelled by movement — a press that turns into a scroll was
   * a scroll — and the click that follows a fired press is swallowed, or a long press on
   * a crumb would open the menu and then navigate away from what it is about.
   */
  wireNodeMenu(el) {
    for (const b of el.querySelectorAll('[data-menu]')) {
      const id = b.dataset.menu;
      const open = (x, y) => { this.menu.close(); this.nodeMenuAt(id, x, y); };
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        open(e.clientX, e.clientY);
      });

      let timer = null, sx = 0, sy = 0, fired = false;
      const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
      b.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse') return;        // a mouse has a right button
        sx = e.clientX; sy = e.clientY; fired = false;
        cancel();
        timer = setTimeout(() => { timer = null; fired = true; open(sx, sy); }, 480);
      });
      b.addEventListener('pointermove', (e) => {
        if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel();
      });
      b.addEventListener('pointerup', cancel);
      b.addEventListener('pointercancel', cancel);
      b.addEventListener('click', (e) => {
        if (!fired) return;
        fired = false;
        e.preventDefault(); e.stopPropagation();
      }, true);
    }
  }

  /**
   * The crumb or tab, with an input where its name was.
   *
   * The letter stays outside the field, because it is not part of what is being edited
   * and because losing it is disorienting in exactly the case this exists for: three
   * tuners all called "Tuner", and an editor that shows only "Tuner" has taken away the
   * one thing that said which of them you opened. The placeholder is the operation, so
   * the field also says what the node goes back to being called if you leave it empty.
   */
  renameField(n, cls) {
    return `<span class="${cls}">` +
      (n.letter ? `<b class="rnl">${n.letter} ·</b>` : '') +
      `<input class="rn" data-rn="${n.id}" type="text" maxlength="32"` +
      ` spellcheck="false" autocomplete="off" value="${attr(this.renaming.draft)}"` +
      ` placeholder="${attr(n.label)}" aria-label="name for ${attr(n.label)}"></span>`;
  }

  beginRename(id) {
    const n = this.engine.node(id);
    if (!n) return;
    this.renaming = { id, draft: n.name || '' };
    this.refresh();
  }

  cancelRename() {
    if (!this.renaming) return;
    this.renaming = null;
    this.refresh();
  }

  /**
   * Nothing is sent when nothing changed.
   *
   * Committing on blur is what makes this feel like a label rather than a dialog, and it
   * means the common case — open the editor, think better of it, click away — has to cost
   * nothing. `cleanName` is applied on both sides of the comparison so that trailing
   * space is not a change.
   */
  async commitRename(id, value) {
    const n = this.engine.node(id);
    this.renaming = null;
    if (n && (n.name || '') !== cleanName(value)) await this.engine.renameNode(id, value);
    this.refresh();
  }

  /**
   * Focus and caret survive a re-render, because one will happen.
   *
   * A live source moves on its own and redraws the top row underneath whatever is
   * happening in it. So the editor is rendered from state rather than poked into the DOM,
   * and this puts the cursor back where it was each time the row is rebuilt.
   */
  wireRename(el) {
    const input = $('.rn', el);
    if (!input) return;
    const id = input.dataset.rn;
    input.addEventListener('input', () => { if (this.renaming) this.renaming.draft = input.value; });
    // The app listens for bare keys — space plays, `/` opens the palette — and an editor
    // that let those through would play the capture while you typed a name with a space
    // in it.
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); this.commitRename(id, input.value); }
      else if (e.key === 'Escape') { e.preventDefault(); this.cancelRename(); }
    });
    input.addEventListener('blur', () => {
      if (this.renaming && this.renaming.id === id) this.commitRename(id, input.value);
    });
    if (document.activeElement !== input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
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
    // Everything that *reads* this node, not everything below it: a merge somewhere else
    // in the tree is downstream of this branch without being under it (ADR-0038), and it
    // goes too. `descendants` is the navigation question and this is the data one.
    for (const d of [n, ...this.engine.allConsumers(id)]) this.mixer.remove(d.id);
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
      .concat(blocks.map((b) => ({ k: b.id, label: this.tag(b), kind: b.out.kind, del: b.id, node: b,
                                   live: b.out.kind === 'audio' && this.mixer.has(b.id),
                                   // ADR-0013 requires a node you cannot see inside to
                                   // look different from one you can. `opaque` is set
                                   // by the engine when the work happens in somebody
                                   // else's program.
                                   ext: !!b.opaque || !!b.plugin || !!(OPS[b.op] && OPS[b.op].external) })))
      .concat([{ k: 'flow', label: 'Flow' }]);

    const el = $('#tabs');
    el.innerHTML = items.map((it) => {
      if (it.node && this.renaming && this.renaming.id === it.node.id) {
        return this.renameField(it.node, 'tab on naming');
      }
      return `<button class="tab${it.k === this.tabKey() ? ' on' : ''}${it.ext ? ' ext' : ''}${it.live ? ' live' : ''}" data-k="${it.k}"` +
      (it.node ? ` data-menu="${it.node.id}" title="${attr(this.titleOf(it.node))}"` : '') + '>' +
      `${it.live ? '<span class="spk">\u{1F508}</span>' : ''}` +
      `${it.label}${it.kind ? `<span class="tk">${it.kind}</span>` : ''}` +
      `${it.live ? '<i class="alvl"></i>' : ''}` +
      (it.del && it.k === this.tabKey()
        ? `<i class="x" data-del="${it.del}" role="button" tabindex="0" title="remove ${attr(it.label)} and everything after it">✕</i>` : '') +
      `</button>`;
    }).join('') +
      // `+` is choosing a decoder by hand; Identify is the auto mode of the same
      // choice (ADR-0017). They belong next to each other, and Identify has to be one
      // click from here or UC-1' does not fit in its three interactions.
      (this.canIdentify() ? '<button class="tab ident-btn" title="try every decoder that could read this stream">Identify</button>' : '') +
      '<button class="tab plus" title="operations valid here">+</button>';

    this.wireRemove(el);
    this.wireNodeMenu(el);
    this.wireRename(el);
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
    const idb = el.querySelector('.ident-btn');
    if (idb) idb.addEventListener('click', (e) => {
      const r = e.target.getBoundingClientRect();
      this.openIdentify(r.left, r.bottom + 4);
    });
  }

  /** Is there anything here to identify, and anything on the box to do it with? */
  canIdentify() {
    const n = this.node();
    if (!n || (n.out.kind !== 'iq' && n.out.kind !== 'real')) return false;
    return (this.engine.adapters || []).some((a) => a.available);
  }

  /**
   * Try every decoder that could read this stream.
   *
   * The plan is drawn before anything runs — the client has the adapter list and the
   * planner is shared, so it can say what is about to happen rather than showing an
   * empty box that grows. Results arrive one at a time and land in the rows already on
   * screen.
   */
  async openIdentify(x, y) {
    const n = this.node();
    if (!n) return;
    this.metrics.beginOp();
    const kind = n.out.kind;
    const plan = identifyPlan(this.engine.adapters || [],
      { kind, sampleRate: n.out.sampleRate, demods: demodsFor(kind) });
    const at = this.engine.effectiveTime(n.id);
    const win = this.engine.identifyWindow(n.id, at);
    this.ident.open({ x, y }, plan,
      { windowS: win.t1 - win.t0, kind, sampleRate: n.out.sampleRate },
      (row) => this.buildFromIdentify(n.id, row));

    let report;
    try {
      report = await this.engine.identify(n.id, { at, onResult: (r) => this.ident.result(r) });
    } catch (e) {
      report = { error: e.message };
    }
    if (!this.ident.isOpen) return;            // closed while it ran, which is allowed
    // The final reply carries every row again. Rows that arrived on the progress
    // channel are already in place; this is what catches an engine that answered all at
    // once — the mock one does — and it is why the panel keys rows rather than counting.
    for (const r of (report && report.results) || []) this.ident.result(r);
    this.ident.finish(report);
  }

  /**
   * Build what a row describes: whatever had to run in front of the decoder, then the
   * decoder, configured the way the run that answered was configured.
   *
   * `via` is a list rather than one demodulator, because one decoder here does not read
   * samples — `m17-packet-decode` wants a symbol sync between the discriminator and it
   * (ADR-0040). The row already carries the whole chain, so this walks it rather than
   * knowing which decoders are special.
   */
  async buildFromIdentify(parentId, row) {
    const sel = this.defaultSelection();
    const chain = [].concat(row.via || []);
    let parent = parentId;
    // Building the chain is several round trips and a symbol fit, which measured about
    // three and a half seconds on a 90 s capture — long enough that a click with nothing
    // on screen reads as a click that did nothing.
    this.setStageBadge(`building ${row.name}${chain.length ? ` behind ${row.viaLabel}` : ''}…`);
    let node = null;
    try {
      for (const op of chain) {
        const d = await this.engine.addNode({ parent, op, selection: sel });
        parent = d.id;
      }
      node = await this.engine.addNode({ parent, op: row.id, selection: sel });
      for (const [k, v] of Object.entries(row.params || {})) {
        if (node.params && k in node.params) await this.engine.setParam(node.id, k, v, 'manual');
      }
    } catch (err) {
      // Said, not swallowed. Without this a throw partway left the demodulator on the
      // graph and no decoder behind it, and nothing anywhere said why — which is a
      // worse outcome than the click having failed outright.
      this.notify(`could not build that chain: ${err.message}`, 8000);
      this.setStageBadge('');
      this.metrics.endOp();
      this.refresh();
      return;
    }
    this.setStageBadge('');
    this.vp(node.id);
    this.setTab(node.id);
    this._tsCache = null;
    this.metrics.endOp();
    this.refresh();
  }

  renderStage() {
    const v = this.view();
    $('#pane-spectrum').hidden = v !== 'Spectrum';
    $('#pane-time').hidden = v !== 'Time';
    $('#pane-bits').hidden = v !== 'Bits';
    $('#pane-flow').hidden = v !== 'Flow';
    $('#pane-events').hidden = v !== 'Events';
    $('#pane-audio').hidden = v !== 'Listen';
    $('#pane-export').hidden = v !== 'Export';
    $('#pane-stream').hidden = v !== 'Stream';
    $('#pane-bytes').hidden = v !== 'Bytes';
    $('#pane-grid').hidden = v !== 'Grid';
    if (v === 'Spectrum') {
      // The waterfall holds rows for one node at a time, and this pane no longer belongs
      // to one node: a demodulator's baseband spectrum draws here too. Changing tabs can
      // now change what the rows mean without changing the pane, and old rows under a new
      // axis are not history — they are a different signal, scrolling.
      if (this._paneNode !== this.current) { this._paneNode = this.current; this.resetSpectrum(); }
      const p = this.vp(this.current);
      $('#cbar').style.background = cssGradient(p.colormap);
      this.applyStageColors(p.colormap);
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
    if (v === 'Listen') this.renderAudio();
    if (v === 'Export') this.renderExport();
    if (v === 'Bytes') this.renderBytes();
    if (v === 'Events') this.renderEvents();
    if (v === 'Grid') this.renderGrid();
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
    host.innerHTML = this.sceneMarks(n, lo, span) + kids.map((k) => {
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

  /**
   * Are we looking at the synthetic scene's own spectrum?
   *
   * The in-tab engine with no capture open is drawing it directly; a server running the
   * synthetic source is writing it into a ring and calls itself so. Any other source is
   * a recording or a radio, and what is in it is the question rather than the answer.
   */
  onSyntheticSource() {
    const n = this.node();
    if (!n || !this.engine.root || n.id !== this.engine.root.id) return false;
    const cap = this.engine.capture;
    if (!cap) return true;
    return cap.driver === 'synthetic' || cap.kind === 'synthetic';
  }

  /**
   * What is in the band, on the one source that knows.
   *
   * `scene.SIGNALS` has carried these labels since the scene was written and was
   * referenced by nothing — so the only way to find out what the synthetic source
   * contains was to read `scene.js`. Two of the five are genuinely ambiguous from the
   * display alone: an AM detector slope-detects the NBFM channel and hands back a clean
   * tone, and the USB pair looks like 2FSK until you demodulate it. Guessing is the
   * exercise a capture sets; a demo scene owes you the answer so you can go and *prove*
   * it with a demodulator.
   *
   * Drawn dim and dashed, and never clickable. Accent marks what the user placed
   * (08-ui-principles); these were here before you arrived.
   */
  sceneMarks(n, lo, span) {
    if (!this.onSyntheticSource()) return '';
    return scene.SIGNALS.map((s) => {
      const center = n.out.centerHz + s.offsetHz;
      const left = ((center - s.widthHz / 2 - lo) / span) * 100;
      const width = (s.widthHz / span) * 100;
      if (left > 100 || left + width < 0) return '';
      return `<span class="scenemark" style="left:${left}%;width:${width}%">` +
             `<i>${attr(s.label)}</i></span>`;
    }).join('');
  }

  /**
   * The frequency window currently on screen, in Hz.
   *
   * IQ is two-sided about the tuned frequency, so it spans a whole sample rate and
   * the numbers are RF. A demodulated stream is one-sided and starts at DC, so it
   * spans half of one and the numbers are baseband offsets — 57 kHz means 57 kHz
   * away from nothing, not 57 kHz away from the station.
   */
  viewHz() {
    const n = this.node();
    const p = this.vp(this.current);
    const oneSided = this.onRealSpectrum();
    const lo0 = oneSided ? 0 : n.out.centerHz - n.out.sampleRate / 2;
    const span = oneSided ? n.out.sampleRate / 2 : n.out.sampleRate;
    return { lo: lo0 + p.zoomLo * span, hi: lo0 + p.zoomHi * span };
  }

  renderAxis() {
    const { lo, hi } = this.viewHz();
    const p = this.vp(this.current);
    const z = 1 / Math.max(1e-6, p.zoomHi - p.zoomLo);
    // Baseband is tens of kilohertz, and four decimal places of megahertz makes the
    // pilot and the RDS subcarrier both read as 0.0000. The unit follows the signal
    // rather than the pane — and it follows it down, so a tuner drawn on a composite is
    // labelled in kilohertz too.
    const base = this.basebandUnits();
    $('#axis').innerHTML = [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const hz = lo + (hi - lo) * f;
      return base
        ? `<span>${(hz / 1e3).toFixed(1)}${f === 0.5 ? ' kHz' : ''}</span>`
        : `<span>${fmtHz(hz)}${f === 0.5 ? ' MHz' : ''}</span>`;
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
      // How late this node's samples are, which is a fact about the compiled graph and so
      // belongs on the pane that shows it. Nothing consumes it yet — a merge will
      // (ADR-0038) — but it is the difference between two branches that decides whether a
      // coherent operation between them can work, and there was nowhere to see it.
      // A second input is a real edge and the tree cannot show it by indentation, so it
      // gets a row of its own that names where it comes from. Drawn under the node that
      // reads it rather than beside the node it comes from, because "what does this read"
      // is the question somebody looking at a merge is asking.
      const other = (n.inputs || []).slice(1).map((i) => this.engine.node(i)).filter(Boolean);
      const second = other.map((o) => `<div class="fjoin" style="margin-left:${(depth + 1) * 22}px">` +
        `<span class="fn">and ${attr(this.tag(o))}</span>` +
        `<span class="fk">${o.out.kind}</span>` +
        `<span class="fr">${fmtRate(o.out.sampleRate)}</span></div>`).join('');
      const d = delayOf(n, (i) => this.engine.node(i));
      const late = d.known
        ? (d.seconds > 0 ? `+${(d.seconds * 1e6).toFixed(0)} µs` : '0 µs')
        : `${d.op.replace('core.', '')}?`;
      const why = d.known
        ? `these samples are ${(d.seconds * 1e6).toFixed(1)} µs older than the moment they are asked for`
        : `${d.op} restitches time, so nothing downstream can say when its samples are from`;
      return `<div class="fnode${id === this.current ? ' cur' : ''}${spec && spec.external ? ' ext' : ''}" style="margin-left:${depth * 22}px" data-id="${id}">
          <span class="fn">${this.tag(n)}</span>
          <span class="fk">${n.out.kind}</span>
          <span class="fr">${fmtRate(n.out.sampleRate)}</span>
          <span class="fd${d.known ? '' : ' unk'}" title="${attr(why)}">${late}</span>
        </div>` + second + kids.map((k) => walk(k.id, depth + 1)).join('');
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
      // A file's center and rate are facts about it. A radio's are what you told it,
      // and telling it something else is the most basic thing you do with a radio — so
      // the same two cells are read-only on a capture and controls on a live source.
      const live = this.engine.isLive && this.engine.isLive();
      nodeCells.push(
        live
          ? { key: 'centerHz', label: 'center', unit: 'MHz', type: 'num', value: n.out.centerHz,
              fmt: fmtHz, step: 2000, min: 0 }
          : { key: 'centerHz', label: 'center', unit: 'MHz', type: 'ro', value: n.out.centerHz, fmt: fmtHz },
        { key: 'sampleRate', label: 'rate', unit: 'kS/s', type: 'ro', value: n.out.sampleRate,
          fmt: (v) => (v / 1e3).toFixed(0) });
      // Where a source comes from belongs with the facts about the one you have.
      // Only when there is a server to ask: in the tab, the gesture is the drop.
      if (this.hasLibrary) {
        nodeCells.push({ key: 'library', label: 'open a capture…', type: 'action', value: '' });
      }
      if (this.hasRadios) {
        nodeCells.push({ key: 'radio', label: live ? 'change radio…' : 'listen to a radio…',
                         type: 'action', value: '' });
      }
      if (live) nodeCells.push({ key: 'stopradio', label: 'stop the radio', type: 'action', value: '' });
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
          // `auto` reads the pilot every time it decodes; the other two overrule it.
          decode: { label: 'decode', unit: '', type: 'enum', values: ['auto', 'stereo', 'mono'], fmt: String },
          // Which node the other input comes from. The only control in the tool that
          // asks you to point at a node rather than at a signal, which is what a second
          // input is (ADR-0038) — so the list is every node it could legally read:
          // same kind of stream, and not something that already reads this one.
          withNode: { label: 'and', unit: '', type: 'enum', fmt: (v) => this.nodeLabel(v),
                      values: ['', ...this.eligibleInputs(n).map((x) => x.id)],
                      hint: 'the second input — a merge lines it up with the first before ' +
                            'combining them, and says so when it cannot' },
          op: { label: 'operation', unit: '', type: 'enum', fmt: String,
                values: n.out.kind === 'iq'
                  ? ['a+b', 'a-b', 'a*b', 'a*conj(b)', 'a/b']
                  : ['a+b', 'a-b', 'a*b', 'a/b'] },
          gainDb: { label: 'gain', unit: 'dB', type: 'num', fmt: (v) => (v > 0 ? '+' : '') + Number(v).toFixed(1),
                    step: 0.25, min: -60, max: 80 },
          // Not derived, because nothing in the signal says which continent it came from:
          // 75 µs in the Americas, 50 µs most other places (ADR-0037).
          deemphasisUs: { label: 'de-emphasis', unit: 'µs', type: 'enum', values: ['75', '50', '0'],
                          fmt: (v) => (Number(v) > 0 ? String(v) : 'off') },
          bfoHz: { label: 'bfo', unit: 'Hz', fmt: (v) => String(Math.round(v)), step: 1.5, min: -3000, max: 3000, integer: true, type: 'num' },
          offsetHz: { label: 'offset', unit: 'Hz', fmt: (v) => String(Math.round(v)), step: 2.5, integer: true, type: 'num' },
          pitchHz: { label: 'pitch', unit: 'Hz', fmt: (v) => String(Math.round(v)), step: 2, min: 200, max: 2000, integer: true, type: 'num' },
          volume: { label: 'volume', unit: '', fmt: (v) => (v * 100).toFixed(0) + '%', step: 0.004, min: 0, max: 1, type: 'num' },
          squelch: { label: 'squelch', unit: '', fmt: (v) => (v > 0 ? v.toFixed(3) : 'off'), step: 0.0004, min: 0, max: 0.4, type: 'num' },
          gain: { label: 'gain', unit: '×', fmt: (v) => (v < 10 ? v.toFixed(1) : String(Math.round(v))), step: 0.02, min: 0.1, max: 60, type: 'num' },
          // A sync word is typed, not slid to.
          syncHex: { label: 'sync word', unit: '', type: 'text', placeholder: 'aa 55',
                     hint: 'hex, as you would write it down — the bytes the packet starts with',
                     fmt: (v) => (v ? String(v) : 'none') },
          bitOrder: { label: 'bit order', unit: '', type: 'enum', values: ['msb', 'lsb'], fmt: String },
          polarity: { label: 'convention', unit: '', type: 'enum', values: ['ieee', 'thomas'], fmt: String },
          mode: { label: 'encoding', unit: '', type: 'enum', values: ['nrz-m', 'nrz-s'], fmt: String },
          // No unit when the value is a phrase rather than a number: "to next syncB"
          // is what a unit appended to a sentence looks like.
          frameBytes: { label: 'frame length', unit: '', type: 'num', step: 0.2, min: 0, max: 2048,
                        integer: true, fmt: (v) => (v > 0 ? `${v} B` : 'to next sync') },
          crc: { label: 'CRC', unit: '', type: 'enum', fmt: String,
                 values: ['auto', 'none', ...CRCS.map((c) => c.id)] },
          chipRate: { label: 'chip rate', unit: 'kc/s', fmt: (v) => (v / 1e3).toFixed(1),
                      step: 40, min: 100, integer: true, type: 'num' },
          // Typed rather than chosen from a list. There are six hundred and seventy-odd
          // codes in the catalog and a menu of them is not a menu — but the id is short,
          // it is what the search reports, and typing it back is how you pin an answer.
          code: { label: 'code', unit: '', type: 'text', placeholder: 'auto',
                  hint: 'auto, or a code id as the search reports it — m127/0x48, gold63/17, walsh32/13, barker11',
                  fmt: (v) => shorten(v) },
          // Which polarity is a one is not in a BPSK signal. `auto` picks the one that
          // reads as text and says so; the other two are the coin, flipped by hand.
          invert: { label: 'polarity', unit: '', type: 'enum', fmt: String,
                    values: ['auto', 'normal', 'inverted'] },
          // The network sink's four. `running` is an enum rather than a button because
          // it is a property of the node — the graph says what is happening, and a sink
          // that is sending is a different graph from one that is not (ADR-0027).
          host: { label: 'to', unit: '', type: 'text', placeholder: '127.0.0.1',
                  hint: 'where the decoder is. In a container 127.0.0.1 is the container, not your machine',
                  fmt: String },
          port: { label: 'port', unit: '', type: 'num', step: 1, min: 1, max: 65535,
                  integer: true, fmt: String,
                  hint: '7355 is what GQRX uses, so the tools that eat its audio expect it' },
          running: { label: 'running', unit: '', type: 'enum', values: ['no', 'yes'], fmt: String,
                     hint: 'sends while the transport plays; stopping leaves the node and closes the socket' },
        // An adapter's parameters come with the node, since the client has no table of
        // somebody else's decoder's knobs and should not need one.
        }[key] || (n.op === 'core.stream' && {
          format: { label: 'format', unit: '', type: 'enum', fmt: String,
                    values: ['s16', 'cs16', 'cu8', 'cf32', 'f32', 'raw'],
                    hint: 's16 at 48 kHz is the GQRX convention; raw sends the bytes as they are' },
          rate: { label: 'rate', unit: 'kS/s', type: 'num', step: 20, min: 1000, max: 400_000,
                  integer: true, fmt: (v) => (v / 1e3).toFixed(1) },
        }[key]) || (n.paramMeta && n.paramMeta[key]
          // A decoder's own knob, drawn from what the node carries. Long text is
          // summarized here and read in full in the popover — an rtl_433 flex spec is
          // sixty characters and would be the entire bar.
          ? { unit: '', fmt: n.paramMeta[key].type === 'multi' ? fmtSet : (v) => shorten(v),
              ...n.paramMeta[key] }
          : { label: key, unit: '', fmt: String, type: 'num', step: 1 });
        nodeCells.push({
          key, ...meta, value: pr.value, mode: pr.mode, canAuto: !!pr.auto,
          autoNote: pr.auto ? pr.auto.from : null,
          autoValue: pr.auto ? pr.auto.suggested ?? pr.auto.initial : null,
        });
      }
      // a sink has no output; what its rate describes is what it is being fed
      nodeCells.push({ key: 'out', label: n.out.kind === 'audio' ? 'in' : 'out', unit: 'kS/s',
                       type: 'ro', value: n.out.sampleRate, fmt: (v) => (v / 1e3).toFixed(1) });
    }
    groups.push({ key: 'node', title: n.op === 'core.source' ? 'src' : (n.letter || n.label), cells: nodeCells });

    // Which axis a real stream is read on. It sits with the other things that change
    // how a result is drawn rather than what it is, and it is the first cell in the
    // group because it decides what the rest of the group is about.
    const domainCells = n.out.kind === 'real'
      ? [{ key: 'domain', label: 'domain', unit: '', type: 'enum', value: p.domain,
           values: ['time', 'frequency'] }]
      : [];
    // And which channel, where there is a choice. It only appears on a node that
    // produces more than one, because a `channel` pill reading "sum" above a stream that
    // has one channel is a control for a decision nobody is making.
    const channelCells = this.channels() > 1
      ? [{ key: 'channel', label: 'channel', unit: '', type: 'enum', value: p.channel,
           values: ['sum', 'left', 'right'] }]
      : [];
    const viewCells = domainCells.concat(channelCells);

    if (this.view() === 'Time') {
      groups.push({
        key: 'view', title: 'view',
        cells: viewCells.concat([
          { key: 'trigger', label: 'trigger', unit: '', type: 'enum', value: p.trigger, values: ['auto', 'free'] },
          { key: 'spanS', label: 'span', unit: 'ms', type: 'num', value: p.spanS,
            fmt: (v) => (v * 1e3).toFixed(0), step: 0.0008, min: 0.002, max: 1.0 },
        ]),
      });
    }

    if (this.view() === 'Spectrum') {
      groups.push({
        key: 'view', title: 'view',
        cells: viewCells.concat([
          { key: 'bins', label: 'fft', unit: 'bins', type: 'enum', value: String(p.bins), values: ['256', '512', '1024', '2048', '4096'] },
          { key: 'colormap', label: 'colormap', unit: '', type: 'enum', value: p.colormap, values: COLORMAPS },
          { key: 'speed', label: 'speed', unit: 'rows/s', type: 'num', value: p.speed, fmt: (v) => String(Math.round(v)), step: 0.35, min: 2, max: 120, integer: true },
          { key: 'dbMin', label: 'min', unit: 'dBFS', type: 'num', value: p.dbMin, fmt: (v) => String(Math.round(v)), step: 0.35, min: -160, max: -10,
            canAuto: true, mode: p.dbAuto ? 'auto' : 'manual', autoNote: 'the tenth percentile of what is on screen' },
          { key: 'dbMax', label: 'max', unit: 'dBFS', type: 'num', value: p.dbMax, fmt: (v) => String(Math.round(v)), step: 0.35, min: -150, max: 20,
            canAuto: true, mode: p.dbAuto ? 'auto' : 'manual', autoNote: 'the strongest bin on screen' },
          { key: 'window', label: 'window', unit: '', type: 'enum', value: p.window, values: WINDOWS },
          { key: 'avg', label: 'avg', unit: 'frames', type: 'num', value: p.avg, fmt: (v) => String(v), step: 0.06, min: 1, max: 40, integer: true },
        ]),
      });
    }

    this.strip.render(groups);
    this.strip.onScrub = (g, k, v) => this.onParam(g, k, v);
    this.strip.onMode = (g, k, mode) => this.onMode(g, k, mode);
    this.strip.onAction = (g, k, e) => {
      const x = e ? e.clientX : null, y = e ? e.clientY : null;
      if (k === 'library') this.openLibrary(x, y);
      if (k === 'radio') this.openRadios(x, y);
      if (k === 'stopradio') this.stopRadio();
    };
  }

  async onParam(group, key, value) {
    if (group === 'view') {
      const p = this.vp(this.current);
      if (key === 'bins') { p.bins = parseInt(value, 10); this.resetSpectrum(); }
      // A different axis is a different picture, for the same reason changing the FFT
      // size is: the rows on the waterfall are bins of something else now, and the dB
      // range that suited one will not suit the other. The zoom goes with them — it is
      // a fraction of a span that is about to be a different span.
      else if (key === 'domain') {
        p.domain = value;
        p.zoomLo = 0; p.zoomHi = 1;
        this.resetSpectrum();
        this._tsCache = null;
      }
      // Same node, same axis, different signal — so the trace and the rows on the
      // waterfall are of something else now, exactly as they are on a domain change.
      else if (key === 'channel') { p.channel = value; this.resetSpectrum(); this._tsCache = null; }
      else if (key === 'window') p.window = value;
      else if (key === 'trigger') { p.trigger = value; this._tsCache = null; }
      else if (key === 'spanS') { p.spanS = value; this._tsCache = null; }
      else if (key === 'colormap') { p.colormap = value; this.applyStageColors(value); this.waterfall.setColormap(value); $('#cbar').style.background = cssGradient(value); }
      else p[key] = value;
      if (key === 'dbMin' || key === 'dbMax') p.dbAuto = false;
      if (key === 'dbMin' && p.dbMin > p.dbMax - 5) p.dbMin = p.dbMax - 5;
      if (key === 'dbMax' && p.dbMax < p.dbMin + 5) p.dbMax = p.dbMin + 5;
      this.waterfall.setRange(p.dbMin, p.dbMax);
      this.trace.setRange(p.dbMin, p.dbMax);
      this.trace.avgN = p.avg;
      this.renderCbarLabels();
      // Changing the domain changes which pane is on screen, not just how it is drawn.
      if (key === 'domain') this.renderStage();
      this.renderStrip();
      return;
    }
    const n = this.node();
    if (!n.params[key]) return;
    if (n.out.kind === 'audio' && key === 'volume') this.mixer.setVolume(n.id, value);
    // Stopping a sink closes its socket rather than merely not feeding it. A socket
    // left open on a node that says `no` is the graph lying about what is running,
    // which is the one thing ADR-0027 makes a sink a node to prevent.
    if (n.op === 'core.stream' && key === 'running' && value !== 'yes') {
      this._sinkTold = false;
      if (this._sinkAt instanceof Map) this._sinkAt.delete(n.id);
      this.engine.streamStop(n.id);
    }
    const wasAuto = n.params[key].mode === 'auto';
    if (wasAuto && n.params[key].auto) n.params[key].auto.suggested = n.params[key].value;

    // Retuning a radio restarts its process and empties its ring. A scrub fires forty
    // times on the way to a frequency, and forty restarts would be forty seconds of
    // dead air to move 200 kHz. So the readout follows the pointer immediately and the
    // radio follows once the pointer stops.
    if (n.op === 'core.source' && this.engine.isLive && this.engine.isLive()) {
      n.params[key].value = value;
      n.out[key] = value;
      this.renderStrip();
      this.renderAxis();
      clearTimeout(this._retune);
      this._retune = setTimeout(async () => {
        this.notify(`retuning to ${(value / 1e6).toFixed(4)} MHz — history starts over`, 6000);
        try {
          await this.engine.setParam(this.current, key, value, 'manual');
          this.afterOpen();
        } catch (err) { this.notify(`could not retune: ${err.message}`, 9000); }
      }, 450);
      return;
    }

    await this.engine.setParam(this.current, key, value, 'manual');
    this.renderStrip();
    this.renderAxis();
    // renderTopbar, not renderCrumbs — there has never been a method by that name, so
    // every node parameter change has been throwing here after the strip and the axis
    // had already redrawn. Visible effects all happened, the breadcrumb never refreshed,
    // and the exception escaped as an unhandled rejection out of the strip's callback.
    this.renderTopbar();
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
      const shown = (usable.length ? usable : ops).map((o) => ({ ...o, key: KEY_FOR[o.id] || null }));
      this.menu.open(x, y, shown, (opId) => this.applyOp(opId, selection));
    });
  }

  /**
   * Add an operation to the current node and land on its result.
   *
   * The menu and the hotkeys both come through here, which is the point: a key that
   * built a node its own way would be a second implementation of the only thing this
   * application does, and the two would disagree within a month.
   */
  async applyOp(opId, selection) {
    const sel = selection || this.defaultSelection();
    const node = await this.engine.addNode({ parent: this.current, op: opId, selection: sel });
    // Adding a Listen block *is* the gesture a browser needs before it will open
    // an audio context — which is the nicest possible answer to that constraint:
    // the thing that starts the audio is the thing that says audio should exist.
    if (node.out.kind === 'audio') {
      const ok = await this.mixer.add(node.id, this.engine.effectiveTime(node.parent), node.params.volume.value);
      if (!ok) this.setStageBadge('this browser has no audio output');
    }
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
    return node;
  }

  /**
   * A key, if it means an operation and the operation is valid here.
   *
   * Valid is asked of the engine rather than assumed, because that is the same question
   * the menu asks and the answer is the type filter of ADR-0006. Pressing `a` on a
   * bitstream must not build an AM detector on it, and must not silently do nothing
   * either — "that key did nothing" and "that key is not for this" are different, and
   * the second one is worth a sentence (ADR-0031's habit, one level down).
   */
  async hotkey(key) {
    if (!Object.prototype.hasOwnProperty.call(HOTKEYS, key)) return false;
    // One at a time. Adding a node is a round trip to the engine, and two keys pressed
    // inside it would both have read the old `current` — so the second would land beside
    // the first instead of after it, which is not what anybody typing t-f-l meant.
    if (this._applying) return false;
    this._applying = true;
    try {
      const ops = await this.engine.palette(this.current);
      const op = opForKey(key, ops);
      if (!op) {
        const n = this.node();
        const id = firstOpNamed(key);
        const name = (OPS[id] && OPS[id].name) || id;
        const article = /^[aeiou]/.test(n.out.kind) ? 'an' : 'a';
        this.notify(`${name} does not take ${article} ${n.out.kind} stream`, 2600);
        return false;
      }
      if (op.stub) { this.notify(`${op.name} is not built yet`, 2600); return false; }
      this.metrics.beginOp();
      await this.applyOp(op.id, this.selection);
      return true;
    } finally {
      this._applying = false;
    }
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
    // The range that was right a moment ago is not right for what is about to arrive.
    // Everything that calls this — opening a capture, changing channel, retuning,
    // changing the FFT size — changes what a decibel means here: narrowing a channel
    // narrows its bins, so its noise floor sits ten to twenty dB below its parent's.
    //
    // Easing towards that over seventeen seconds is not smoothing, it is being wrong
    // slowly. The follower exists so a *burst* does not make the display breathe; it was
    // never meant to arbitrate between two different signals. So the next spectrum to
    // arrive sets the range outright, and the easing resumes after it.
    this._autoSnap = true;
    this._autoAcc = 0;
    const p = this.vp(this.current);
    const span = this.waterfall.rows / Math.max(1, p.speed);
    const pf = {
      row: 0,
      rows: this.waterfall.rows,
      t1: this.engine.effectiveTime(this.channel),
      span,
    };
    this._prefill = pf;
    // A remote engine would otherwise be asked for these one at a time, which is one
    // round trip per row of the waterfall. The plan is fully known here, so it says so
    // and the rows come back in batches. The in-tab engine has no `prefetch` and needs
    // none — it answers in microseconds.
    if (this.engine.prefetch) {
      const pin = this.engine.isPinned(this.channel);
      const times = [];
      for (let row = 0; row < pf.rows; row++) times.push(this.prefillTime({ ...pf, row }, pin));
      this.engine.prefetch(this.current, this.frameOpts(p), times);
    }
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
    // A file starts at zero. A ring starts wherever it has not yet overwritten, and
    // asking behind that draws the oldest row over and over instead of saying so.
    const floor = this.engine.span ? this.engine.span()[0] : 0;
    if (!pin) return Math.max(floor, pf.t1 - pf.span * (1 - frac));
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

  /**
   * Hand the dB range back to the measurement.
   *
   * `dbAuto` has been here since the beginning and nobody could find it: it lives on the
   * `min` and `max` controls, which fold away at every width anybody uses, so reaching
   * it was the fold chip, then a control, then a button inside it. Now a double-click on
   * the colorbar — the thing you have just dragged the range out of shape with — does
   * it, and the bar says so.
   *
   * Snapped rather than eased. Easing is right when the range is following a signal that
   * is changing; it is wrong as the answer to somebody asking for it now, where a range
   * that creeps toward the right answer over two seconds reads as a control that did not
   * work. The snap is armed even when there is no spectrum in hand yet, so opening a
   * capture and asking for auto before the first frame still does the right thing.
   */
  autoRange() {
    const p = this.vp(this.current);
    p.dbAuto = true;
    this._autoSnap = true;
    this._autoAcc = 0;
    if (this._specData) this.applyAutoRange(this._specData, true);
    this.renderCbarLabels();
    this.renderStrip();
  }

  applyAutoRange(data, snap) {
    const p = this.vp(this.current);
    if (!p.dbAuto || !data) return;
    // Not yet. Keep whatever range is showing and keep the snap armed, so the first
    // frame that *is* data gets it rather than the first frame that merely exists.
    if (!spectrumHasSignal(data)) return;
    const { lo, hi } = this.fitRange(data);
    const k = snap ? 1 : 0.12;
    p.dbMin += (lo - p.dbMin) * k;
    p.dbMax += (hi - p.dbMax) * k;
    this.waterfall.setRange(p.dbMin, p.dbMax);
    this.trace.setRange(p.dbMin, p.dbMax);
    this.renderCbarLabels();
  }

  setStageBadge(text) {
    const n = this._notice;
    if (n) {
      if (performance.now() < n.until) text = n.text;
      else this._notice = null;
    }
    const el = $('#stagebadge');
    if (!el) return;
    el.textContent = text;
    el.hidden = !text;
    el.classList.toggle('pin', text.startsWith('⊓'));
  }

  /**
   * Say something for a few seconds.
   *
   * The stage badge is rewritten every frame by whatever the display is doing, so a
   * message set from outside the loop lasted exactly one frame — which is why opening
   * a capture appeared to say nothing at all. A notice outranks the frame's own badge
   * until it expires.
   */
  notify(text, ms = 6000) {
    this._notice = { text, until: performance.now() + ms };
    this.setStageBadge(text);
  }

  /**
   * Whether the clock wraps at the end of the capture.
   *
   * Remembered, because it is a working preference rather than a property of the
   * capture: someone who wants to watch a burst over and over wants that for every
   * capture they open next, and someone who wants the playhead to stop where the signal
   * stopped wants that every time too.
   */
  setLoop(on) {
    this.engine.loop = on;
    if (on && this.engine.ended) { this.engine.ended = false; }
    const b = $('#loop');
    if (b) { b.classList.toggle('on', on); b.title = on ? 'looping — click to stop at the end' : 'stops at the end — click to loop'; }
    try { localStorage.setItem('sdrflex.loop', on ? '1' : '0'); } catch { /* no store */ }
  }

  /**
   * The node a speaker would attach to: whatever is in front of you, if it is audio.
   *
   * Standing on the Listen block itself counts as standing on its source, so the button
   * means the same thing from either tab rather than disappearing on the one tab where
   * somebody is most likely to look for it.
   */
  listenTarget() {
    const n = this.node();
    if (!n) return null;
    if (n.out.kind === 'audio') return this.engine.node(n.parent) || null;
    return n.out.kind === 'real' ? n : null;
  }

  /** The Listen block already on that node, if it has one. */
  listenNode(src) {
    if (!src) return null;
    return this.engine.children(src.id).find((c) => c.op === 'core.audio') || null;
  }

  /**
   * Mute and unmute, which is all anybody wanted.
   *
   * Muting leaves the block on the graph and takes the voice out of the mixer, because
   * those are different statements: removing the block is "I am done with this channel"
   * and has its own ✕, while this is "not right now". It also means unmuting is instant
   * and keeps the volume and squelch somebody set.
   *
   * The first click is also the gesture a browser requires before it will open an audio
   * context — which is why this creates the block rather than the block being created
   * to make the gesture.
   */
  async toggleListen() {
    const src = this.listenTarget();
    if (!src) return;
    let sink = this.listenNode(src);
    if (sink && this.mixer.has(sink.id)) {
      this.mixer.remove(sink.id);
      this.renderListen();
      this.refresh();
      return;
    }
    if (!sink) {
      this.metrics.beginOp();
      try {
        sink = await this.engine.addNode({ parent: src.id, op: 'core.audio' });
      } catch (err) {
        this.notify(`could not listen to that: ${err.message}`, 6000);
        this.metrics.endOp();
        return;
      }
      this.metrics.endOp();
    }
    const ok = await this.mixer.add(sink.id, this.engine.effectiveTime(sink.parent),
                                    sink.params.volume.value);
    if (!ok) this.setStageBadge('this browser has no audio output');
    this.renderListen();
    this.refresh();
  }

  /** The speaker's two states, and its absence when there is nothing to listen to. */
  renderListen() {
    const b = $('#listen');
    if (!b) return;
    const src = this.listenTarget();
    const sink = this.listenNode(src);
    const on = !!(sink && this.mixer.has(sink.id));
    b.hidden = !src;
    b.classList.toggle('on', on);
    b.title = !src ? 'listen'
      : on ? `muting stops ${this.tag(src)} without removing it`
      : `listen to ${this.tag(src)}`;
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  /**
   * How fast the clock runs, and the one control that says so.
   *
   * Cycles rather than opening a menu: there are three of them, the order is obvious,
   * and a menu for three values is two more clicks than the values are worth. Slower
   * only — this is for hearing something, and a recording played faster than it
   * happened is not easier to hear.
   *
   * Remembered, like the loop flag, because somebody who wants half speed for a weak
   * voice wants it for the next weak voice too.
   */
  setSpeed(v) {
    const speed = SPEEDS.includes(v) ? v : 1;
    this.engine.speed = speed;
    const b = $('#speed');
    if (b) {
      b.textContent = speed === 1 ? '1\u00d7' : `${speed}\u00d7`;
      b.classList.toggle('slow', speed !== 1);
      b.title = speed === 1
        ? 'full speed — click to slow it down'
        : `${speed}\u00d7 speed, ${(1 / speed).toFixed(0)} octave${speed === 0.5 ? '' : 's'} down` +
          ' — click again to cycle';
    }
    try { localStorage.setItem('sdrflex.speed', String(speed)); } catch { /* no store */ }
  }

  setPlaying(on) {
    this.engine.playing = on;
    this._wasPlaying = on;
    const b = $('#play');
    b.textContent = on ? '❚❚' : '▶';
    b.classList.toggle('paused', !on);
  }

  /**
   * The Listen pane. A sink has no picture of its own — what it is doing is *whether*
   * it is doing it, and how loudly. Repeating its parent's waveform here would be a
   * second copy of the tab next door.
   */
  renderAudio() {
    const n = this.node();
    if (!n || n.out.kind !== 'audio') return;
    const src = this.engine.node(n.parent);
    const live = this.mixer.has(n.id);
    const muted = this.mixer.isMuted(n.id);
    const state = !live ? 'stopped' : muted ? 'squelched' : this.engine.playing ? 'playing' : 'paused';
    const lvl = this.mixer.level(n.id);
    const sq = n.params.squelch.value;
    $('#pane-audio').innerHTML = `
      <div class="listenwrap">
        <div class="lspk ${state}">${state === 'playing' ? '\u{1F50A}' : '\u{1F508}'}</div>
        <div class="lmeter">
          <i style="transform:scaleX(${meterLevel(lvl).toFixed(3)})"></i>
          ${sq > 0 ? `<u style="left:${(meterLevel(sq) * 100).toFixed(1)}%" title="squelch"></u>` : ''}
        </div>
        <div class="lstate">${state} \u00b7 ${lvl.toFixed(3)}${sq > 0 ? ` \u00b7 squelch ${sq.toFixed(3)}` : ''}</div>
        <div class="lsrc">${src ? `${this.tag(src)} \u00b7 ${fmtRate(src.out.sampleRate)}` : 'nothing upstream'}</div>
        <div class="lnote">Volume and squelch are in the bar below. The speaker on the
          transport mutes and unmutes without removing anything; the \u2715 on this tab
          stops the audio and removes the block; the transport's pause stops it too.</div>
      </div>`;
  }

  /**
   * The Stream pane.
   *
   * A sink has no picture of its own — what it is doing is *whether* it is doing it, and
   * where to. The same shape as Listen, for the same reason, with one addition: the far
   * end of a UDP socket never answers, so the only honest evidence that this is working
   * is the count of datagrams going out. A number that is not moving is the difference
   * between "nothing is listening" and "nothing is being sent", and only the second one
   * is this tool's fault.
   */
  renderStream() {
    const n = this.node();
    if (!n || n.out.kind !== 'sink') return;
    const src = this.engine.node(n.parent);
    const on = n.params.running.value === 'yes';
    const st = n._sink || {};
    const where = `${n.params.host.value}:${n.params.port.value}`;
    const fmt = `${n.params.format.value} at ${fmtRate(Number(n.params.rate.value) || 0)}`;
    const esc = (x) => String(x).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    $('#pane-stream').innerHTML = `
      <div class="listenwrap">
        <div class="lspk ${st.error ? 'stopped' : on ? 'playing' : 'stopped'}">\u21AA</div>
        <div class="lstate">${on ? (this.engine.playing ? 'sending' : 'armed \u00b7 paused') : 'stopped'}
          \u00b7 ${esc(where)}</div>
        <div class="lsrc">${src ? `${this.tag(src)} \u00b7 ${fmt}` : 'nothing upstream'}</div>
        ${st.error ? `<div class="everr">${esc(st.error)}</div>` : ''}
        <div class="lnote">${st.sent
          ? `${st.sent} datagram${st.sent === 1 ? '' : 's'}, ${(st.bytes / 1024).toFixed(0)} kB sent.
             UDP does not answer, so this counts what left rather than what arrived —
             a number that climbs while the far end says nothing means the far end.`
          : `Nothing sent yet. Set <b>running</b> to yes in the bar below and press play.
             In a container <code>127.0.0.1</code> is the container; point <b>host</b> at
             the machine your decoder is on.`}</div>
      </div>`;
  }

  /**
   * The Export pane.
   *
   * A file sink has no picture either — what it has is a decision about *what* to
   * write and a button. The two shapes are the two things that consume a channel: a
   * WAV at a rate a stock decoder asks for, and IQ with a SigMF sidecar so the channel
   * becomes a capture in its own right.
   */
  renderExport() {
    const n = this.node();
    if (!n || n.out.kind !== 'file') return;
    const src = this.engine.node(n.parent);
    if (!src) { $('#pane-export').innerHTML = '<div class="empty">nothing upstream</div>'; return; }

    const dur = this.engine.duration();
    const pin = this.engine.isPinned(this.channel);
    const span = pin
      ? { t0: pin.params.t0.value, t1: pin.params.t1.value, why: 'the pinned window' }
      : { t0: 0, t1: isFinite(dur) ? dur : Math.max(1, this._tmax), why: isFinite(dur) ? 'the whole capture' : 'everything played so far' };
    const secs = Math.max(0, span.t1 - span.t0);
    const isReal = src.out.kind === 'real';
    const rate = src.out.sampleRate;
    const audioRate = n.params.audioRate.value;

    const mb = (bytes) => (bytes / 1e6).toFixed(1);
    const wavBytes = 44 + Math.floor(secs * audioRate) * 2;
    const iqBytes = Math.floor(secs * rate) * 8;

    $('#pane-export').innerHTML = `
      <div class="exwrap">
        <div class="exhead">${this.tag(src)} · ${fmtRate(rate)} · ${secs.toFixed(2)} s <i>(${span.why})</i></div>
        ${isReal ? `
        <div class="excard">
          <b>Audio — WAV, 16-bit mono</b>
          <span>What multimon-ng, direwolf and dsd read on stdin. Resampled to the rate
                you pick and peak-normalized, so the slicer downstream sees full scale.</span>
          <div class="exrow">
            ${out.AUDIO_RATES.map((r) => `<button class="exrate${r === audioRate ? ' on' : ''}" data-rate="${r}">${r}</button>`).join('')}
            <button class="exgo" data-what="wav">Save ${mb(wavBytes)} MB</button>
          </div>
          <code>multimon-ng -t wav -a POCSAG1200 -a FLEX ${this.tag(src).replace(/[^\w]+/g, '_')}.wav</code>
        </div>` : ''}
        <div class="excard">
          <b>IQ — cf32 + SigMF sidecar</b>
          <span>${isReal ? 'The channel feeding this block' : 'This channel'}, as a capture
                of its own: two files, openable here or anywhere else, carrying where it
                came from and what was done to it.</span>
          <div class="exrow"><button class="exgo" data-what="iq">Save ${mb(iqBytes)} MB</button></div>
        </div>
        <div class="exnote" id="exnote"></div>
      </div>`;

    for (const b of $('#pane-export').querySelectorAll('.exrate')) {
      b.addEventListener('click', () => this.onParam('node', 'audioRate', parseInt(b.dataset.rate, 10)));
    }
    for (const b of $('#pane-export').querySelectorAll('.exgo')) {
      b.addEventListener('click', () => this.doExport(b.dataset.what, span));
    }
  }

  /**
   * Write the thing out. Everything is pulled in chunks with the frame loop given a
   * turn between them, because a minute of a 500 kS/s channel is real work and a
   * frozen tab is indistinguishable from a crash.
   */
  async doExport(what, span) {
    const n = this.node();
    const src = this.engine.node(n.parent);
    const note = $('#exnote');
    const base = (this.engine.root.label + '-' + this.tag(src)).replace(/[^\w.-]+/g, '_');
    const say = (t) => { if (note) note.textContent = t; };

    // IQ comes from the nearest channel; a detector has no IQ of its own
    let from = src;
    while (from && from.out.kind !== 'iq' && what === 'iq') from = this.engine.node(from.parent);
    if (what === 'iq' && !from) { say('nothing upstream carries IQ'); return; }

    this.metrics.beginOp();
    say('reading…');
    try {
      const got = await this.engine.readSpan(what === 'iq' ? from.id : src.id, span.t0, span.t1,
        (f) => say(`reading… ${(f * 100).toFixed(0)}%`));
      if (!got) { say('that block cannot be exported yet'); return; }

      if (what === 'wav') {
        say('resampling…');
        await new Promise((r) => setTimeout(r, 0));
        const target = n.params.audioRate.value;
        const rs = out.resample(got.data, got.sampleRate, target);
        out.save(out.wav(out.normalize(rs), target), `${base}-${target}.wav`);
        say(`saved ${base}-${target}.wav — ${(rs.length / target).toFixed(2)} s at ${target} Hz`);
      } else {
        out.save(out.cf32(got.data), `${base}.sigmf-data`);
        out.save(out.sigmfMeta({
          sampleRate: got.sampleRate,
          centerHz: from.out.centerHz,
          label: this.tag(from),
          from: this.engine.root.label,
          chain: this.engine.path(from.id).map((x) => x.label).join(' > '),
          startS: span.t0,
        }), `${base}.sigmf-meta`);
        say(`saved ${base}.sigmf-data + .sigmf-meta — ${got.count} samples at ${fmtRate(got.sampleRate)}`);
      }
      this.metrics.endOp();
    } catch (err) {
      say(`export failed: ${err.message}`);
    }
  }

  /** The level bar under a Listen tab, so a channel says it is audible from its tab bar. */
  updateAudioIndicators() {
    for (const el of document.querySelectorAll('.tab[data-k] .alvl')) {
      const id = el.closest('.tab').dataset.k;
      el.style.transform = `scaleX(${meterLevel(this.mixer.level(id)).toFixed(3)})`;
      el.closest('.tab').classList.toggle('sq', this.mixer.isMuted(id));
    }
  }

  /** Every channel that has a live Listen block under it, for the breadcrumb mark. */
  audibleChannels() {
    const out = new Set();
    for (const id of this.mixer.voices.keys()) {
      let n = this.engine.node(id);
      while (n && !this.isChannel(n)) n = n.parent ? this.engine.node(n.parent) : null;
      if (n) out.add(n.id);
    }
    return out;
  }

  /**
   * The plot's colors, derived from the colormap rather than from the theme.
   *
   * A waterfall's background is the floor of its color scale — that is what an
   * unfilled row already shows — and every sequential scale runs dark to bright. So
   * Viridis stays dark on a light interface and Paper is light on a dark one, and
   * anything drawn over the plot has to take its contrast from the plot, not from
   * the chrome around it.
   */
  applyStageColors(name) {
    const f = floorColor(name);
    const dark = f.lum < 0.5;
    const ink = dark ? '233,241,245' : '16,23,37';
    const r = document.documentElement.style;
    r.setProperty('--wf-floor', f.rgb);
    r.setProperty('--on-stage', `rgb(${ink})`);
    r.setProperty('--on-stage-dim', `rgba(${ink},.66)`);
    r.setProperty('--stage-veil', dark ? 'rgba(0,0,0,.5)' : 'rgba(255,255,255,.7)');
    r.setProperty('--stage-rule', `rgba(${ink},.14)`);
    r.setProperty('--stage-peak', `rgba(${ink},.5)`);
    r.setProperty('--stage-trace', dark ? '#D2E8E3' : '#12283C');
    // the filled area under the trace, tinted toward the map's own midpoint
    r.setProperty('--stage-fill', dark ? 'rgba(33,145,140,.20)' : 'rgba(42,80,132,.14)');
  }

  /**
   * Theme is a preference about the room, not about the signal, so it is kept per
   * browser and defaults to whatever the operating system says. Three states rather
   * than two: "auto" is a real answer and losing it to a binary toggle means the app
   * stops following the system at dusk.
   */
  setTheme(mode) {
    this.theme = mode;
    const root = document.documentElement;
    if (mode === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);
    try { localStorage.setItem('sdrflex.theme', mode); } catch (_) { /* private mode */ }
    const b = $('#theme');
    if (b) {
      b.textContent = mode === 'light' ? '\u2600' : mode === 'dark' ? '\u263E' : '\u25D0';
      b.title = `theme: ${mode} — click for ${mode === 'auto' ? 'light' : mode === 'light' ? 'dark' : 'auto'}`;
      b.setAttribute('aria-label', `theme: ${mode}`);
    }
    // the waterfall's own colors are baked into a texture, so it has to be told
    if (this.waterfall) this.waterfall.setColormap(this.vp(this.current).colormap);
  }

  /**
   * Open dropped files as the session's source.
   *
   * Nothing here guesses silently: whatever was inferred — format, rate, center — is
   * put on the source node as ordinary parameters, so the first thing you can do
   * after opening a capture is disagree with the guess.
   */
  /**
   * Use the engine on the other end of the socket, if there is one.
   *
   * The same client is served both by a container and by any static host, and which
   * one it is talking to is not worth a build flag or a question: it tries the socket
   * this page would have been served from, and falls back to the in-tab engine when
   * nothing answers. `?engine=mock` forces the fallback, which is how the browser
   * tests keep testing the mock.
   */
  async connectEngine() {
    if (new URLSearchParams(location.search).get('engine') === 'mock') return;
    if (location.protocol === 'file:') return;
    const remote = new RemoteEngine();
    try {
      const hello = await remote.connect();
      this.engine = remote;
      this.remote = true;
      this.hasLibrary = !!hello.captures;
      this.hasRadios = !!hello.radios;
      this.hasPluginDir = !!hello.plugins;
      this.build = hello.version || null;
      this.metrics.build = this.build;
      // On the console rather than on the screen. "Which build is this" is a question
      // somebody asks about twice a month, usually right after a deploy, and a line of
      // permanent chrome answering it is the accretion docs/08 is about. The console is
      // free, it is where somebody already looks when something is wrong, and it is one
      // keystroke away. `curl host:8722/version` is the same answer without a browser.
      if (this.build) {
        // eslint-disable-next-line no-console
        console.info(`sdr-flex — build ${this.build.id}` +
                     `${this.build.git ? ` · git ${this.build.git}` : ''}` +
                     `${this.build.builtAt ? ` · ${this.build.builtAt}` : ''}` +
                     `\n  the page and the engine are served by the same process, so this is both.`);
      }
      remote.onStatus(({ connected }) => {
        if (!connected) this.notify('lost the engine — the page is showing its last frames', 12000);
      });
    } catch {
      // nothing there: the in-tab engine is a complete tool, not a degraded mode
    }
  }

  /**
   * Every decoder that should already be here: the box's, then this browser's.
   *
   * A decoder that ships with the tool belongs in the tool, not in the repository
   * waiting to be dropped on the window; and a file you dropped last time should not
   * have to be dropped again because you reloaded. The box's come first so that a
   * plugin you dropped yourself wins if the two share an id — your copy is the one you
   * were working on.
   */
  async loadPlugins() {
    const said = [];
    if (this.hasPluginDir) {
      try {
        const got = await plugins.loadAll(await this.engine.listPlugins());
        if (got.loaded.length) said.push(`${got.loaded.length} from the server`);
        for (const f of got.failed) this.notify(`${f.filename}: ${f.error}`, 10000);
      } catch (err) { this.notify(`could not read the server's decoders: ${err.message}`, 8000); }
    }
    const mine = await plugins.restore();
    if (mine.loaded.length) said.push(`${mine.loaded.length} you dropped earlier`);
    for (const f of mine.failed) this.notify(`${f.filename} no longer loads and was forgotten: ${f.error}`, 12000);
    if (said.length) this.notify(`decoders ready — ${said.join(', ')}`);
  }

  /** The captures on the box, in the same menu everything else opens in. */
  async openLibrary(x, y) {
    let caps;
    try { caps = await this.engine.listCaptures(); }
    catch (err) { this.notify(`could not read the library: ${err.message}`, 8000); return; }
    if (!caps.length) { this.notify('no captures in the server\u2019s capture directory', 7000); return; }
    const ops = caps.map((c) => ({
      id: c.id,
      name: `${c.label} — ${(c.sampleRate / 1e6).toFixed(3)} MS/s · ${c.durationS.toFixed(1)} s`,
      group: c.sigmf ? 'SigMF' : 'guessed from the filename',
    }));
    const px = x != null ? x : innerWidth / 2, py = y != null ? y : innerHeight - 120;
    // the menu hands back the id it was given, the same as everywhere else it is used
    this.menu.open(px, py, ops, async (id) => {
      const c = caps.find((k) => k.id === id);
      if (!c) return;
      this.metrics.beginOp();
      try {
        this.mixer.removeAll();
        await this.engine.openCapture(id);
        // Which capture this is, in the terms it can be opened by again. The engine's
        // mirror carries a capture's facts and not its library id, because nothing that
        // draws a spectrum has ever needed one — so the window that asked for it is
        // where it is remembered (resume.js).
        this.openedFrom = { kind: 'library', id, label: c.label };
        this.afterOpen(c);
        this.notify(`${c.label} · ${(c.sampleRate / 1e6).toFixed(3)} MS/s · ${c.durationS.toFixed(2)} s` +
                    ` · rate and center from ${c.derived}`);
      } catch (err) {
        this.notify(`could not open that: ${err.message}`, 8000);
      }
      this.metrics.endOp();
    });
  }

  /**
   * The radios this build knows, and what is actually plugged in.
   *
   * A driver whose program is not installed is still listed, greyed, saying what it
   * wants — "rtl_sdr is not installed" is a five-second problem, and a menu that hides
   * the option instead is a twenty-minute one.
   */
  async openRadios(x, y) {
    let drivers;
    try { drivers = await this.engine.listRadios(); }
    catch (err) { this.notify(`could not ask about radios: ${err.message}`, 8000); return; }
    const ops = drivers.map((d) => ({
      id: d.kind,
      // What distinguishes two entries for the same board is not its sample rate, it
      // is what each one needs of you — so a driver that says something about itself
      // says that instead.
      name: d.available
        ? `${d.name} — ${d.blurb || `${(d.defaults.sampleRate / 1e6).toFixed(3)} MS/s`}`
        : `${d.name} — needs ${d.command}`,
      group: d.available ? 'Available' : 'Not installed',
      stub: !d.available,
    }));
    const px = x != null ? x : innerWidth / 2, py = y != null ? y : innerHeight - 120;
    this.menu.open(px, py, ops, async (kind) => {
      const d = drivers.find((k) => k.kind === kind);
      if (!d || !d.available) return;
      // Keep the frequency you were already looking at. Someone who has tuned to a
      // band and then reaches for a radio means that band, not the driver's default.
      const centerHz = this.engine.root ? this.engine.root.out.centerHz : d.defaults.centerHz;
      this.metrics.beginOp();
      this.notify(`starting ${d.name}…`, 20000);
      try {
        this.mixer.removeAll();
        await this.engine.openRadio(kind, { ...d.defaults, centerHz });
        this.afterOpen();
        this.notify(`${d.name} · ${(this.engine.capture.sampleRate / 1e6).toFixed(3)} MS/s` +
                    ` · ${(this.engine.capture.centerHz / 1e6).toFixed(4)} MHz · recording`);
      } catch (err) {
        this.notify(`${d.name} did not start: ${err.message}`, 12000);
      }
      this.metrics.endOp();
    });
  }

  async stopRadio() {
    try {
      await this.engine.stopRadio();
      this.mixer.removeAll();
      this.afterOpen();
      this.notify('radio stopped — the recording is gone with it');
    } catch (err) { this.notify(`could not stop it: ${err.message}`, 8000); }
  }

  /** Everything that has to be forgotten when the source changes under the graph. */
  afterOpen() {
    this.engine.t = 0;
    this._tmax = 0;
    this.channel = this.engine.root.id;
    this.current = this.engine.root.id;
    this.tabs.clear();
    this.viewParams.clear();
    this.setTab('spectrum');
    this.resetSpectrum();
    this._tsCache = null;
    this._bitsSeen = false;
    this.setPlaying(true);
    this.metrics.endOp();
    this.refresh();
  }

  async openFiles(files) {
    if (!files || !files.length) return;
    // A dropped .js is a plugin, not a capture. One gesture, and what it is decides
    // what happens — the same reason the drop target is the whole window.
    const js = [...files].filter((f) => /\.js$/i.test(f.name));
    if (js.length) {
      const names = [];
      for (const f of js) {
        try {
          const p = await plugins.loadFile(f);
          // Kept in this browser, not sent anywhere: a file you dropped is your choice
          // and stays on your machine, and it is still here after a reload.
          plugins.remember(p);
          names.push(p.name);
        } catch (err) { this.notify(`${f.name}: ${err.message}`, 9000); return; }
      }
      this.notify(`loaded ${names.join(', ')} — it is in the menu wherever its input type fits, ` +
                  'and will still be here next time');
      this.refresh();
      return;
    }
    // With the engine on a server the samples are on the server too, so a dropped
    // capture is a file in the wrong place rather than a file in the wrong format.
    if (this.remote) {
      this.notify('this engine reads captures from the box — pick one from the library', 7000);
      this.openLibrary();
      return;
    }
    this.metrics.beginOp();
    try {
      const cap = await fromFiles(files);
      if (!cap.samples) throw new Error('that file has no samples in it');
      this.mixer.removeAll();
      await this.engine.openCapture(cap);
      // A dropped file has no id to open it by again — the browser will not hand the
      // same bytes back without somebody choosing the file. Remembered by name, so the
      // offer after a reload can say that rather than fail halfway through.
      this.openedFrom = { kind: 'file', label: cap.label };
      this.afterOpen();
      this.notify(
        `${cap.label} · ${FORMATS[cap.format].name} · ${(cap.sampleRate / 1e6).toFixed(3)} MS/s` +
        ` · ${cap.durationS.toFixed(2)} s · ` +
        (cap.meta ? 'from SigMF' : 'guessed from the filename — check the rate below'));
    } catch (err) {
      this.notify(`could not open that: ${err.message}`, 8000);
    }
  }

  /**
   * The Bytes pane: a hex dump, and the three numbers that decide whether it is the
   * right one. Slicing a whole capture is a job rather than a frame, so it runs once
   * and says what it found.
   */
  async renderBytes(force) {
    let n = this.node();
    if (!n || n.out.kind !== 'bytes') return;
    const el = $('#pane-bytes');
    const sliced = n._sliced;
    if (!sliced || force) {
      el.innerHTML = '<div class="empty">slicing the capture…</div>';
      await this.engine.sliceBytes(n.id, () => {});
      // Same as the events pane: re-read the node, do not keep the one this started
      // on. A snapshot replaced it, and the slice landed on its replacement.
      const live = this.node();
      if (!live || live.id !== n.id) return;
      n = live;
      // An analyzer derives its parameters from the whole span while it runs, so the
      // strip is stale until it has. Redrawing it here is the difference between a dwell
      // time with the evidence for it and three zeros.
      this.renderStrip();
    }
    const r = n._sliced;
    if (!r) { el.innerHTML = '<div class="empty">nothing to slice yet</div>'; return; }

    const b = r.bytes;
    const rows = Math.min(64, Math.ceil(b.length / 16));
    let dump = '';
    for (let i = 0; i < rows; i++) {
      const off = i * 16;
      const hex = [...b.subarray(off, off + 16)].map((v) => v.toString(16).padStart(2, '0')).join(' ');
      const asc = [...b.subarray(off, off + 16)].map((v) => (v >= 32 && v < 127 ? String.fromCharCode(v) : '·')).join('');
      dump += `${off.toString(16).padStart(6, '0')}  ${hex.padEnd(47)}  ${asc}\n`;
    }
    const sync = n.params.syncHex.value;
    // What a byte stream owes the reader is how it was made, and that differs by what
    // made it. A slicer read a waveform on a symbol grid; a despreader correlated
    // against a code and the sign of the correlation *was* the bit — "samples per
    // symbol" and "grid phase" are not facts about it, and asking for them crashed.
    const how = n.op === 'core.despread'
      ? `${r.bits.toLocaleString()} bits, one per code period of ${r.sps ? r.sps.toFixed(2) : '?'}`
        + ` samples a chip · <code>${r.code || '?'}</code> peaks ${r.psr ? r.psr.toFixed(1) : '?'}×`
        + ` its sidelobes, eye ${r.eye != null ? (r.eye * 100).toFixed(0) + '%' : '?'}`
      : `${r.bits.toLocaleString()} bits at ${r.sps != null ? r.sps.toFixed(2) : '?'} samples/symbol`
        + `${r.phase != null ? ` · grid phase ${r.phase.toFixed(2)}` : ''}`;
    const where = n.op === 'core.despread' ? 'byte' : 'bit';
    el.innerHTML = `
      <div class="bywrap">
        <div class="byhead">
          <b>${b.length.toLocaleString()} bytes</b>
          <span>${how}
          · ${sync ? (r.syncAt >= 0 ? `sync <code>${sync}</code> found at ${where} ${r.syncAt.toLocaleString()}`
                                    : `sync <code>${sync}</code> <u>not found</u> — bytes are packed from the start`)
                   : 'no sync word, so the byte boundary is a guess'}</span>
          <button class="exgo" id="byreslice">Re-slice</button>
        </div>
        <pre class="bydump">${dump}${b.length > rows * 16 ? `\n… ${(b.length - rows * 16).toLocaleString()} more bytes` : ''}</pre>
      </div>`;
    const btn = $('#byreslice');
    if (btn) btn.addEventListener('click', () => { n._sliced = null; this.renderBytes(true); });
  }

  /**
   * What to say when a decoder recognized nothing.
   *
   * "Nothing decoded" is true and useless. Some decoders can say what they *did* see —
   * rtl_433 measures the pulse widths and will name the flex decoder that would read
   * them — and when one does, that is the whole answer: here is the parameter, and here
   * is what the signal says it should be, which is what every derived value in this
   * tool owes the person looking at it (ADR-0017).
   */
  renderNoDecode(r) {
    const e = r.explained;
    if (!e) return '<div class="empty">nothing decoded — the parameters below are the thing to move</div>';
    const esc = (x) => String(x).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    // A measurement and a guess are not the same claim and must not look the same.
    // The pulse widths were counted; the modulation was inferred, and an inference that
    // decodes to something is the most convincing way to be wrong.
    return `<div class="nodec">
      <p><b>None of its built-in decoders matched</b>${e.measured ? ` — it measured ${esc(e.measured)}.` : '.'}</p>
      ${e.suggestion ? `<p class="nodec-sug">${e.guess
          ? `It <em>guesses</em> ${esc(e.guess)} and would read that with`
          : 'It offers'}
        <code>${esc(e.suggestion)}</code>
        <span class="nodec-warn">A guess at the modulation that decodes to something is
        still a guess — if what comes back is one long run of bits rather than repeating
        packets, the modulation is wrong rather than the timings.</span></p>
        <button class="exgo" id="usesug">Try this decoder</button>` : ''}
    </div>`;
  }

  /**
   * Feed every running stream sink the seconds that just went by.
   *
   * One at a time and never overlapping: the push is a round trip and a second one
   * launched before the first returns would send the same seconds twice, which to a
   * decoder on the far end looks like the signal repeating itself.
   *
   * The chunk is taken from the node's own playhead rather than the wall clock, so a
   * pinned clip streams the clip, and slowing the transport down slows what goes out —
   * which is what somebody who slowed it down meant.
   */
  async pumpSinks() {
    if (this._sinkBusy) return;
    const sinks = [...this.engine.nodes.values()].filter(
      (n) => n.op === 'core.stream' && n.params.running.value === 'yes');
    if (!sinks.length) return;
    this._sinkBusy = true;
    try {
      for (const n of sinks) {
        const at = this.engine.effectiveTime(n.parent);
        if (at == null) continue;
        const last = this._sinkAt instanceof Map ? this._sinkAt.get(n.id) : null;
        if (!(this._sinkAt instanceof Map)) this._sinkAt = new Map();
        // Seconds of capture since this sink last sent, clamped: after a scrub the gap
        // is meaningless, and sending it would dump minutes of audio in one burst.
        const secs = last != null && at > last && at - last < 2 ? at - last : SINK_CHUNK_MS / 1000;
        this._sinkAt.set(n.id, at);
        const out = await this.engine.streamPush(n.id, Math.max(0, at - secs), secs);
        const live = this.engine.node(n.id);
        if (live) live._sink = out;
        if (out && out.error && !this._sinkTold) {
          this._sinkTold = true;
          this.notify(`stream out: ${out.error}`, 8000);
        }
      }
    } finally {
      this._sinkBusy = false;
    }
    if (this.view() === 'Stream') this.renderStream();
  }

  /**
   * Decode the blocks the playhead has finished crossing, and keep what they said.
   *
   * The expectation this exists for: "as we get the bursts, we see the decoded values."
   * What shipped was one run over the whole capture that answered when it was done, and
   * on a ninety-second file that is a long wait for a packet that happened at eleven
   * seconds.
   *
   * A *block* rather than a sliding window, for the same reason the symbol sync in front
   * of it now fits per block: a block is the unit over which a decode is a decode, the
   * spans are disjoint so records never need de-duplicating, and re-reading the whole
   * capture every frame would be quadratic in the length of the capture.
   *
   * One at a time. An external decoder is a process, and letting the playhead start a
   * second before the first has answered is how a slow decoder turns into a queue of
   * them — so a block that is not finished simply is not started, and the next tick
   * picks it up.
   */
  async streamRecords() {
    const n = this.node();
    if (!n || n.out.kind !== 'events' || !n.adapter) return;
    if (this._streamBusy) return;
    // A whole-capture run already answered this, and its answer covers every block.
    // Appending to it would double what it found; replacing it would throw away more
    // than this can put back. Opening the pane while paused runs the capture; opening
    // it while playing streams. `Run again` clears both and starts over.
    if (n._records && !n._records.streamed) return;
    const d = this.engine.duration();
    const now = this.engine.effectiveTime(n.id);
    // Only blocks that are wholly behind the playhead: half a block is half a burst,
    // and a decoder handed half a burst reports nothing and looks broken.
    const done = Math.floor(now / STREAM_BLOCK_S);
    if (!(done > 0)) return;
    const seen = (n._blocks = n._blocks || new Set());
    let block = -1;
    for (let b = 0; b < done; b++) if (!seen.has(b)) { block = b; break; }
    if (block < 0) return;
    const t0 = block * STREAM_BLOCK_S;
    const t1 = Math.min(t0 + STREAM_BLOCK_S, isFinite(d) ? d : t0 + STREAM_BLOCK_S);
    seen.add(block);
    this._streamBusy = true;
    let out = null;
    const began = performance.now();
    try {
      out = await this.engine.runRecordsSpan(n.id, t0, t1);
    } catch (err) {
      // A block that failed is not a block that is done: drop it from the set so a
      // later pass can try again rather than leaving a silent hole in the record.
      seen.delete(block);
      this.notify(`decoding ${t0.toFixed(0)}–${t1.toFixed(0)} s failed: ${err.message}`, 6000);
    }
    this._streamBusy = false;
    // The node object may have been replaced by a snapshot while that ran (ADR-0029),
    // so the accumulator is found by id rather than kept.
    const live = this.engine.node(n.id);
    if (!live || !out) return;
    live._blocks = seen;
    const acc = live._records && live._records.streamed
      ? live._records : { records: [], note: '', streamed: true };
    // Appended even when the block said nothing, because the count of blocks read is
    // what makes an empty list readable: "nothing yet" and "nothing in the twelve
    // seconds looked at so far" are different claims, and only one of them is true.
    acc.records = acc.records.concat((out.records || []).map((r) => ({ ...r, at: t0 })));
    acc.slowest = Math.max(acc.slowest || 0, (performance.now() - began) / 1000);

    // Whether this is keeping up is a question about the backlog, not about any one
    // block: the first block of a capture also pays for the symbol sync's grid fit, and
    // calling a whole session slow because of that one would be wrong. What matters is
    // whether the playhead is pulling away from the decoding.
    const total = isFinite(d) ? Math.ceil(d / STREAM_BLOCK_S) : 0;
    const behind = Math.max(0, Math.floor(now / STREAM_BLOCK_S) - seen.size);
    acc.note = `as it plays · ${seen.size}${total ? ` of ${total}` : ''} block` +
               `${seen.size === 1 ? '' : 's'} of ${STREAM_BLOCK_S} s` +
               `${behind > 1 ? ` · ${behind} behind the playhead` : ''}` +
               `${acc.slowest > STREAM_BLOCK_S ? ` · slowest ${acc.slowest.toFixed(1)} s` : ''}`;
    live._records = acc;
    if (this.current === live.id && this.view() === 'Events') this.renderEvents();
  }

  /**
   * The Events pane.
   *
   * It leads with the count, and that is not decoration. A decoder can return many
   * records from one packet — concurrent codes are built on it — and a view that
   * shows the first and lets you assume it is the only one turns "six messages" into
   * "one message and a broken challenge". Ask british_news.
   */
  async renderEvents(force) {
    let n = this.node();
    if (!n || n.out.kind !== 'events') return;
    const el = $('#pane-events');
    // Everything that produces records: a decoder somebody else wrote, a plugin, the
    // framer, and the analyzers that answer a question about the signal rather than
    // decoding it.
    const PRODUCES = ['core.framer', 'core.hopmap'];
    if (!n.plugin && !n.adapter && !PRODUCES.includes(n.op)) {
      el.innerHTML = '<div class="empty">This analyzer has nothing to report yet.</div>';
      return;
    }
    // A streamed decode fills in as the capture plays, so an empty one is not a decode
    // that has not run — it is one that has not reached anything yet, and re-running the
    // whole capture underneath it would throw away what it has.
    const streaming = !!(n._records && n._records.streamed);
    if ((!n._records && !this.engine.playing) || force) {
      el.innerHTML = '<div class="empty">running ' + n.label + '…</div>';
      await new Promise((r) => setTimeout(r, 0));
      await this.engine.runRecords(n.id);
      // By id, not by identity, and then re-read the node.
      //
      // A remote engine replaces every node object whenever a snapshot lands
      // (ADR-0029), so the node this started on is not the node holding the answer.
      // Comparing objects left the pane on "running…" forever; *keeping* the old
      // object was the other half of the same mistake, and it hid better — the first
      // run of a decoder showed nothing and the second showed everything, because by
      // then the results were on the object this call happened to pick up.
      const live = this.node();
      if (!live || live.id !== n.id) return;
      n = live;
      // An analyzer derives its parameters from the whole span while it runs, so the
      // strip is stale until it has. Redrawing it here is the difference between a dwell
      // time with the evidence for it and three zeros.
      this.renderStrip();
    }
    const r = n._records || { records: [] };
    const rows = r.records.map((rec, i) => {
      // `at` is the block a streamed record came out of, and it is a fact about the
      // capture rather than a field the decoder returned — so it is drawn as the
      // timestamp it is rather than mixed in with the decoder's own keys.
      const extra = Object.entries(rec).filter(([k]) => k !== 'text' && k !== 'at')
        .map(([k, v]) => `<span class="evk">${k}</span> ${v}`).join(' ');
      const when = rec.at != null
        ? `<span class="evat" title="the ${STREAM_BLOCK_S} s block it came from">${
            rec.at.toFixed(0)}s</span>` : '';
      return `<li><i>${i + 1}</i>${when}<span class="evt">${(rec.text ?? JSON.stringify(rec))
        .replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</span>${extra}</li>`;
    }).join('');
    el.innerHTML = `
      <div class="evwrap">
        <div class="evhead">
          <b>${r.records.length} record${r.records.length === 1 ? '' : 's'}</b>
          <span>${r.note || n.label}${r.ms != null ? ` · ${r.ms.toFixed(0)} ms` : ''}</span>
          <button class="exgo" id="evrun">Run again</button>
        </div>
        ${r.error ? `<div class="everr">${r.error}</div>` : ''}
        ${r.records.length ? `<ol class="evlist">${rows}</ol>`
          : streaming || (this.engine.playing && n.adapter)
            ? '<div class="empty">listening — records appear as the playhead crosses them</div>'
            : this.renderNoDecode(r, n)}
      </div>`;
    const btn = $('#evrun');
    if (btn) btn.addEventListener('click', () => {
      n._records = null; n._blocks = null; this.renderEvents(true);
    });
    const sug = $('#usesug');
    if (sug) {
      sug.addEventListener('click', async () => {
        // The parameter it belongs in is the one the adapter declared for it.
        const key = n.paramMeta && Object.keys(n.paramMeta).find((k) => /flex|decoder|spec/i.test(k));
        if (!key) return;
        await this.engine.setParam(n.id, key, r.explained.suggestion, 'manual');
        this.renderStrip();
        this.renderEvents(true);
      });
    }
  }

  /**
   * The resource grid: time down, frequency across.
   *
   * A canvas rather than a table because this is a picture — an OFDM grid is hundreds of
   * symbols by tens or hundreds of subcarriers, and which cells carry anything *is* the
   * message. The same view serves anything else that folds into two dimensions.
   */
  async renderGrid(force) {
    let n = this.node();
    if (!n || n.out.kind !== 'grid') return;
    const head = $('#gridhead');
    if (!n._grid || force) {
      head.innerHTML = '<b>reading…</b>';
      await new Promise((r) => setTimeout(r, 0));
      await this.engine.sliceGrid(n.id);
      const live = this.node();
      if (!live || live.id !== n.id) return;
      n = live;
      this.renderStrip();                    // the derived sizes, with their evidence
    }
    const g = n._grid;
    const cv = $('#gridcv');
    if (!g || !g.rows) {
      head.innerHTML = `<b>nothing to draw</b><span>${(g && g.error) || 'no structure found'}</span>`;
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, cv.width, cv.height);
      return;
    }

    const raster = g.kindLabel === 'raster';
    const spacing = g.spacingHz || 0;
    head.innerHTML =
      `<b>${g.rows} × ${g.cols}</b>` +
      `<span>${raster
        ? `${(g.symbolS * 1e6).toFixed(1)} µs per line` +
          `${g.frames > 1 ? ` · ${g.frames} frames averaged` : ''}`
        : `${(g.symbolS * 1e6).toFixed(0)} µs per symbol · ${(spacing / 1e3).toFixed(2)} kHz per subcarrier`}` +
      `${g.confident ? '' : ' · <em>not confident</em>'}</span>` +
      '<button class="exgo" id="gridrun">Read again</button>';
    const btn = $('#gridrun');
    if (btn) btn.addEventListener('click', () => { n._grid = null; this.renderGrid(true); });

    this.drawGrid(cv, g);
    this.renderGridAxis(g);
  }

  /**
   * One pixel block per cell, on a floor relative to the strongest cell in the grid.
   *
   * Relative because the question is which subcarriers carry *anything*, and an absolute
   * threshold would answer a different question on every capture depending on the gain
   * the receiver happened to be using.
   */
  drawGrid(cv, g) {
    const wrap = cv.parentElement;
    const W = Math.max(64, wrap.clientWidth), H = Math.max(64, wrap.clientHeight);
    const dpr = Math.min(2, devicePixelRatio || 1);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let peak = 0;
    for (let i = 0; i < g.data.length; i++) if (g.data[i] > peak) peak = g.data[i];
    const floorDb = this.node().params.floorDb ? this.node().params.floorDb.value : -12;
    const floor = peak * Math.pow(10, floorDb / 20);

    const img = ctx.createImageData(g.cols, g.rows);
    // The same lookup table the waterfall uses, so a grid and a waterfall of the same
    // capture are the same colors meaning the same thing.
    const map = lut(this.vp(this.current).colormap);
    for (let r = 0; r < g.rows; r++) {
      for (let c = 0; c < g.cols; c++) {
        const v = g.data[r * g.cols + c];
        // Normalized between the floor and the peak, in dB, so a faint carrier still
        // reads as present rather than vanishing into the background.
        const db = 20 * Math.log10((v || 1e-12) / peak);
        const t = Math.max(0, Math.min(1, (db - floorDb) / (0 - floorDb)));
        const k = Math.round(t * 255) * 3;
        const o = (r * g.cols + c) * 4;
        img.data[o] = map[k]; img.data[o + 1] = map[k + 1]; img.data[o + 2] = map[k + 2];
        img.data[o + 3] = 255;
      }
    }
    // Blit at grid resolution, then let the canvas scale it up with no smoothing — a
    // resource grid is cells, and a blurred cell is a cell you cannot read.
    const off = new OffscreenCanvas(g.cols, g.rows);
    off.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(off, 0, 0, W, H);
    void floor;
  }

  renderGridAxis(g) {
    const el = $('#gridaxis');
    if (g.kindLabel === 'raster') {
      // A raster's axes are pixels and lines, not frequency: it is a picture of a screen,
      // and labeling it in hertz would be labeling it with the wrong thing entirely.
      el.innerHTML = `<span>${g.cols} px across</span>` +
        `<span>${g.rows} lines · ${(g.rows * g.symbolS * 1e3).toFixed(1)} ms a frame</span>` +
        `<span>${(1 / (g.rows * g.symbolS)).toFixed(1)} Hz refresh</span>`;
      return;
    }
    const span = g.cols * (g.spacingHz || 0);
    const left = (g.centerHz || 0) - span / 2, right = (g.centerHz || 0) + span / 2;
    const label = (hz) => (Math.abs(hz) >= 1e6 ? (hz / 1e6).toFixed(3) + ' MHz' : (hz / 1e3).toFixed(1) + ' kHz');
    el.innerHTML = `<span>${label(left)}</span><span>${g.cols} subcarriers · ` +
                   `${(g.rows * g.symbolS * 1e3).toFixed(1)} ms down the page</span><span>${label(right)}</span>`;
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
    // A capture has a real end, so the rail is the file. The synthetic scene does not,
    // so it is however far this session has got.
    const d = this.engine.duration();
    return { t0: 0, t1: isFinite(d) ? d : Math.max(0.001, this._tmax), pin: null };
  }

  scrubFrac() {
    const { t0, t1, pin } = this.scrubSpan();
    const at = pin ? this.engine.clipPos(pin) : this.engine.t;
    return Math.max(0, Math.min(1, (at - t0) / Math.max(1e-6, t1 - t0)));
  }

  scrubTo(frac) {
    const { t0, t1, pin } = this.scrubSpan();
    const at = t0 + (t1 - t0) * frac;
    this.engine.ended = false;
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
    // Dragging the bar sets the range by hand, so double-clicking it is the obvious way
    // to give the range back to the measurement — right where somebody has just made a
    // mess of it, rather than three levels down behind the fold. Auto has always been
    // there; it was not anywhere you would find it.
    cb.title = 'drag to set the range \u00b7 double-click for auto';
    cb.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.autoRange();
      this.metrics.interaction();
    });

    const MODES = ['auto', 'light', 'dark'];
    this.setTheme(this.theme);
    $('#theme').addEventListener('click', () => {
      this.setTheme(MODES[(MODES.indexOf(this.theme) + 1) % MODES.length]);
      this.renderStage();
      this.metrics.interaction();
    });
    // following the system means following it as it changes, not only at load
    try {
      matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
        if (this.theme === 'auto') this.renderStage();
      });
    } catch (_) { /* older browsers: the initial read still applies */ }

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

    // ── opening a capture ──────────────────────────────────────────────────
    // The whole window is the drop target. A capture is the one thing you bring from
    // outside, and making you aim at a strip of chrome to hand it over is friction
    // for nothing.
    const drop = $('#drop');
    let depth = 0;
    addEventListener('dragenter', (e) => {
      if (![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault(); depth++; drop.hidden = false;
    });
    addEventListener('dragover', (e) => { if (!drop.hidden) e.preventDefault(); });
    addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; drop.hidden = true; } });
    addEventListener('drop', (e) => {
      if (drop.hidden) return;
      e.preventDefault(); depth = 0; drop.hidden = true;
      this.openFiles(e.dataTransfer.files);
    });
    // and a picker, because a phone has no drag and a keyboard user should not need one
    $('#file').addEventListener('change', (e) => { this.openFiles(e.target.files); e.target.value = ''; });

    const step = (dt) => {
      this.engine.ended = false;
      this.engine.t = Math.max(0, Math.min(this.engine.duration(), this.engine.t + dt));
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

    const lb = $('#loop');
    if (lb) lb.addEventListener('click', () => { this.setLoop(!this.engine.loop); this.metrics.interaction(); });
    const sb = $('#listen');
    if (sb) sb.addEventListener('click', () => { this.toggleListen(); this.metrics.interaction(); });
    const sp = $('#speed');
    if (sp) sp.addEventListener('click', () => {
      const i = SPEEDS.indexOf(this.engine.speed || 1);
      this.setSpeed(SPEEDS[(i + 1) % SPEEDS.length]);
      this.metrics.interaction();
    });
    $('#play').addEventListener('click', () => {
      // pressing play at the end of a file means "again", not "stay stopped"
      if (this.engine.ended && !this.engine.playing) {
        this.engine.t = 0; this.engine.ended = false;
        this._tmax = 0; this.resetSpectrum();
      }
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
      // Not while the menu is open: every printable key belongs to its search box then,
      // and `f` meaning both "FM demod" and "type an f" is the kind of ambiguity that
      // makes people stop trusting a keyboard.
      if (this.menu.el.hidden && !e.metaKey && !e.ctrlKey && !e.altKey &&
          Object.prototype.hasOwnProperty.call(HOTKEYS, e.key)) {
        e.preventDefault();
        this.hotkey(e.key);
        return;
      }
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
    // the engine stops itself at the end of a capture, so the button has to notice
    if (this._wasPlaying !== this.engine.playing) this.setPlaying(this.engine.playing);

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
      } else if (this.engine.isLive && this.engine.isLive()) {
        // On a radio the useful fact is not the time, it is how far behind the air you
        // are — zero means you are watching it happen, and anything else means you
        // scrubbed back into the ring and are watching a recording of it.
        const [first, last] = this.engine.span();
        const behind = last - this.engine.t;
        const status = this.engine.capture.status;
        const held = last - first;
        this.setStageBadge(
          status && status !== 'running' ? `◉ radio ${status}`
          : behind < 0.35 ? `◉ live · ${held.toFixed(0)} s of history`
          : `◉ ${behind.toFixed(1)} s behind live · ${held.toFixed(0)} s of history` +
            (this.engine.playing ? '' : ' · paused'));
      } else if (this.engine.ended) {
        this.setStageBadge('⏹ end of capture — press ⟲ to loop, or scrub back');
      } else {
        this.setStageBadge(this.engine.playing ? '' : '▶ paused');
      }

      const pf = this._prefill;
      if (pf) {
        // Oldest first, as many rows as fit in a slice of the frame. Timing the work
        // beats predicting it: the cost per row varies with decimation, cache state
        // and machine, and a formula tuned to one of those is wrong for the others.
        const deadline = performance.now() + 6;
        for (let k = 0; pf.row < pf.rows; k++) {
          if (k > 0 && performance.now() > deadline) break;
          const at = this.prefillTime(pf, pin);
          const f = this.engine.frame(this.current, { ...this.frameOpts(p), at });
          // A row that has not arrived yet is not a row to skip. Advancing past it
          // would leave a gap in the waterfall that never fills, because nothing ever
          // comes back to that moment.
          if (f.kind === 'pending') break;
          if (f.kind === 'spectrum') {
            if (pf.row === 0 && spectrumHasSignal(f.data)) {
              this._autoSnap = false;
              this.applyAutoRange(f.data, true);
            }
            this.waterfall.push(f.data);
            this.trace.push(f.data);
          }
          pf.row++;
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
          const f = this.engine.frame(this.current, this.frameOpts(p));
          if (f.kind === 'spectrum') this._specData = f.data;
        }
        if (this._specData) {
          if (this._autoSnap && spectrumHasSignal(this._specData)) {
            // First spectrum since the context changed: take the range, do not approach
            // it. Cleared here rather than in the prefill loop because a remote engine's
            // first rows come back `pending`, and a snap that only happens on a row that
            // may never arrive is a snap that does not happen.
            this._autoSnap = false;
            this._autoAcc = 0;
            this.applyAutoRange(this._specData, true);
          } else {
            this._autoAcc = (this._autoAcc || 0) + 1;
            if (this._autoAcc > 20) { this._autoAcc = 0; this.applyAutoRange(this._specData, false); }
          }
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
        const f = this.engine.frame(this.current, {
          spanS: p.spanS, trigger: p.trigger,
          ...(this.channels() > 1 ? { channel: p.channel } : {}),
        });
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
    } else if (v === 'Stream') {
      this.renderStream();
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

    // Streaming out, on the same cadence and for the same reason as the audio mixer:
    // the clock is here, so the chunks are taken from here. A sink that is not running
    // costs one property read per tick.
    if (this.engine.playing) {
      this._sinkAcc = (this._sinkAcc || 0) + dt;
      if (this._sinkAcc > SINK_CHUNK_MS) { this._sinkAcc = 0; this.pumpSinks(); }
    }

    // Decoding as it plays. Checked a few times a second rather than every frame: the
    // work is a process per block of capture and the check itself is a comparison, but
    // sixty of them a second is sixty chances to start one early.
    if (this.engine.playing && this.view() === 'Events') {
      this._streamAcc = (this._streamAcc || 0) + dt;
      if (this._streamAcc > 300) { this._streamAcc = 0; this.streamRecords(); }
    }

    // The mixer runs on the AudioContext clock; this only tops its queues up. Each
    // voice follows its own node's playhead, which is what keeps a pinned clip's
    // audio inside the clip.
    if (this.mixer.count) {
      if (this.engine.playing) {
        this.mixer.pump(this.engine, (id) => {
          const n = this.engine.node(id);
          return n ? this.engine.effectiveTime(n.parent) : null;
        });
      }
      this.updateAudioIndicators();
      if (this.view() === 'Listen') this.renderAudio();
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
