/* Pointer travel, measured — because clicks alone are the wrong metric.
 *
 * docs/08-ui-principles.md says so itself: "counting only clicks would have scored the
 * old pinned-sidebar layout as equal to the contextual one. It was not equal — it
 * charged a ~600 px round trip for every single operation." A first pass at this study
 * led with a click table anyway, which made a popunder look like a regression because
 * two clicks thirty pixels apart counted the same as two clicks at opposite ends of
 * the window.
 *
 * So both layouts are built at the same size from the app's own markup, the surfaces a
 * task actually opens are rendered rather than imagined, and the path between them is
 * summed in real pixels. Budgets: < 120 px per operation after a selection drag,
 * < 900 px for a full UC-1 run.
 */

const T = (s, r = document) => r.querySelector(s);

/* ── the two layouts, same size, real markup ───────────────────────────────── */

const STAGE = `
  <div class="panes"><div class="pane">
    <div class="stage tstage">
      <canvas class="sp"></canvas><div class="splitter"></div><canvas class="wf"></canvas>
    </div>
    <div class="axis"><span>433.720</span><span>433.820</span><span>433.920 MHz</span><span>434.020</span><span>434.120</span></div>
  </div></div>`;

const TRANSPORT = `
  <div class="transport">
    <button class="tbtn">◀◀</button><button class="tbtn play">❚❚</button><button class="tbtn">▶▶</button>
    <span class="mono clock">12.331 s</span><button class="track"><i style="width:46%"></i></button>
  </div>`;

const STRIP = `
  <div class="strip">
    <div class="pgroup"><span class="ptitle">Tuner A</span>
      <button class="pill mn scrub" data-k="center"><i class="dot"></i><span class="pv">433.8950</span><span class="pu">MHz</span></button>
      <button class="pill au scrub" data-k="width"><i class="dot"></i><span class="pv">50.0</span><span class="pu">kHz</span></button>
      <button class="pill more">⋯</button></div>
    <div class="pgroup"><span class="ptitle">Waterfall</span>
      <button class="pill au" data-k="fft"><i class="dot"></i><span class="pv">2048</span><span class="pu">bins</span></button>
      <button class="pill pl" data-k="map"><span class="pv">Viridis</span></button>
      <button class="pill more">⋯</button></div>
  </div>`;

const LAYOUTS = {
  today: `
    <div class="app">
      <div class="topbar"><div class="crumbs">
        <button class="dev"><i class="live"></i>rtl-sdr #0<i class="devopen">⌄</i></button>
        <span class="sepc">›</span><button class="crumb cur" data-id="A">A · fan remote</button>
        <span class="sepc">›</span><button class="crumb dim" data-id="B">B · Tuner</button>
      </div><button class="themebtn">◐</button></div>
      <div class="tabs">
        <button class="tab" data-k="spectrum">Spectrum</button>
        <button class="tab" data-k="am">AM demod<span class="tk">audio</span></button>
        <button class="tab on" data-k="pwm">PWM<span class="tk">bytes</span></button>
        <button class="tab" data-k="flow">Flow</button>
        <button class="tab plus">+</button></div>
      ${STAGE}
      <div class="dock">${TRANSPORT}${STRIP}</div>
    </div>`,
  prop: `
    <div class="app">
      <div class="bar">
        <button class="dev crumb has"><i class="live"></i>rtl-sdr #0<i class="car">⌄</i></button>
        <span class="sepc">›</span>
        <button class="crumb has" data-map="chan">A · fan remote<i class="car">⌄</i></button>
        <span class="sepc">›</span>
        <button class="crumb has cur" data-map="view">PWM<i class="car">⌄</i></button>
        <button class="themebtn">◐</button></div>
      ${STAGE}
      <div class="dock row">${TRANSPORT}</div>
    </div>`,
};

/* ── the surfaces a task opens, rendered rather than imagined ──────────────── */

