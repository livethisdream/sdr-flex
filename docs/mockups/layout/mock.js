/* Layout mockups — chrome study.
 *
 * Five screens built from the app's own stylesheet, differing only in where the bars
 * go. Every screen paints the same synthetic scene from the same seed, so a
 * comparison between two of them is a comparison of layout and nothing else, and the
 * chrome figures under each are measured off the rendered DOM rather than typed in.
 */

const PRESETS = {
  '1440': [1440, 900],   // the laptop the budgets in docs/08 were written against
  '1280': [1280, 800],
  '1024': [1024, 700],   // where the chrome bill is worst as a fraction
  '390': [390, 844],     // a phone, held tall
};

/* ── the pieces every screen is assembled from ─────────────────────────────── */

const crumbs = () => `
  <div class="crumbs">
    <button class="dev"><i class="live"></i>rtl-sdr #0<i class="devopen">⌄</i></button>
    <span class="sepc">›</span>
    <button class="crumb cur">A · fan remote<i class="x" role="button" title="remove">✕</i></button>
    <span class="sepc">›</span>
    <button class="crumb dim">B · Tuner</button>
  </div>`;

const tabs = () => `
  <div class="tabs">
    <button class="tab">Spectrum</button>
    <button class="tab on">AM demod<span class="tk">audio</span><i class="x" role="button" title="remove">✕</i></button>
    <button class="tab">PWM<span class="tk">bytes</span></button>
    <button class="tab">Flow</button>
    <button class="tab ident-btn">Identify</button>
    <button class="tab plus">+</button>
  </div>`;

const stage = (extra = '') => `
  <div class="panes"><div class="pane">
    <div class="stage${extra ? ' hosts-path' : ''}">
      ${extra}
      <canvas class="sp"></canvas>
      <div class="splitter"></div>
      <canvas class="wf"></canvas>
    </div>
    <div class="axis">
      <span>433.720</span><span>433.820</span><span>433.920 MHz</span><span>434.020</span><span>434.120</span>
    </div>
  </div></div>`;

const transport = () => `
  <div class="transport">
    <button class="tbtn">◀◀</button>
    <button class="tbtn play">❚❚</button>
    <button class="tbtn">▶▶</button>
    <span class="mono clock">12.331 s</span>
    <button class="track"><i style="width:46%"></i></button>
  </div>`;

const pill = (mode, value, unit, scrub) =>
  `<button class="pill ${mode}${scrub ? ' scrub' : ''}">${
    mode === 'au' || mode === 'mn' ? '<i class="dot"></i>' : ''
  }<span class="pv">${value}</span>${unit ? `<span class="pu">${unit}</span>` : ''}</button>`;

const strip = () => `
  <div class="strip">
    <div class="pgroup"><span class="ptitle">Tuner A</span>
      ${pill('mn', '433.8950', 'MHz', true)}${pill('au', '50.0', 'kHz', true)}
      <button class="pill more">⋯</button>
    </div>
    <div class="pgroup"><span class="ptitle">Waterfall</span>
      ${pill('au', '2048', 'bins')}${pill('pl', 'Viridis', '')}
      <button class="pill more">⋯</button>
    </div>
  </div>`;

/* ── the five screens ──────────────────────────────────────────────────────── */

