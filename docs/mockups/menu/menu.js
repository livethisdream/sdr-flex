/* One list, two kinds of row?
 *
 * The gesture discriminator is settled — `openMenu(x, y, selection)` already exists and
 * already filters, and adding a third answer is a one-line change. What is not settled
 * is the half I wrongly called free: view parameters are not operations. Every row in
 * the catalog today builds a node (`applyOp` → `addNode`); a colormap sets a value and
 * rebuilds nothing. Putting both in one list means the widget carries two row types
 * with two handlers, and the open question is whether that list reads as one thing.
 *
 * So this is a drill, not a gallery. It names a row, times how long you take to find
 * it, and keeps the median per treatment. A treatment that reads as two lists will
 * cost time on the rows that sit in the other half.
 */

const $ = (s, r = document) => r.querySelector(s);

/* ── the real catalog, transcribed from web/src/engine.js ──────────────────── */

// `rank` is ADR-0039's: tier 1 advances the chain (narrow, demodulate, slice, frame,
// decode, listen), tier 2 answers a question beside it.
const OPS = [
  ['Tune here', 'Narrow', ['iq', 'real'], 1, 't', true],
  ['AM demod', 'Demodulate', ['iq'], 1, 'a'],
  ['FM demod', 'Demodulate', ['iq'], 1, 'f'],
  ['SSB demod', 'Demodulate', ['iq'], 1, 's'],
  ['CW demod', 'Demodulate', ['iq'], 1, 'c'],
  ['Stereo decode', 'Demodulate', ['real'], 1, 's'],
  ['PWM / OOK slicer', 'Decode', ['real'], 1],
  ['NRZ slicer', 'Decode', ['real'], 1],
  ['Manchester slicer', 'Decode', ['real'], 1],
  ['Despread (DSSS)', 'Decode', ['iq'], 1],
  ['Differential decode', 'Decode', ['bytes'], 1],
  ['Frames & CRC', 'Decode', ['bytes', 'bits'], 1],
  ['Listen', 'Listen', ['real'], 1, 'l'],
  ['Export', 'Export', ['iq', 'real', 'bytes', 'bits'], 2, 'e'],
  ['Hop map', 'Analyze', ['iq'], 2],
  ['De-hop', 'Narrow', ['iq'], 2],
  ['OFDM grid', 'Analyze', ['iq'], 2],
  ['Raster', 'Analyze', ['iq', 'real'], 2],
  ['To real', 'Convert', ['iq'], 2],
  ['Gain', 'Convert', ['iq', 'real'], 2],
  ['Math', 'Analyze', ['iq', 'real'], 2],
  ['Burst detector', 'Analyze', ['iq'], 2],
].map(([name, group, kinds, rank, key, fromSelection]) =>
  ({ name, group, kinds, rank, key, fromSelection, kind: 'op' }));

// View parameters belong to the *view*, not to the stream type — and the first cut of
// this toy got that wrong, showing Spectrum's seven on a bytes node and making the
// merge look far worse than it is. `app.js` has exactly two `this.view() === …` blocks:
// Spectrum carries seven parameters and Time carries two. Every other view — Bits,
// Bytes, Events, Flow, Audio, Export, Grid — has none at all, so on those the menu is
// operations and nothing else, exactly as it is today.
const VIEW_PARAMS = {
  Spectrum: [['colormap', 'Viridis'], ['fft', '2048 bins'], ['min', '−96 dBFS'],
             ['max', '−18 dBFS'], ['window', 'Hann'], ['avg', '4 frames'], ['speed', '60 rows/s']],
  Time: [['trigger', 'auto'], ['span', '20 ms']],
  Bytes: [],
  Flow: [],
};
// `domain` and `channel` ride along on a real stream, conditionally (app.js:1005).
const RIDERS = [['domain', 'time'], ['channel', 'sum']];

const asParam = ([name, value]) => ({ name, value, kind: 'param', rank: 1, group: 'View' });

const GESTURES = {
  drag:  { label: 'drag a box', head: 'selection · 48.6 kHz', selection: true,  paramRank: 2 },
  click: { label: 'click, no drag', head: 'this view',        selection: false, paramRank: 1 },
  node:  { label: 'right-click the node', head: 'PWM · bytes', selection: false, paramRank: 3 },
};

