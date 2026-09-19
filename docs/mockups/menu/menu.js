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

/* ── state ─────────────────────────────────────────────────────────────────── */

const st = {
  gesture: 'click', treatment: 'value', kind: 'iq', view: 'Spectrum',
  paramsOpen: false,
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
  const shown = st.folded ? all.slice(0, FOLD) : all;
  const el = $('#menu');

  const rowHtml = (r, i) => `
    <button class="row${r.sub ? ' sub' : ''}${r.kind === 'gate' ? ' gate' : ''}"
      data-i="${i}" data-name="${r.name}" ${r.kind === 'gate' ? 'data-gate="1"' : ''}>
      <span class="rt">${r.name}</span>
      ${r.kind === 'param' ? `<span class="val">${r.value}</span>`
        : r.kind === 'gate' ? `<span class="val">${st.paramsOpen ? '−' : r.value + ' ▸'}</span>`
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

  const hidden = all.length - shown.length;
  el.innerHTML =
    (st.treatment === 'headed' ? '' : `<div class="mh">${g.head}</div>`) +
    body +
    (hidden ? `<div class="rule"></div><button class="row more" id="more">+ ${hidden} more…</button>`
            : st.folded ? '' : `<div class="rule"></div><button class="row more" id="more">− less</button>`);

  el.hidden = !st.open;

  const more = $('#more');
  if (more) more.addEventListener('click', () => { st.folded = !st.folded; render(); measure(); });
  for (const b of el.querySelectorAll('.row[data-name]'))
    b.addEventListener('click', () => {
      // Opening the gate is a click the drill has to charge for — that is the whole
      // cost of not merging, and hiding it would rig the comparison.
      if (b.dataset.gate) { st.paramsOpen = !st.paramsOpen; st.folded = false; render(); measure(); return; }
      pick(b);
    });

  return { all, shown };
}

/* ── measurement ───────────────────────────────────────────────────────────── */

function measure() {
  const { all, shown } = { all: rows(), shown: st.folded ? rows().slice(0, FOLD) : rows() };
  const el = $('#menu');
  const h = el.hidden ? 0 : el.scrollHeight;
  const vh = 720;   // ADR-0039's yardstick: a 720 px laptop viewport
  const pct = (100 * h / vh);
  const opRows = all.filter((r) => r.kind === 'op');
  const ops = opRows.length;
  const keyed = opRows.filter((r) => r.key).length;
  const params = all.filter((r) => r.kind === 'param').length;

  $('#nums').innerHTML = `
    <span>rows <b>${all.length}</b> — ${ops} op${ops === 1 ? '' : 's'} · ${params} param${params === 1 ? '' : 's'}${
      params === 0 ? ' <b class="good">(one kind only)</b>' : ''}</span>
    <span>above the fold <b>${shown.length}</b></span>
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
  const pool = rows().filter((r) => r.kind !== 'gate')
    .concat(st.treatment === 'split' ? paramsFor() : []);
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
       Object.keys(TREATMENTS).map((k) => [k, k])), st.treatment)}`;

  const wire = (id, set) => {
    for (const b of $(`#${id}`).querySelectorAll('button'))
      b.addEventListener('click', () => { set(b.dataset.k); st.folded = true; controls(); render(); measure(); });
  };
  wire('g-sel', (v) => { st.gesture = v; });
  wire('k-sel', (v) => { st.kind = v; });
  wire('v-sel', (v) => { st.view = v; });
  wire('t-sel', (v) => { st.treatment = v; st.paramsOpen = false; });
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
