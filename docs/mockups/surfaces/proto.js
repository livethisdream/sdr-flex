/* Surfaces prototype.
 *
 * Three proposals made clickable, because a popunder and a hover are behaviors and a
 * screenshot cannot answer whether they feel worse than what they replace:
 *
 *   1. One bar. The crumb you are standing on opens the rest of the map, so the tab
 *      row folds into the breadcrumb instead of sitting beside it.
 *   2. No parameter strip. Node and view values are summoned — hover a crumb, or `i`
 *      to pin the card open.
 *   3. One menu, three gestures. Operations and view options share the surface that
 *      ADR-0039 already ranks; nothing gets its own button.
 *
 * Everything is fake except the interaction cost, which is counted honestly at the
 * bottom of the page against the budgets in docs/08-ui-principles.md.
 */

const $ = (s, r = document) => r.querySelector(s);

/* ── the scene ─────────────────────────────────────────────────────────────── */

const GRAPH = {
  source: { name: 'rtl-sdr #0', live: true },
  channels: [
    { id: 'A', name: 'fan remote', op: 'Tuner',
      blocks: [{ id: 'am', label: 'AM demod', kind: 'audio' }, { id: 'pwm', label: 'PWM', kind: 'bytes' }] },
    { id: 'B', name: null, op: 'Tuner',
      blocks: [{ id: 'fm', label: 'FM demod', kind: 'audio' }] },
    { id: 'C', name: 'doorbell', op: 'Tuner', blocks: [] },
  ],
};

const PARAMS = {
  A: { title: 'Tuner A · fan remote', rows: [
    ['center', '433.8950', 'MHz', 'mn', 'pinned 12:04 · auto says 433.8930'],
    ['width', '50.0', 'kHz', 'au', 'occupied band + 18% guard'],
    ['decim', '24', '', 'au', '2.4 MS/s → 100 kS/s'],
    ['taps', '129', '', 'au', 'worst alias −58 dB at 441 kHz'],
    ['out', '100.0', 'kS/s', 'ro', ''],
  ] },
  B: { title: 'Tuner B', rows: [
    ['center', '434.0750', 'MHz', 'au', 'strongest bin in the drag'],
    ['width', '12.5', 'kHz', 'au', 'occupied band + 18% guard'],
    ['out', '25.0', 'kS/s', 'ro', ''],
  ] },
  C: { title: 'Tuner C · doorbell', rows: [
    ['center', '433.9200', 'MHz', 'mn', 'pinned 11:58 · auto says 433.9195'],
    ['width', '8.0', 'kHz', 'mn', 'pinned · auto says 10.5'],
    ['out', '16.0', 'kS/s', 'ro', ''],
  ] },
  view: { title: 'Spectrum · waterfall', rows: [
    ['fft', '2048', 'bins', 'au', '≈1.2 kHz per bin at this span'],
    ['window', 'Hann', '', 'au', 'default for an unknown signal'],
    ['avg', '4', '', 'au', ''],
    ['range', '−96 / −18', 'dBFS', 'au', 'p10 to strongest bin'],
    ['map', 'Viridis', '', '', ''],
  ] },
  src: { title: 'rtl-sdr #0', rows: [
    ['center', '433.9200', 'MHz', 'mn', 'tuned by hand'],
    ['rate', '2.400', 'MS/s', 'mn', ''],
    ['gain', '28.0', 'dB', 'au', 'peak 3.1 dB below clip'],
    ['ppm', '0', '', 'mn', ''],
  ] },
};