/* The first cut of this ladder was badly designed: two of its four rungs differed in
 * *order* and two in *marking*, so a result could not say which mattered. Order is now
 * held constant — the gesture's preferred kind leads, then rank — and the rungs differ
 * only in how much the seam is marked. `split` is the null: do not merge at all, and
 * make the parameters cost a click. Without it on the ladder the toy could only ever
 * tell you which merge was best, never whether to merge. */
const TREATMENTS = {
  value:  'values, and keys where they exist',
  ruled:  '+ a hairline at the seam',
  headed: '+ headings over each run',
  split:  'not merged — params behind one row',
};

const FOLD = 6;   // ADR-0039: at most six rows, then `more…` expanding in place

/* `+ 15 more…` is where the time goes, and the reason is that it says nothing. You
 * cannot tell whether what is down there is the thing you came for, so the only move is
 * to open it and look — the fold defers the cost of a long list rather than removing it.
 *
 * Two separate fixes, because they answer different halves of that:
 *
 *   `label`  — the fold row names what it holds, so the decision to open it can be made
 *              without opening it. The catalog already knows; nothing new is needed.
 *   `mode`   — what ends up behind the fold at all. By pure rank, a bare click on an iq
 *              node puts seven view parameters on top and folds ALL FOURTEEN operations,
 *              which is not a tail, it is half the menu's purpose. `mixed` guarantees
 *              both kinds are represented above the fold, so the fold is a tail again.
 */
function foldLabel(hidden) {
  if (!hidden.length) return '';
  // In group mode a folded row stands in for its members, so the honest count is what is
  // behind them — and it has to aggregate. Listing rows one by one produced
  // "1 view option · 1 view option · 1 view option", which is a label that has given up.
  if (st.foldMode === 'groups') {
    const by = new Map();
    for (const r of hidden) {
      const g = r.kind === 'group' ? r.group : (r.kind === 'param' ? 'View' : r.group);
      by.set(g, (by.get(g) || 0) + (r.kind === 'group' ? r.members.length : 1));
    }
    const parts = [...by].sort((a, b) => b[1] - a[1]).map(([g, n]) => `${n} ${g}`);
    return parts.length > 4 ? parts.slice(0, 4).join(' · ') + ` · +${parts.length - 4} more` : parts.join(' · ');
  }
  const ops = hidden.filter((r) => r.kind === 'op').length;
  const par = hidden.filter((r) => r.kind === 'param').length;
  const part = [];
  if (ops) part.push(`${ops} operation${ops === 1 ? '' : 's'}`);
  if (par) part.push(`${par} view option${par === 1 ? '' : 's'}`);
  return part.join(' · ');
}

/* The chain order from ADR-0039's own tier-1 list, then the things that answer a
 * question beside it. Fixed rather than sorted by size, because a group row that moves
 * is a group row nobody learns — the same reason usage counts were rejected. */
const GROUP_ORDER = ['View', 'Narrow', 'Demodulate', 'Decode', 'Listen', 'Export', 'Analyze', 'Convert'];

// Which group the gesture is asking about, hoisted to the front. That is the one
// controlled way context is allowed to move a row.
const LEAD_GROUP = { drag: 'Narrow', click: 'View', node: 'Decode' };

// The leading group expands inline, but it cannot have the whole budget. On a bare
// click the lead is View, View has seven members, and expanding it took all six slots
// and folded every operation — the exact failure the fold control was added to expose,
// reappearing one level down. Three seats are reserved for the other groups.
const LEAD_CAP = FOLD - 3;

/* Fold by depth rather than by importance.
 *
 * One row per group valid here; the variants inside a group are what folds. The fold
 * then holds nothing but more of the kinds already on screen, which is the property the
 * bare count never had — you can guess its contents without opening it.
 *
 * This is not the grouped menu ADR-0039 removed. That one spent rows on *headings* over
 * items it still showed in full, which is how it reached 500 px; these rows stand in for
 * their contents, one instead of five.
 */