const OVERLAYS = {
  // today: tapping a strip pill opens a popover above it
  popover: (frame, anchor) => panel(frame, anchor, 'up', `
    <div class="pophead">colormap</div>
    <div class="popopts">${['Viridis', 'Inferno', 'Paper', 'Ice']
      .map((c, i) => `<button class="opt${i === 0 ? ' on' : ''}" data-t="${c}">${c}</button>`).join('')}</div>`),
  wpop: (frame, anchor) => panel(frame, anchor, 'up', `
    <div class="pophead">width <span class="autobtn on">⟲ auto</span></div>
    <div class="poptext" style="font-size:.66rem;color:var(--dim);line-height:1.5">
      occupied band + 18% guard. Manual would hold 50.0 kHz.</div>`),
  // proposed: the map opens under the crumb it belongs to
  map: (frame, anchor, atPoint) => panel(frame, anchor, 'down', `
    <div class="mhead">rtl-sdr #0</div>
    <button class="mrow cur" data-t="A"><i class="live"></i>A · fan remote<span class="key">a</span></button>
    <div class="mkids">
      <button class="mrow kid" data-t="spectrum">Spectrum</button>
      <button class="mrow kid" data-t="am">AM demod<span class="tk">audio</span></button>
      <button class="mrow kid cur" data-t="pwm">PWM<span class="tk">bytes</span></button>
      <button class="mrow kid" data-t="flow">Flow</button></div>
    <button class="mrow" data-t="B">B · Tuner<span class="key">b</span></button>
    <button class="mrow" data-t="C">C · doorbell<span class="key">c</span></button>`, 'map', atPoint),
  stats: (frame, anchor, atPoint) => panel(frame, anchor, 'down', `
    <div class="shead">Tuner A · fan remote</div>
    <div class="srow mn"><span class="sk">center</span><span class="sv">433.8950</span><span class="su">MHz</span></div>
    <div class="srow au" data-t="width"><span class="sk">width</span><span class="sv">50.0</span><span class="su">kHz</span>
      <span class="ev">occupied band + 18% guard</span></div>
    <div class="srow au"><span class="sk">taps</span><span class="sv">129</span>
      <span class="ev">worst alias −58 dB</span></div>`, 'stats', atPoint),
  // proposed: the menu arrives wherever the gesture ended
  menu: (frame, pt) => {
    const el = document.createElement('div');
    el.className = 'ctx ov';
    el.innerHTML = `
      <div class="chead">this view</div>
      <button class="crow" data-t="Colormap">Colormap<span class="cv">Viridis</span></button>
      <button class="crow" data-t="fft">FFT size<span class="cv">2048 bins</span></button>
      <button class="crow" data-t="db">dB range<span class="cv">⟲ auto</span></button>
      <div class="csep"></div>
      <div class="chead">colormap</div>
      <div style="display:flex;flex-wrap:wrap;gap:.3rem;padding:.1rem .45rem .3rem">
        ${['Viridis', 'Inferno', 'Paper', 'Ice'].map((c, i) =>
          `<button class="opt${i === 0 ? ' on' : ''}" data-t="opt-${c}">${c}</button>`).join('')}</div>`;
    frame.appendChild(el);
    el.style.left = `${pt[0]}px`; el.style.top = `${pt[1]}px`;
    return el;
  },
  opmenu: (frame, pt) => {
    const el = document.createElement('div');
    el.className = 'ctx ov';
    el.innerHTML = `
      <div class="chead">selection · 48.6 kHz</div>
      <button class="crow" data-t="narrow">Narrow to selection<span class="key">t</span></button>
      <button class="crow" data-t="am">AM demod<span class="key">a</span></button>
      <button class="crow" data-t="fm">FM demod<span class="key">f</span></button>`;
    frame.appendChild(el);
    el.style.left = `${pt[0]}px`; el.style.top = `${pt[1]}px`;
    return el;
  },
};

function panel(frame, anchor, dir, html, cls = 'pop', atPoint = false) {
  const el = document.createElement('div');
  el.className = `${cls} ov`;
  el.innerHTML = html;
  frame.appendChild(el);
  const f = frame.getBoundingClientRect();
  // `anchor` is a point when summoned by a key and an element when clicked. Arriving
  // at the cursor is the entire difference the key makes, so it is drawn that way.
  const [ax, ay, ab] = Array.isArray(anchor)
    ? [anchor[0], anchor[1], anchor[1]]
    : (() => { const a = anchor.getBoundingClientRect();
               return [a.left - f.left, a.top - f.top, a.bottom - f.top]; })();
  const x = Math.max(6, Math.min(ax, f.width - el.offsetWidth - 6));
  const y = dir === 'up' || atPoint && ab + el.offsetHeight > f.height
    ? Math.max(6, ay - el.offsetHeight - 6) : ab + 4;
  el.style.left = `${x}px`; el.style.top = `${Math.min(y, f.height - el.offsetHeight - 6)}px`;
  return el;
}

/* ── the tasks ─────────────────────────────────────────────────────────────── */

// `sel` is an element in that frame; `open` renders a surface first; `d` is an offset
// from the previous point, for a menu that arrives under the cursor.
// Where the cursor starts drives two of the five results, so it is a parameter rather
// than a constant: `?sy=0.2` puts it on the spectrum trace, `?sy=0.85` deep in the
// waterfall. Sweeping it is what showed which findings were real and which were an
// artifact of one number — see the sensitivity table on the page.
const START = ['stage', 0.5, +(new URLSearchParams(location.search).get('sy') || 0.62)];   // the cursor lives on the signal, low in the waterfall