// The two tiers ADR-0039 defines, plus a third gesture: the bare canvas, which is
// asking about the picture rather than about the signal.
const MENUS = {
  selection: {
    head: 'selection · 48.6 kHz',
    rows: [
      ['Narrow to selection', 't', null], ['AM demod', 'a', null], ['FM demod', 'f', null],
      ['SSB demod', 's', null], ['Burst detect', 'b', null], ['Listen', 'l', null],
    ],
    fold: [['Identify — try every decoder', '?', null], ['CW decode', 'c', null],
           ['Export selection', 'e', null], ['Hop map', null, null], ['OFDM grid', null, null]],
  },
  node: {
    head: 'PWM · bytes',
    rows: [['Frame sync', null, null], ['CRC search', null, null], ['Export bytes', 'e', null],
           ['Rename', null, null], ['Remove', null, null]],
    fold: [['Byte histogram', null, null], ['Send to plugin', null, null]],
  },
  view: {
    head: 'this view',
    rows: [
      ['Colormap', null, 'Viridis'], ['FFT size', null, '2048 bins'], ['dB range', null, '⟲ auto'],
      ['Averaging', null, '4'], ['Window', null, 'Hann'], ['Fit span', '0', null],
    ],
    fold: [['Peak hold', null, 'on'], ['Waterfall speed', null, '1×'], ['Grid lines', null, 'off']],
  },
};

const COLORMAPS = ['Viridis', 'Inferno', 'Paper', 'Ice'];

/* ── state ─────────────────────────────────────────────────────────────────── */

const st = {
  channel: 'A', view: 'pwm', playing: true, map: null, pinned: false,
  statsFor: null, menu: null, foldOpen: false, sub: null, colormap: 'Viridis',
  clicks: 0, travel: 0, lastPt: null,
};

// Clicks and pointer travel are the two numbers docs/08 puts a budget on, so the
// prototype counts them rather than letting them be argued about afterwards.
function charge(e) {
  st.clicks++;
  if (st.lastPt) st.travel += Math.hypot(e.clientX - st.lastPt.x, e.clientY - st.lastPt.y);
  st.lastPt = { x: e.clientX, y: e.clientY };
  tally();
}

const chan = () => GRAPH.channels.find((c) => c.id === st.channel);
const chanLabel = (c) => `${c.id} · ${c.name || c.op}`;
const viewLabel = () => {
  if (st.view === 'spectrum') return 'Spectrum';
  if (st.view === 'flow') return 'Flow';
  const b = chan().blocks.find((x) => x.id === st.view);
  return b ? b.label : 'Spectrum';
};

/* ── the one bar ───────────────────────────────────────────────────────────── */

function renderBar() {
  const c = chan();
  $('#bar').innerHTML = `
    <button class="dev crumb has" data-map="src"><i class="live"></i>${GRAPH.source.name}<i class="car">⌄</i></button>
    <span class="sepc">›</span>
    <button class="crumb has" data-map="chan" data-stats="${c.id}">${chanLabel(c)}<i class="car">⌄</i></button>
    <span class="sepc">›</span>
    <button class="crumb has cur" data-map="view" data-stats="view">${viewLabel()}<i class="car">⌄</i></button>
    <button class="themebtn" title="theme">◐</button>`;

  for (const b of $('#bar').querySelectorAll('.crumb')) {
    b.addEventListener('click', (e) => {
      charge(e);
      openMap(b, b.dataset.map);
    });
    // Hover summons the values. The delay is what stops a card appearing every time
    // the pointer crosses the bar on its way somewhere else.
    let t;
    b.addEventListener('pointerenter', () => {
      if (!b.dataset.stats || st.pinned) return;
      t = setTimeout(() => showStats(b, b.dataset.stats, false), 320);
    });
    b.addEventListener('pointerleave', () => {
      clearTimeout(t);
      if (!st.pinned) hideStats();
    });
  }
}

/* ── the map popunder ──────────────────────────────────────────────────────── */