function byGroup(all) {
  const lead = LEAD_GROUP[st.gesture] || 'Narrow';
  const order = [lead].concat(GROUP_ORDER.filter((g) => g !== lead));
  const groups = new Map();
  for (const r of all) {
    const g = r.kind === 'param' ? 'View' : r.group;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }

  const out = [], tail = [];
  for (const g of order) {
    const members = groups.get(g);
    if (!members) continue;
    if (g === lead && members.length > LEAD_CAP) {
      out.push(...members.slice(0, LEAD_CAP));
      tail.push(...members.slice(LEAD_CAP));
      continue;
    }
    // The leading group is expanded inline — on a drag, "Tune here" stays one click,
    // which is the whole reason the gesture is a discriminator at all. A group of one
    // shows its member rather than a row standing in for a single thing.
    if (g === lead) out.push(...members.slice(0, LEAD_CAP), ...members.slice(LEAD_CAP));
    else if (members.length === 1 || st.openGroup === g) out.push(...members);
    else out.push({ name: g, kind: 'group', group: g, value: String(members.length), members });
  }
  return out.concat(tail);
}

function foldSplit(all) {
  if (st.foldMode !== 'mixed') return all.slice(0, FOLD);
  const first = all.filter((r) => r.kind === all[0]?.kind);
  const other = all.filter((r) => r.kind !== all[0]?.kind);
  if (!other.length) return all.slice(0, FOLD);
  const a = Math.ceil(FOLD / 2);
  const take = first.slice(0, a).concat(other.slice(0, FOLD - a));
  // keep them in the list's own order so the seam stays a seam
  return all.filter((r) => take.includes(r));
}

/* ── state ─────────────────────────────────────────────────────────────────── */

const st = {
  // The hairline is the default now: of the four rungs it is the one that reads as one
  // list while still saying where the seam is.
  gesture: 'click', treatment: 'ruled', kind: 'iq', view: 'Spectrum',
  foldMode: 'rank', paramsOpen: false, openGroup: null,
  open: false, folded: true, target: null, t0: 0,
  runs: [],            // {treatment, gesture, ms, expanded, hit}
};

/* ── building the list ─────────────────────────────────────────────────────── */

function paramsFor() {
  if (st.gesture === 'node') return [];
  return (VIEW_PARAMS[st.view] || [])
    .concat(st.kind === 'real' ? RIDERS : [])
    .map(asParam);
}

function rows() {
  const g = GESTURES[st.gesture];
  // The same two filters the app already applies: the node's stream type, then
  // whether a selection exists.
  let ops = OPS.filter((o) => o.kinds.includes(st.kind));
  if (!g.selection) ops = ops.filter((o) => !o.fromSelection);
  // A node menu is about the node, not about the picture, so the view's parameters
  // are not its business at all — which is itself part of the answer.
  const params = paramsFor();

  // Order is the same in every treatment: whichever kind the gesture was asking about
  // leads, then ADR-0039's rank, then catalog order.
  const first = g.paramRank === 1 ? 'param' : 'op';
  const ordered = ops.map((o) => ({ ...o }))
    .concat(params.map((p) => ({ ...p, rank: g.paramRank })))
    .sort((a, b) => (a.kind === first ? 0 : 1) - (b.kind === first ? 0 : 1) || a.rank - b.rank);

  if (st.foldMode === 'groups') return byGroup(ordered);
  if (st.treatment !== 'split' || !params.length) return ordered;

  // Not merged: the parameters come out of the list and sit behind one row that opens
  // them in place. Still depth 1 — it is ADR-0039's fold, pointed at a second kind.
  const rest = ordered.filter((r) => r.kind === 'op');
  const gate = { name: 'View options', value: `${params.length}`, kind: 'gate', rank: 2 };
  return st.paramsOpen
    ? rest.concat([gate], params.map((p) => ({ ...p, rank: 2, sub: true })))
    : rest.concat([gate]);
}