const SCREENS = [
  {
    key: 'today',
    name: 'Today',
    why: `The baseline, measured rather than remembered. <b>Four full-width rows.</b> The
          breadcrumb fills 150 px of a 1385 px row and the tab strip 152 px of 1440 —
          both about <b>11 % full</b> — and the dock stacks two centered pills that
          together are 952 px wide inside a 1440 px window. Chrome is a flat 174 px at
          every width, so it costs nothing on a desktop and a quarter of a 700 px
          laptop.`,
    html: () => `
      <div class="app">
        <div class="topbar">${crumbs()}<button class="themebtn">◐</button></div>
        ${tabs()}
        ${stage()}
        <div class="dock">${transport()}${strip()}</div>
      </div>`,
  },
  {
    key: 'path',
    name: 'One path',
    why: `The two top rows say the same kind of thing — <b>where you are</b> — and
          neither fills. Merged, they read left to right as a single path:
          <b>source › channel │ view</b>. Nothing moves except the rule between them.
          The doc argued tabs need no channel prefix because the highlighted crumb sits
          directly above; here it sits directly <em>beside</em>, which is a shorter
          distance for the eye to carry the letter.
          <span class="risk">Watch:</span> a deep chain plus many blocks competes for
          one row — the tab run has to scroll, and on a phone the crumb collapses to
          the current channel.`,
    html: () => `
      <div class="app">
        <div class="path">${crumbs()}<span class="sep"></span>${tabs()}<button class="themebtn">◐</button></div>
        ${stage()}
        <div class="dock">${transport()}${strip()}</div>
      </div>`,
  },
  {
    key: 'ends',
    name: 'Two ends',
    why: `<b>One path row on top, one dock row at the bottom.</b> The transport and the
          options pill already fit side by side at every width above a phone — 952 px
          of 1440, 899 of 1024 — so stacking them was buying a second row nothing
          needed. The transport keeps the left, state takes the right, and the two
          stack again below 640 px where they genuinely do not fit.
          Play controls stay exactly where they are.`,
    html: () => `
      <div class="app">
        <div class="path">${crumbs()}<span class="sep"></span>${tabs()}<button class="themebtn">◐</button></div>
        ${stage()}
        <div class="dock row">${transport()}${strip()}</div>
      </div>`,
  },
  {
    key: 'state-up',
    name: 'State up top',
    why: `The strip moves into the <b>89 % of the top row that is empty</b>, and the
          bottom is left holding only the thing you liked there. Identity on the left,
          views in the middle, state on the right — one row that answers
          <em>where am I</em> and <em>what is it set to</em>, and a single thin pill at
          the foot.
          <span class="risk">Watch:</span> this is the one scheme that spends pointer
          travel. A box drawn low on the waterfall is ~600 px from a parameter at the
          top, against a budget of <b>120 px per operation after a selection drag</b>.
          It has to be argued, not assumed.`,
    html: () => `
      <div class="app">
        <div class="path">${crumbs()}<span class="sep"></span>${tabs()}${strip()}<button class="themebtn">◐</button></div>
        ${stage()}
        <div class="dock">${transport()}</div>
      </div>`,
  },
  {
    key: 'float',
    name: 'Float the path',
    why: `<b>Zero top chrome.</b> A spectrum trace lives in the lower two-thirds of its
          pane; the headroom above it is the emptiest region on the screen and it is
          already inside the canvas. The path floats there as two pills, the dock keeps
          one real row, and the waterfall gets the full window.
          The lesson already on the books is that chrome must not cover <em>the axis</em>
          — that is what failed before, and the axis here is untouched.
          <span class="risk">Watch:</span> a strong peak can reach the top of the
          spectrum pane and go under a pill. Whether that is acceptable depends on
          whether the auto dB range keeps the peak off the ceiling, which is
          measurable, not a matter of taste.`,
    html: () => `
      <div class="app">
        ${stage(`<div class="floatpath">${crumbs()}${tabs()}</div>`)}
        <div class="dock row">${transport()}${strip()}</div>
      </div>`,
  },
];

/* ── the synthetic scene ───────────────────────────────────────────────────── */