function mapHtml() {
  const rows = [`<div class="mhead">${GRAPH.source.name}</div>`];
  for (const c of GRAPH.channels) {
    const cur = c.id === st.channel;
    rows.push(`<button class="mrow${cur ? ' cur' : ''}" data-go="${c.id}">
      ${c.id === 'A' ? '<i class="live"></i>' : ''}${chanLabel(c)}
      <span class="key">${c.id.toLowerCase()}</span></button>`);
    if (!cur) continue;
    // Only the channel you are in unfolds its blocks. Every channel's blocks at once
    // is the flow view, and that is a tab, not a popunder.
    const kids = [`<button class="mrow kid${st.view === 'spectrum' ? ' cur' : ''}" data-view="spectrum">Spectrum</button>`]
      .concat(c.blocks.map((b) => `<button class="mrow kid${st.view === b.id ? ' cur' : ''}" data-view="${b.id}">
         ${b.label}<span class="tk">${b.kind}</span></button>`))
      .concat([`<button class="mrow kid${st.view === 'flow' ? ' cur' : ''}" data-view="flow">Flow</button>`]);
    rows.push(`<div class="mkids">${kids.join('')}</div>`);
  }
  rows.push('<div class="msep"></div>');
  rows.push('<button class="mrow" data-new="1">New channel — drag a box<span class="key">/</span></button>');
  return rows.join('');
}

function openMap(anchor, which) {
  const el = $('#map');
  if (st.map === which) { closeAll(); return; }
  closeAll();
  st.map = which;
  el.innerHTML = mapHtml();
  el.hidden = false;
  place(el, anchor);
  anchor.classList.add('open');

  for (const b of el.querySelectorAll('[data-go]')) b.addEventListener('click', (e) => {
    charge(e); st.channel = b.dataset.go; st.view = 'spectrum'; closeAll(); renderBar(); });
  for (const b of el.querySelectorAll('[data-view]')) b.addEventListener('click', (e) => {
    charge(e); st.view = b.dataset.view; closeAll(); renderBar(); });
  for (const b of el.querySelectorAll('[data-new]')) b.addEventListener('click', (e) => {
    charge(e); closeAll(); flash('Drag a box on the spectrum.'); });
}

// Anchored under its crumb, clamped to the device rather than the window, because the
// device here is a frame inside a page.
function place(el, anchor, dx = 0, dy = 4) {
  const d = $('#device').getBoundingClientRect();
  const a = anchor.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  let x = a.left - d.left + dx, y = a.bottom - d.top + dy;
  x = Math.max(6, Math.min(x, d.width - w - 6));
  y = Math.min(y, d.height - h - 6);
  el.style.left = `${x}px`; el.style.top = `${y}px`;
}

/* ── the stats card ────────────────────────────────────────────────────────── */

function showStats(anchor, key, pinned) {
  const p = PARAMS[key];
  if (!p) return;
  const el = $('#stats');
  st.statsFor = key; st.pinned = pinned;
  el.className = `stats${pinned ? ' pinned' : ''}`;
  el.innerHTML = `
    <div class="shead">${p.title}${pinned ? '<span class="pinmark">pinned · esc</span>' : ''}</div>
    ${p.rows.map(([k, v, u, mode, ev]) => `
      <div class="srow ${mode}">
        <span class="sk">${k}</span>
        <span class="sv">${v}</span>${u ? `<span class="su">${u}</span>` : ''}
        ${ev ? `<span class="ev">${ev}</span>` : ''}
      </div>`).join('')}
    <div class="foot">${pinned
      ? 'Pinned cards stay through a drag, which is what law 12 needs them to do.'
      : '<kbd>i</kbd> pins this open · click a row to edit'}</div>`;
  el.hidden = false;
  place(el, anchor);
}
function hideStats() { $('#stats').hidden = true; st.statsFor = null; st.pinned = false; }

/* ── one menu, three gestures ──────────────────────────────────────────────── */

function openMenu(which, x, y) {
  closeAll();
  const m = MENUS[which];
  st.menu = which; st.foldOpen = false; st.sub = null;
  drawMenu(m);
  const el = $('#ctx');
  el.hidden = false;
  const d = $('#device').getBoundingClientRect();
  el.style.left = `${Math.max(6, Math.min(x, d.width - el.offsetWidth - 6))}px`;
  el.style.top = `${Math.max(6, Math.min(y, d.height - el.offsetHeight - 6))}px`;
}