function render() {
  const g = GESTURES[st.gesture];
  const all = rows();
  const shown = st.folded ? foldSplit(all) : all;
  const el = $('#menu');

  const rowHtml = (r, i) => `
    <button class="row${r.sub ? ' sub' : ''}${r.kind === 'gate' || r.kind === 'group' ? ' gate' : ''}"
      data-i="${i}" data-name="${r.name}"
      ${r.kind === 'gate' ? 'data-gate="1"' : ''}${r.kind === 'group' ? ` data-group="${r.group}"` : ''}>
      <span class="rt">${r.name}</span>
      ${r.kind === 'param' ? `<span class="val">${r.value}</span>`
        : r.kind === 'gate' ? `<span class="val">${st.paramsOpen ? '−' : r.value + ' ▸'}</span>`
        : r.kind === 'group' ? `<span class="val">${r.value} ▸</span>`
        : r.key ? `<span class="k">${r.key}</span>` : ''}
    </button>`;

  let body = '', lastKind = null;
  shown.forEach((r, i) => {
    const seam = lastKind && r.kind !== lastKind && r.kind !== 'gate' && lastKind !== 'gate';
    if (seam && (st.treatment === 'ruled' || st.treatment === 'headed')) body += '<div class="rule"></div>';
    if (st.treatment === 'headed' && (seam || !lastKind))
      body += `<div class="mh">${r.kind === 'param' ? 'show' : 'do'}</div>`;
    body += rowHtml(r, i);
    lastKind = r.kind;
  });

  const hiddenRows = all.filter((r) => !shown.includes(r));
  const hidden = hiddenRows.length;
  el.innerHTML =
    (st.treatment === 'headed' ? '' : `<div class="mh">${g.head}</div>`) +
    body +
    // The count and the label said the same thing twice — "+ 15 more" beside
    // "14 operations · 1 view option" — and the redundant half was the one being
    // ellipsised away. So the label IS the row: it carries both the size and the kind.
    (hidden ? `<div class="rule"></div>
       <button class="row more" id="more"><span class="rt">+ ${foldLabel(hiddenRows)}</span></button>`
            : st.folded ? '' : `<div class="rule"></div><button class="row more" id="more">− less</button>`);

  el.hidden = !st.open;

  const more = $('#more');
  if (more) more.addEventListener('click', () => { st.folded = !st.folded; render(); measure(); });
  for (const b of el.querySelectorAll('.row[data-name]'))
    b.addEventListener('click', () => {
      // Opening the gate is a click the drill has to charge for — that is the whole
      // cost of not merging, and hiding it would rig the comparison.
      if (b.dataset.gate) { st.paramsOpen = !st.paramsOpen; st.folded = false; render(); measure(); return; }
      // Opening a group is a click the drill charges for, exactly like opening the gate.
      if (b.dataset.group) { st.openGroup = b.dataset.group; st.folded = false; render(); measure(); return; }
      pick(b);
    });

  return { all, shown };
}

/* ── measurement ───────────────────────────────────────────────────────────── */

function measure() {
  const all = rows();
  const shown = st.folded ? foldSplit(all) : all;
  const el = $('#menu');
  const h = el.hidden ? 0 : el.scrollHeight;
  const vh = 720;   // ADR-0039's yardstick: a 720 px laptop viewport
  const pct = (100 * h / vh);
  const hiddenNow = all.filter((r) => !shown.includes(r));
  const opsAbove = shown.filter((r) => r.kind === 'op').length;
  const opRows = all.filter((r) => r.kind === 'op');
  const ops = opRows.length;
  const keyed = opRows.filter((r) => r.key).length;
  const params = all.filter((r) => r.kind === 'param').length;

  $('#nums').innerHTML = `
    <span>rows <b>${all.length}</b> — ${ops} op${ops === 1 ? '' : 's'} · ${params} param${params === 1 ? '' : 's'}${
      params === 0 ? ' <b class="good">(one kind only)</b>' : ''}</span>
    <span>above the fold <b>${shown.length}</b>${
      hiddenNow.length ? ` · folded ${hiddenNow.length} — ${foldLabel(hiddenNow)}` : ''}${
      hiddenNow.length && hiddenNow.every((r) => r.kind === 'op') && opsAbove === 0
        ? ' <b class="bad">every operation is behind the fold</b>' : ''}</span>
    <span>height <b class="${pct > 60 ? 'bad' : pct > 40 ? 'warn' : 'good'}">${h} px</b> · ${pct.toFixed(0)}% of 720</span>
    <span>keyed ops <b class="${keyed / (ops || 1) < 0.5 ? 'warn' : ''}">${keyed} of ${ops}</b>${
      ops && keyed < ops ? ' — the rest show nothing' : ''}</span>
    <span>treatment <b>${TREATMENTS[st.treatment]}</b></span>`;
}