const TASKS = [
  {
    name: 'Change the colormap',
    note: 'The one the click count called a tie. It is not a tie.',
    today: [{ start: 1 }, { sel: '.strip [data-k="map"]', click: 1 },
            { open: ['popover', '.strip [data-k="map"]'], sel: '[data-t="Inferno"]', click: 1 }],
    prop:  [{ start: 1 }, { click: 1, menu: ['menu', 0] },
            { sel: '[data-t="Colormap"]', click: 1 }, { sel: '[data-t="opt-Inferno"]', click: 1 }],
    key:   [{ start: 1 }, { key: '/', menu: ['menu', 0] },
            { sel: '[data-t="Colormap"]', click: 1 }, { sel: '[data-t="opt-Inferno"]', click: 1 }],
  },
  {
    name: 'Read why the width is 50 kHz',
    note: 'A hover either way. The strip is at the foot, the crumb is at the head.',
    today: [{ start: 1 }, { sel: '.strip [data-k="width"]', hover: 1 },
            { open: ['wpop', '.strip [data-k="width"]'] }],
    prop:  [{ start: 1 }, { sel: '[data-map="chan"]', hover: 1 },
            { open: ['stats', '[data-map="chan"]'] }],
    key:   [{ start: 1 }, { key: 'i', card: ['stats'] }],
  },
  {
    name: 'Switch to channel B',
    today: [{ start: 1 }, { sel: '[data-id="B"]', click: 1 }],
    prop:  [{ start: 1 }, { sel: '[data-map="chan"]', click: 1 },
            { open: ['map', '[data-map="chan"]'], sel: '[data-t="B"]', click: 1 }],
    key:   [{ start: 1 }, { key: 'b' }],
  },
  {
    name: 'Switch view to AM demod',
    note: 'Two clicks, and the second one is barely a move.',
    today: [{ start: 1 }, { sel: '.tab[data-k="am"]', click: 1 }],
    prop:  [{ start: 1 }, { sel: '[data-map="view"]', click: 1 },
            { open: ['map', '[data-map="view"]'], sel: '[data-t="am"]', click: 1 }],
    key:   [{ start: 1 }, { key: 'm', menu: ['map', 0] }, { sel: '[data-t="am"]', click: 1 }],
  },
  {
    name: 'Drag a box, then demodulate',
    note: 'Unchanged, and already the good case — the menu comes to the cursor.',
    today: [{ start: 1 }, { d: [120, -40], click: 1 },
            { menu: ['opmenu', 0], sel: '[data-t="am"]', click: 1 }],
    prop:  [{ start: 1 }, { d: [120, -40], click: 1 },
            { menu: ['opmenu', 0], sel: '[data-t="am"]', click: 1 }],
    key:   [{ start: 1 }, { d: [120, -40], click: 1 }, { key: 'a' }],
  },
];

/* ── measuring ─────────────────────────────────────────────────────────────── */

function run(frame, steps) {
  for (const el of frame.querySelectorAll('.ov')) el.remove();
  const svg = frame.querySelector('svg.path');
  const pts = [];
  let clicks = 0, hovers = 0, cur = null;
  const keys = [];

  const center = (el) => {
    const f = frame.getBoundingClientRect(), r = el.getBoundingClientRect();
    return [r.left - f.left + r.width / 2, r.top - f.top + r.height / 2];
  };

  for (const s of steps) {
    if (s.start) {
      const st = frame.querySelector('.stage').getBoundingClientRect();
      const f = frame.getBoundingClientRect();
      cur = [st.left - f.left + st.width * START[1], st.top - f.top + st.height * START[2]];
      pts.push({ p: cur, kind: 'start' });
      continue;
    }
    if (s.d) { cur = [cur[0] + s.d[0], cur[1] + s.d[1]]; }
    if (s.menu) { const [kind] = s.menu; OVERLAYS[kind](frame, cur, true); }
    if (s.card) { const [kind] = s.card; OVERLAYS[kind](frame, cur, true); }
    if (s.open) { const [kind, anchor] = s.open; OVERLAYS[kind](frame, frame.querySelector(anchor)); }
    if (s.sel) { const el = frame.querySelector(s.sel); if (el) cur = center(el); }
    if (s.click) clicks++;
    if (s.hover) hovers++;
    if (s.key) keys.push(s.key);
    pts.push({ p: cur, kind: s.click ? 'click' : s.hover ? 'hover' : 'stop' });
  }

  let travel = 0;
  for (let i = 1; i < pts.length; i++)
    travel += Math.hypot(pts[i].p[0] - pts[i - 1].p[0], pts[i].p[1] - pts[i - 1].p[1]);

  svg.innerHTML = `
    <polyline points="${pts.map((q) => q.p.join(',')).join(' ')}"
      fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="5 4" opacity=".95"/>
    ${pts.map((q, i) => `
      <circle cx="${q.p[0]}" cy="${q.p[1]}" r="${i === 0 ? 5 : 8}"
        fill="${i === 0 ? 'var(--accent)' : 'var(--ground)'}" stroke="var(--accent)" stroke-width="2"/>
      ${i ? `<text x="${q.p[0]}" y="${q.p[1] + 3.5}" text-anchor="middle"
        font-family="var(--mono)" font-size="9" fill="var(--accent)">${i}</text>` : ''}`).join('')}`;

  return { travel: Math.round(travel), clicks, hovers, keys };
}