function drawMenu(m) {
  const el = $('#ctx');
  const row = ([label, key, val], i) => `
    <button class="crow" data-i="${i}" data-label="${label}">
      ${label}
      ${val ? `<span class="cv">${label === 'Colormap' ? st.colormap : val}</span>` : ''}
      ${key ? `<span class="key">${key}</span>` : ''}
    </button>`;

  // The colormap fold opens in place, in the same menu, at the same position — the
  // thing ADR-0039 chose precisely so that depth stays at 1.
  const sub = st.sub === 'Colormap' ? `
    <div class="csep"></div>
    <div class="chead">colormap</div>
    ${COLORMAPS.map((c) => `<button class="crow sub${c === st.colormap ? ' on' : ''}" data-map="${c}">${c}</button>`).join('')}` : '';

  el.innerHTML = `
    <div class="chead">${m.head}</div>
    ${m.rows.map(row).join('')}
    ${sub}
    ${m.fold.length ? `
      <div class="csep"></div>
      <button class="crow more" id="morebtn">${st.foldOpen ? '− less' : `+ ${m.fold.length} more…`}</button>
      <div class="fold" ${st.foldOpen ? '' : 'hidden'}>${m.fold.map(row).join('')}</div>` : ''}`;

  const more = $('#morebtn', el);
  if (more) more.addEventListener('click', (e) => { charge(e); st.foldOpen = !st.foldOpen; drawMenu(m); });
  for (const b of el.querySelectorAll('.crow[data-label]')) b.addEventListener('click', (e) => {
    charge(e);
    const label = b.dataset.label;
    if (label === 'Colormap') { st.sub = st.sub === 'Colormap' ? null : 'Colormap'; drawMenu(m); return; }
    closeAll(); flash(`${label} — not wired up; this is a layout study.`);
  });
  for (const b of el.querySelectorAll('.crow[data-map]')) b.addEventListener('click', (e) => {
    charge(e); st.colormap = b.dataset.map; PARAMS.view.rows[4][1] = st.colormap;
    closeAll(); });
}

function closeAll() {
  $('#map').hidden = true; $('#ctx').hidden = true;
  st.map = null; st.menu = null;
  for (const b of document.querySelectorAll('.crumb.open')) b.classList.remove('open');
  if (!st.pinned) hideStats();
}

function flash(msg) {
  const h = $('#flash');
  h.textContent = msg; h.hidden = false;
  clearTimeout(flash._t);
  flash._t = setTimeout(() => { h.hidden = true; }, 2200);
}

/* ── the canvas ────────────────────────────────────────────────────────────── */