// One seed for every screen, so two screens are never comparing different signals.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// Viridis, sampled at eight stops and interpolated — close enough to read as the real
// colormap, and it saves shipping a table to a drawing that is not the point.
const VIRIDIS = [
  [68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142],
  [38, 130, 142], [31, 158, 137], [53, 183, 121], [109, 205, 89],
  [180, 222, 44], [253, 231, 37],
];
function viridis(t) {
  const x = Math.max(0, Math.min(1, t)) * (VIRIDIS.length - 1);
  const i = Math.min(VIRIDIS.length - 2, Math.floor(x));
  const f = x - i, a = VIRIDIS[i], b = VIRIDIS[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

// Five carriers, matching the scene the docs describe: a wide FM, two narrow ones, an
// OOK burst and an SSB pair.
const CARRIERS = [
  { at: 0.17, w: 0.032, amp: 0.86 },
  { at: 0.38, w: 0.009, amp: 0.70 },
  { at: 0.50, w: 0.005, amp: 0.95 },
  { at: 0.63, w: 0.013, amp: 0.55 },
  { at: 0.81, w: 0.0045, amp: 0.74 },
];

function level(x, r, t) {
  let v = 0.12 + r() * 0.06;                       // noise floor
  for (const c of CARRIERS) {
    const d = (x - c.at) / c.w;
    // the OOK carrier keys on and off down the waterfall, which is what makes a
    // waterfall worth having over a trace
    const gate = c.w < 0.006 ? (Math.sin(t * 5.5) > -0.2 ? 1 : 0.06) : 1;
    v += c.amp * gate * Math.exp(-d * d * 3.2);
  }
  return Math.min(1, v);
}

function paint(device) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  const sp = device.querySelector('.sp');
  const wf = device.querySelector('.wf');
  if (!sp || !wf) return;

  // Spectrum: a live trace with a peak-hold above it.
  {
    const w = sp.clientWidth, h = sp.clientHeight;
    if (!w || !h) return;
    sp.width = Math.round(w * dpr); sp.height = Math.round(h * dpr);
    const g = sp.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const css = getComputedStyle(device);
    const trace = css.getPropertyValue('--trace').trim() || '#D2E8E3';

    for (const [alpha, jitter, seed] of [[0.28, 0.0, 7], [1, 0.03, 11]]) {
      const r = rng(seed);
      g.beginPath();
      for (let i = 0; i <= w; i++) {
        const v = level(i / w, r, 0) - (jitter ? r() * jitter : 0);
        const y = h - v * (h - 6) - 3;
        i ? g.lineTo(i, y) : g.moveTo(i, y);
      }
      g.globalAlpha = alpha;
      g.strokeStyle = trace; g.lineWidth = 1; g.stroke();
      g.globalAlpha = 1;
    }
  }

  // Waterfall: rows of history, newest at the top.
  {
    const w = wf.clientWidth, h = wf.clientHeight;
    if (!w || !h) return;
    const cw = Math.max(1, Math.round(w * dpr)), ch = Math.max(1, Math.round(h * dpr));
    wf.width = cw; wf.height = ch;
    const g = wf.getContext('2d');
    const img = g.createImageData(cw, ch);
    const r = rng(23);
    for (let y = 0; y < ch; y++) {
      const t = y / ch * 12;
      for (let x = 0; x < cw; x++) {
        const [R, G, B] = viridis(level(x / cw, r, t));
        const o = (y * cw + x) * 4;
        img.data[o] = R; img.data[o + 1] = G; img.data[o + 2] = B; img.data[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }

  // The stage takes the colormap's floor, as the real one does.
  const st = device.querySelector('.stage');
  if (st) st.style.setProperty('--wf-floor', 'rgb(68,1,84)');
}

/* ── measuring ─────────────────────────────────────────────────────────────── */

// offsetHeight is in layout pixels and ignores the scale transform on the frame, so
// every figure below is the real one at the chosen viewport.
function budget(device, [W, H]) {
  const app = device.querySelector('.app');
  let chrome = 0;
  for (const el of app.children) {
    if (el.classList.contains('panes')) continue;
    chrome += el.offsetHeight;
  }
  const stageEl = device.querySelector('.stage');
  const st = stageEl ? stageEl.offsetHeight : 0;
  const pct = (100 * chrome / H);

  // A layout that fits at 1440 and silently clips at 390 is not a layout that fits.
  // But two different things look identical to `scrollWidth`: a run that was built to
  // scroll and is doing its job, and a row that is simply losing content off its end.
  // The strip has scrolled horizontally since it was built; the path row does not, and
  // an overflow there is a bug. So they are counted apart, and only the second is red.
  const clips = [], scrolls = [];
  for (const [sel, name] of [['.path', 'path row'], ['.topbar', 'top row'],
                             ['.tabs', 'tab run'], ['.dock', 'dock'], ['.strip', 'strip'],
                             ['.floatpath', 'floating path']]) {
    for (const el of device.querySelectorAll(sel)) {
      const d = el.scrollWidth - el.clientWidth;
      if (d <= 1) continue;
      const ox = getComputedStyle(el).overflowX;
      (ox === 'auto' || ox === 'scroll' ? scrolls : clips).push(`${name} ${d}`);
    }
  }
  return { chrome, stage: st, pct, H, W, clips, scrolls };
}

function readout(b, base) {
  const saved = base ? base.chrome - b.chrome : 0;
  const grew = base ? b.stage - base.stage : 0;
  const cls = b.pct <= 10 ? 'good' : b.pct >= 20 ? 'bad' : '';
  return `
    <div class="budget">
      <span>chrome <b class="${cls}">${b.chrome} px</b> · ${b.pct.toFixed(0)}% of ${b.H}</span>
      <span>waterfall + spectrum <b>${b.stage} px</b></span>
      ${b.clips.length
        ? `<span class="bad">clips: ${b.clips.join(' · ')} px</span>`
        : '<span class="good">nothing clipped</span>'}
      ${b.scrolls.length ? `<span>scrolls: ${b.scrolls.join(' · ')} px</span>` : ''}
      ${base ? `<span>vs today <b class="${saved > 0 ? 'good' : ''}">${saved > 0 ? '−' : ''}${Math.abs(saved)} px chrome</b>,
        <b class="${grew > 0 ? 'good' : ''}">${grew > 0 ? '+' : ''}${grew} px signal</b>
        (${grew > 0 ? '+' : ''}${(100 * grew / (base.stage || 1)).toFixed(1)}%)</span>` : '<span>the baseline</span>'}
    </div>
    <div class="bar">
      <i class="b-chrome" style="width:${(100 * b.chrome / b.H).toFixed(2)}%"></i>
      <i class="b-stage" style="width:${(100 * b.stage / b.H).toFixed(2)}%"></i>
    </div>`;
}

/* ── driving it ────────────────────────────────────────────────────────────── */

// `?w=1024` and `?only=ends` deep-link a viewport and a single screen — handy for
// pointing at one scheme in a conversation, and for capturing them one at a time.
const q = new URLSearchParams(location.search);
const state = {
  size: PRESETS[q.get('w')] ? q.get('w') : '1440',
  only: q.get('only') || '',
};
const shown = () => (state.only ? SCREENS.filter((s) => s.key === state.only) : SCREENS);

function render() {
  const [W, H] = PRESETS[state.size];
  const host = document.getElementById('screens');
  host.innerHTML = shown().map((s) => `
    <section class="screen" id="s-${s.key}">
      <h2>${s.name}<span class="key">${s.key}</span></h2>
      <p class="why">${s.why}</p>
      <div class="frame"><div class="scaler"><div class="device" style="width:${W}px;height:${H}px">${s.html()}</div></div></div>
      <div class="out"></div>
    </section>`).join('');

  // Scale each frame down to the column, and give the row back the height the scale
  // took off it, so the page does not overlap itself.
  const col = host.clientWidth;
  const k = Math.min(1, col / W);
  let base = null;
  // The comparison is always against today, even when today is not on screen.
  const measured = new Map();
  for (const s of shown()) {
    const sec = document.getElementById(`s-${s.key}`);
    const scaler = sec.querySelector('.scaler');
    const device = sec.querySelector('.device');
    scaler.style.transform = `scale(${k})`;
    sec.querySelector('.frame').style.height = `${H * k}px`;
    paint(device);
    const b = budget(device, [W, H]);
    measured.set(s.key, b);
    if (s.key === 'today') base = b;
  }
  // With `?only=` set, today is off screen, so its baseline is measured in a hidden
  // frame rather than guessed at.
  if (!base) base = measureHidden(SCREENS[0], W, H);
  for (const s of shown()) {
    const sec = document.getElementById(`s-${s.key}`);
    sec.querySelector('.out').innerHTML = readout(measured.get(s.key), s.key === 'today' ? null : base);
  }
}

// Lay a screen out off to the side, measure it, throw it away. Nothing is painted:
// only the bar heights matter, and those are settled by layout alone.
function measureHidden(screen, W, H) {
  const box = document.createElement('div');
  box.style.cssText = `position:absolute;left:-99999px;top:0;width:${W}px;height:${H}px`;
  box.className = 'device';
  box.innerHTML = screen.html();
  document.body.appendChild(box);
  const b = budget(box, [W, H]);
  box.remove();
  return b;
}

function controls() {
  const el = document.getElementById('controls');
  el.innerHTML = `
    <span class="lab">viewport</span>
    <span class="seg" id="sizes">${Object.keys(PRESETS).map((k) =>
      `<button data-k="${k}" class="${k === state.size ? 'on' : ''}">${k}×${PRESETS[k][1]}</button>`).join('')}</span>
    <span class="spacer"></span>
    <span class="seg" id="onlys">${[{ key: '', name: 'all' }].concat(SCREENS).map((s) =>
      `<button data-o="${s.key}" class="${s.key === state.only ? 'on' : ''}">${s.name}</button>`).join('')}</span>
    <span class="seg" id="themes">
      <button data-t="dark" class="${document.documentElement.dataset.theme !== 'light' ? 'on' : ''}">dark</button>
      <button data-t="light" class="${document.documentElement.dataset.theme === 'light' ? 'on' : ''}">light</button>
    </span>`;

  el.querySelector('#sizes').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.size = b.dataset.k; controls(); render();
  });
  el.querySelector('#onlys').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.only = b.dataset.o; controls(); render();
  });
  el.querySelector('#themes').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    document.documentElement.dataset.theme = b.dataset.t;
    controls(); render();
  });
}

document.documentElement.dataset.theme = q.get('theme') === 'light' ? 'light' : 'dark';
controls();
if (document.fonts && document.fonts.ready) document.fonts.ready.then(render);
else render();
addEventListener('resize', () => render());