/* ── the drill ─────────────────────────────────────────────────────────────── */

function newTarget() {
  // The pool has to be the same in every treatment or the medians are not comparable,
  // so it is built from the logical contents — every operation and every parameter —
  // rather than from whatever the current treatment happens to be showing. `split`
  // hides the parameters behind a gate; that is a cost it should pay in the timing,
  // not a reason for it to be asked easier questions.
  st.folded = true;
  st.paramsOpen = false;
  // Identical in every mode, or the medians are not comparable: every operation valid
  // here plus every view parameter, regardless of what the current mode collapses.
  const g = GESTURES[st.gesture];
  let ops = OPS.filter((o) => o.kinds.includes(st.kind));
  if (!g.selection) ops = ops.filter((o) => !o.fromSelection);
  const pool = ops.concat(paramsFor());
  if (!pool.length) return;
  st.target = pool[Math.floor(Math.random() * pool.length)];
  st.open = true;
  render(); measure();
  st.t0 = performance.now();
  st._expanded = false;
  paint();
  $('#drill-target').innerHTML =
    `Find: <span class="target">${st.target.name}</span> <span class="q">— click it</span>`;
}

function pick(btn) {
  if (!st.target) return;
  const ms = Math.round(performance.now() - st.t0);
  const hit = btn.dataset.name === st.target.name;
  btn.classList.add(hit ? 'hit' : 'miss');
  if (!hit) { setTimeout(() => btn.classList.remove('miss'), 400); return; }

  st.runs.push({ treatment: st.treatment, gesture: st.gesture, ms,
                 expanded: !st.folded, kind: st.target.kind });
  st.target = null;
  results();
  setTimeout(() => { btn.classList.remove('hit'); $('#drill-target').innerHTML =
    `<span class="q">Hit “another” for the next one.</span>`; }, 260);
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
};

function results() {
  const byT = Object.keys(TREATMENTS).map((t) => {
    const rs = st.runs.filter((r) => r.treatment === t);
    return {
      t, n: rs.length,
      all: median(rs.map((r) => r.ms)),
      op: median(rs.filter((r) => r.kind === 'op').map((r) => r.ms)),
      param: median(rs.filter((r) => r.kind === 'param').map((r) => r.ms)),
    };
  });
  const best = Math.min(...byT.filter((r) => r.n >= 3).map((r) => r.all ?? Infinity));

  $('#res').innerHTML = `
    <table class="res">
      <tr><th>treatment</th><th>n</th><th>median</th><th>finding an op</th><th>finding a param</th></tr>
      ${byT.map((r) => `
        <tr class="${r.n >= 3 && r.all === best ? 'best' : ''}">
          <td>${TREATMENTS[r.t]}</td>
          <td class="n ${r.n < 3 ? 'thin' : ''}">${r.n}</td>
          <td class="n ${r.n < 3 ? 'thin' : ''}">${r.all != null ? r.all + ' ms' : '—'}</td>
          <td class="n thin">${r.op != null ? r.op + ' ms' : '—'}</td>
          <td class="n thin">${r.param != null ? r.param + ' ms' : '—'}</td>
        </tr>`).join('')}
    </table>
    <p class="sub" style="margin:.6rem 0 0;font-size:.76rem">
      ${st.runs.length < 12
        ? `<b>${st.runs.length}</b> run${st.runs.length === 1 ? '' : 's'} — a median needs
           three or more per treatment before it means anything, and this measures
           <em>finding</em>, not understanding.`
        : `The column that matters is the gap between <em>finding an op</em> and
           <em>finding a param</em>. A list that reads as one thing has no gap; a list
           that reads as two makes you look in the wrong half first.`}
    </p>`;
}

/* ── the scene behind it ───────────────────────────────────────────────────── */