const CARRIERS = [
  { at: 0.17, w: 0.032, amp: 0.86 }, { at: 0.38, w: 0.009, amp: 0.70 },
  { at: 0.50, w: 0.005, amp: 0.95 }, { at: 0.63, w: 0.013, amp: 0.55 },
  { at: 0.81, w: 0.0045, amp: 0.74 },
];
const MAPS = {
  Viridis: [[68,1,84],[72,40,120],[62,74,137],[49,104,142],[38,130,142],[31,158,137],[53,183,121],[109,205,89],[180,222,44],[253,231,37]],
  Inferno: [[0,0,4],[31,12,72],[85,15,109],[136,34,106],[186,54,85],[227,89,51],[249,140,10],[249,201,50],[252,255,164],[252,255,200]],
  Paper:   [[255,255,255],[226,232,240],[190,204,221],[150,178,205],[110,150,190],[76,120,170],[48,90,145],[28,62,110],[14,36,72],[5,14,33]],
  Ice:     [[3,5,26],[12,27,68],[17,55,110],[16,88,148],[22,124,176],[52,160,196],[100,194,212],[160,220,230],[212,240,245],[245,252,255]],
};
function ramp(name, t) {
  const S = MAPS[name] || MAPS.Viridis;
  const x = Math.max(0, Math.min(1, t)) * (S.length - 1);
  const i = Math.min(S.length - 2, Math.floor(x)), f = x - i, a = S[i], b = S[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
// A sine is not noise. The first version used one and it read as ripple on the trace
// and as diagonal moire on the waterfall — a regular pattern where the eye expects a
// floor. This is the usual fract-sin hash, which is cheap and has no visible period.
function hash(x, y) {
  const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return v - Math.floor(v);
}

function level(x, t, n) {
  let v = 0.12 + n * 0.06;
  for (const c of CARRIERS) {
    const d = (x - c.at) / c.w;
    const gate = c.w < 0.006 ? (Math.sin(t * 5.5) > -0.2 ? 1 : 0.06) : 1;
    v += c.amp * gate * Math.exp(-d * d * 3.2);
  }
  return Math.min(1, v);
}

let T = 0;
function frame() {
  const sp = $('#sp'), wf = $('#wf');
  const dpr = Math.min(2, devicePixelRatio || 1);

  for (const cv of [sp, wf]) {
    const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; cv._fresh = true; }
  }

  if (st.playing) T += 0.05;

  // Spectrum
  {
    const g = sp.getContext('2d'), w = sp.width, h = sp.height;
    g.clearRect(0, 0, w, h);
    const trace = getComputedStyle(document.documentElement).getPropertyValue('--trace').trim() || '#D2E8E3';
    for (const [alpha, seed] of [[0.3, 1], [1, 0]]) {
      g.beginPath();
      for (let i = 0; i <= w; i++) {
        // the dim pass is a peak hold: the same scene with the noise biased up
        const v = level(i / w, T, seed ? 0.85 : hash(i, Math.floor(T * 20)));
        const y = h - v * (h - 8 * dpr) - 4 * dpr;
        i ? g.lineTo(i, y) : g.moveTo(i, y);
      }
      g.globalAlpha = alpha; g.strokeStyle = trace; g.lineWidth = dpr; g.stroke();
      g.globalAlpha = 1;
    }
  }

  // Waterfall: shift the canvas down a row and draw the new one at the top, which is
  // what makes a paused view actually hold rather than scroll identical frames.
  {
    const g = wf.getContext('2d'), w = wf.width, h = wf.height;
    const rows = wf._fresh ? h : (st.playing ? Math.max(1, Math.round(dpr)) : 0);
    if (rows) {
      if (!wf._fresh) g.drawImage(wf, 0, rows);
      const img = g.createImageData(w, rows);
      for (let y = 0; y < rows; y++) {
        const t = T - y * 0.05;
        for (let x = 0; x < w; x++) {
          const [R, G, B] = ramp(st.colormap, level(x / w, t, hash(x, Math.round(t * 20))));
          const o = (y * w + x) * 4;
          img.data[o] = R; img.data[o + 1] = G; img.data[o + 2] = B; img.data[o + 3] = 255;
        }
      }
      g.putImageData(img, 0, 0);
      wf._fresh = false;
    }
  }

  $('#stage').style.setProperty('--wf-floor', `rgb(${ramp(st.colormap, 0).map(Math.round).join(',')})`);
  requestAnimationFrame(frame);
}

/* ── gestures on the stage ─────────────────────────────────────────────────── */

function wireStage() {
  const stage = $('#stage'), box = $('#selbox');
  let drag = null;

  stage.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return;
    closeAll();
    const r = stage.getBoundingClientRect();
    drag = { x0: e.clientX - r.left, moved: false, r };
    stage.setPointerCapture(e.pointerId);
  });

  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const x = e.clientX - drag.r.left;
    if (Math.abs(x - drag.x0) < 4) return;
    drag.moved = true;
    box.hidden = false;
    box.style.left = `${Math.min(drag.x0, x)}px`;
    box.style.width = `${Math.abs(x - drag.x0)}px`;
  });

  stage.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const r = drag.r, moved = drag.moved;
    drag = null;
    charge(e);
    // A drag asks about the signal; a bare click asks about the picture. Same menu,
    // different first tier — the discriminator ADR-0039 already had for free.
    openMenu(moved ? 'selection' : 'view', e.clientX - $('#device').getBoundingClientRect().left,
             e.clientY - $('#device').getBoundingClientRect().top);
    if (!moved) box.hidden = true;
  });

  stage.addEventListener('contextmenu', (e) => {
    e.preventDefault(); charge(e);
    const d = $('#device').getBoundingClientRect();
    openMenu('node', e.clientX - d.left, e.clientY - d.top);
  });
}