/* ── driving it ────────────────────────────────────────────────────────────── */

let taskIx = 0, variant = 'prop';
const BUDGET = 120;   // docs/08: pointer travel per operation, after a selection drag

const fmt = (r) => `
  <b class="${r.travel <= BUDGET ? 'good' : ''}">${r.travel} px</b> of travel · ${
    r.keys.length ? `${r.keys.map((k) => `<kbd>${k}</kbd>`).join(' ')}${
      r.clicks ? ` · ${r.clicks} click${r.clicks === 1 ? '' : 's'}` : ''}`
    : `${r.clicks} click${r.clicks === 1 ? '' : 's'}`}${r.hovers ? ' · 1 hover' : ''}`;

function draw() {
  const t = TASKS[taskIx];
  if (variant === 'key' && !t.key) variant = 'prop';
  const a = run(T('#f-today'), t.today);
  const b = run(T('#f-prop'), t[variant] || t.prop);
  // The other variant is measured off-screen so all three numbers can be compared at
  // once without three 430 px frames on the page.
  const alt = t.key ? run(T('#f-alt'), variant === 'key' ? t.prop : t.key) : null;

  T('#t-today-out').innerHTML = fmt(a);
  T('#t-prop-out').innerHTML = fmt(b);

  const mouse = variant === 'key' ? alt : b;
  const key = variant === 'key' ? b : alt;
  const say = (r) => {
    const d = r.travel - a.travel;
    return d === 0 ? '<b>the same</b>'
      : d < 0 ? `<b class="good">${-d} px less</b>`
              : `<b class="${d > 40 ? 'bad' : 'warn'}">${d} px more</b>`;
  };

  T('#t-verdict').innerHTML = `
    <b>${t.name}</b> · today <b>${a.travel} px</b> —
    with the mouse ${say(mouse)}${mouse.clicks > a.clicks
      ? ` and ${mouse.clicks - a.clicks} more click${mouse.clicks - a.clicks === 1 ? '' : 's'}` : ''}${
    key ? `; with the key ${say(key)}` : ''}.
    ${t.note ? `<span style="color:var(--dim)"> ${t.note}</span>` : ''}`;

  T('#t-tabs').innerHTML = TASKS.map((x, i) =>
    `<button data-i="${i}" class="${i === taskIx ? 'on' : ''}">${x.name}</button>`).join('');
  for (const btn of T('#t-tabs').querySelectorAll('button'))
    btn.addEventListener('click', () => { taskIx = +btn.dataset.i; draw(); });

  T('#t-variant').innerHTML = [['prop', 'with the mouse'], ['key', 'with a key']]
    .map(([v, label]) => `<button data-v="${v}" class="${v === variant ? 'on' : ''}"
      ${v === 'key' && !t.key ? 'disabled' : ''}>${label}</button>`).join('');
  for (const btn of T('#t-variant').querySelectorAll('button'))
    btn.addEventListener('click', () => { variant = btn.dataset.v; draw(); });
}

export function mountTravel() {
  T('#f-today').innerHTML = LAYOUTS.today + '<svg class="path"></svg>';
  T('#f-prop').innerHTML = LAYOUTS.prop + '<svg class="path"></svg>';
  T('#f-alt').innerHTML = LAYOUTS.prop + '<svg class="path"></svg>';
  // The frames hold no live canvas — a painted waterfall would only make the path
  // harder to see, and geometry is all this section is measuring.
  requestAnimationFrame(() => requestAnimationFrame(draw));
  addEventListener('resize', () => draw());
}