const CARR = [[0.17, 0.032, 0.86], [0.38, 0.009, 0.7], [0.5, 0.005, 0.95], [0.63, 0.013, 0.55], [0.81, 0.0045, 0.74]];
const VIR = [[68,1,84],[72,40,120],[62,74,137],[49,104,142],[38,130,142],[31,158,137],[53,183,121],[109,205,89],[180,222,44],[253,231,37]];
const hash = (x, y) => { const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return v - Math.floor(v); };
function lvl(x, n) {
  let v = 0.12 + n * 0.06;
  for (const [at, w, amp] of CARR) { const d = (x - at) / w; v += amp * Math.exp(-d * d * 3.2); }
  return Math.min(1, v);
}
function vir(t) {
  const x = Math.max(0, Math.min(1, t)) * (VIR.length - 1);
  const i = Math.min(VIR.length - 2, Math.floor(x)), f = x - i, a = VIR[i], b = VIR[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
function paint() {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const sp = $('#sp'), wf = $('#wf');
  for (const cv of [sp, wf]) { cv.width = Math.round(cv.clientWidth * dpr); cv.height = Math.round(cv.clientHeight * dpr); }
  {
    const g = sp.getContext('2d'), w = sp.width, h = sp.height;
    g.clearRect(0, 0, w, h);
    g.beginPath();
    for (let i = 0; i <= w; i++) {
      const y = h - lvl(i / w, hash(i, 3)) * (h - 8 * dpr) - 4 * dpr;
      i ? g.lineTo(i, y) : g.moveTo(i, y);
    }
    g.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--trace').trim() || '#D2E8E3';
    g.lineWidth = dpr; g.stroke();
  }
  {
    const g = wf.getContext('2d'), w = wf.width, h = wf.height;
    const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const [R, G, B] = vir(lvl(x / w, hash(x, y)));
      const o = (y * w + x) * 4;
      img.data[o] = R; img.data[o + 1] = G; img.data[o + 2] = B; img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }
  $('#stagewrap').style.background = `rgb(${vir(0).map(Math.round).join(',')})`;
}

/* ── controls ──────────────────────────────────────────────────────────────── */

function controls() {
  const seg = (id, opts, cur) => `<span class="seg" id="${id}">${
    Object.entries(opts).map(([k, v]) =>
      `<button data-k="${k}" class="${k === cur ? 'on' : ''}">${v}</button>`).join('')}</span>`;

  $('#bar2').innerHTML =
    `<span class="lab">gesture</span>${seg('g-sel', Object.fromEntries(
       Object.entries(GESTURES).map(([k, v]) => [k, v.label])), st.gesture)}
     <span class="lab">stream</span>${seg('k-sel', { iq: 'iq', real: 'real', bytes: 'bytes' }, st.kind)}
     <span class="lab">view</span>${seg('v-sel', Object.fromEntries(
       Object.keys(VIEW_PARAMS).map((k) => [k, k])), st.view)}
     <span class="lab">treatment</span>${seg('t-sel', Object.fromEntries(
       Object.keys(TREATMENTS).map((k) => [k, k])), st.treatment)}
     <span class="lab">fold</span>${seg('f-sel',
       { rank: 'by rank', mixed: 'both kinds', groups: 'by group' }, st.foldMode)}`;

  const wire = (id, set) => {
    for (const b of $(`#${id}`).querySelectorAll('button'))
      b.addEventListener('click', () => { set(b.dataset.k); st.folded = true; controls(); render(); measure(); });
  };
  wire('g-sel', (v) => { st.gesture = v; });
  wire('k-sel', (v) => { st.kind = v; });
  wire('v-sel', (v) => { st.view = v; });
  wire('t-sel', (v) => { st.treatment = v; st.paramsOpen = false; });
  wire('f-sel', (v) => { st.foldMode = v; st.openGroup = null; });
}

// Only an explicit `?theme=` pins the palette. Left alone, `web/style.css` already
// resolves all three states on its own — bare `:root` is dark, `[data-theme="light"]`
// is light, and a `prefers-color-scheme` query catches the case where nothing is
// stamped. Forcing dark here overrode a reader who had asked for light.
{
  const t = new URLSearchParams(location.search).get('theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
}

$('#another').addEventListener('click', newTarget);
$('#reset').addEventListener('click', () => { st.runs = []; results(); });

// The menu sits where the gesture ended, which for this toy is a fixed point over the
// waterfall — the thing it has to stay legible against.
st.open = true;
controls(); render(); measure(); results();
requestAnimationFrame(() => { paint(); measure(); });
addEventListener('resize', () => { paint(); measure(); });