/* ── the tally ─────────────────────────────────────────────────────────────── */

// Only what is on screen with nothing open. A summoned surface is not chrome; that is
// the whole claim being tested here, so it must not be counted as though it were.
const SURFACES_NOW = [
  ['breadcrumb row', 1], ['block tab row', 1], ['parameter strip', 1], ['transport', 1],
  ['color bar', 1], ['splitter', 1],
];
const SURFACES_PROPOSED = [['one bar', 1], ['transport', 1], ['color bar', 1], ['splitter', 1]];
const MENUS_NOW = ['drag-release menu', '`+` palette', 'Identify button', 'node right-click menu', 'parameter popovers', 'crumb `✕` / tab `✕`'];
const MENUS_PROPOSED = ['one menu (selection · node · view)', 'the map popunder', 'the stats card'];

function tally() {
  $('#tally').innerHTML = `
    <span>clicks this session <b>${st.clicks}</b></span>
    <span>pointer travel <b>${Math.round(st.travel)} px</b></span>
    <span>persistent surfaces <b class="good">${SURFACES_PROPOSED.length}</b> (today ${SURFACES_NOW.length})</span>
    <span>distinct menu kinds <b class="good">${MENUS_PROPOSED.length}</b> (today ${MENUS_NOW.length})</span>`;
}

/* ── keys ──────────────────────────────────────────────────────────────────── */

addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { st.pinned = false; closeAll(); return; }
  if (e.key === 'i') {
    const c = $('#bar .crumb[data-stats]');
    if (st.pinned) { st.pinned = false; hideStats(); }
    else showStats(c, st.channel, true);
    return;
  }
  if (e.key === ' ') { e.preventDefault(); st.playing = !st.playing; $('#play').textContent = st.playing ? '❚❚' : '▶'; return; }
  if (e.key === '/') { const d = $('#device').getBoundingClientRect(); openMenu('view', d.width / 2 - 120, 120); }
});

addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#ctx, #map, #stats, #bar')) { if (!e.target.closest('#stage')) closeAll(); }
});

/* ── go ────────────────────────────────────────────────────────────────────── */

$('#play').addEventListener('click', (e) => {
  charge(e); st.playing = !st.playing; $('#play').textContent = st.playing ? '❚❚' : '▶';
});
$('#reset').addEventListener('click', () => { st.clicks = 0; st.travel = 0; st.lastPt = null; tally(); });

$('#cmp').innerHTML = `
  <table class="cmp">
    <tr><th>persistent surface</th><th>today</th><th>proposed</th></tr>
    ${SURFACES_NOW.map(([n]) => {
      const keep = SURFACES_PROPOSED.some(([m]) => m === n || (n === 'breadcrumb row' && m === 'one bar'));
      return `<tr class="${keep ? '' : 'gone'}"><td>${n}</td><td class="n">1</td><td class="n">${keep ? '1' : '0'}</td></tr>`;
    }).join('')}
    <tr><th>menu kind</th><th>today</th><th>proposed</th></tr>
    ${MENUS_NOW.map((n) => `<tr class="gone"><td>${n}</td><td class="n">1</td><td class="n">0</td></tr>`).join('')}
    ${MENUS_PROPOSED.map((n) => `<tr><td>${n}</td><td class="n">—</td><td class="n">1</td></tr>`).join('')}
  </table>`;

document.documentElement.dataset.theme =
  new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
renderBar(); wireStage(); tally(); requestAnimationFrame(frame);
