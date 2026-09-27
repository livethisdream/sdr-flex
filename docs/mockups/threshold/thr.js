/* A threshold is a line on the waveform.
 *
 * The last unbuilt piece of the study. Everything else moved somewhere: the tuner's
 * numbers to a summoned card, the view's choices to the menu, typed fields and a
 * plugin's knobs to the card as well. What was left was the ~20 numeric node
 * parameters, and the claim that they belong "on the object" — described four times
 * and never built, which is the only reason the strip was still alive.
 *
 * So: the real slicer, not a mock of one. `web/src/dsp.js` has no imports, so this page
 * runs the production `otsuThreshold`, `estimateSymbolPeriod` and `pwmSlice`. Dragging
 * the line re-slices with the same code the app ships, and the bits below are the bits
 * the app would produce.
 *
 * The census asked the sharp question: Bits, Bytes and Events have nothing to draw a
 * threshold on, and those are exactly the views whose nodes carry these knobs. The
 * answer this page proposes is that the parameter goes on the plot of its **input**,
 * never its output — a slice threshold over bytes is meaningless, and over the envelope
 * that produced them it is the only place it has ever made sense.
 */

import { otsuThreshold, estimateSymbolPeriod, pwmSlice } from '../../../web/src/dsp.js';

const $ = (s, r = document) => r.querySelector(s);

const RATE = 100e3;            // a 50 kHz tuner decimated, as the docs' worked example has it
const TRUE_SYMBOL_US = 417;    // what the generator actually used, for scoring the estimate

// One symbol is 42 samples in 6804 — six pixels at this width. A handle there is not a
// target, and a tick every six pixels is a picket fence rather than a ruler. So the
// handle measures a SPAN of symbols and divides: a bigger target, and a more precise
// reading, for the same reason you time twenty swings of a pendulum rather than one.
const SPAN = 16;

/* ── a signal worth thresholding ───────────────────────────────────────────── */

// A cheap remote: a preamble, then PWM where a long mark is a one. Given a slow
// amplitude drift and a noise floor, because a threshold that only has to separate 0.0
// from 1.0 proves nothing — the interesting case is the one where a wrong line costs
// you bits, and this is what makes dragging it mean something.
function makeEnvelope() {
  const sps = Math.round((TRUE_SYMBOL_US * 1e-6) * RATE);
  const words = [
    [1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 1, 0, 0, 1, 0, 1],
    [1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 1, 0, 0, 1, 0, 1],
    [1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 1, 0, 0, 1, 1, 0],
  ];
  const out = [];
  const push = (n, v) => { for (let i = 0; i < n; i++) out.push(v); };

  let rng = 12345;
  const rand = () => ((rng = (rng * 1664525 + 1013904223) >>> 0) / 4294967296);

  // No preamble mark. The first version had one, and `pwmSlice` counted it as a
  // seventeenth bit — which is correct behavior from the slicer and simply made the
  // fixture disagree with what it claimed to be. The inter-burst gap separates the
  // words on its own.
  push(Math.round(sps * 6), 0);
  for (const word of words) {
    for (const bit of word) {
      push(bit ? Math.round(sps * 2) : sps, 1);
      push(sps, 0);
    }
    push(Math.round(sps * 9), 0);
  }
  push(Math.round(sps * 6), 0);

  const env = new Float32Array(out.length);
  for (let i = 0; i < out.length; i++) {
    // The transmitter walks away from you across the capture — but only far enough to
    // make the threshold matter, not far enough to put the weakest mark underneath it.
    // The first version swung 0.44–1.0, which dropped the quiet end of the capture below
    // the Otsu value and shattered those marks into fragments: an honest failure mode,
    // and the wrong opening state for something whose job is to show the auto value
    // being right before you break it.
    const drift = 0.82 + 0.18 * Math.cos((i / out.length) * Math.PI * 1.1);
    const noise = (rand() + rand() + rand() - 1.5) * 0.055;
    env[i] = Math.max(0, (out[i] ? 0.62 * drift : 0.085) + noise);
  }
  // a one-pole edge, so a pulse has sides rather than being a rectangle
  for (let i = 1; i < env.length; i++) env[i] = env[i - 1] * 0.55 + env[i] * 0.45;
  return env;
}

const ENV = makeEnvelope();
const AUTO = otsuThreshold(ENV);

/* ── state ─────────────────────────────────────────────────────────────────── */

const st = {
  threshold: AUTO.value, thrAuto: true,
  symbolUs: 0, symAuto: true,
  hoverThr: false, hoverSym: false,
  drags: 0, travel: 0, last: null,
};
{
  const est = estimateSymbolPeriod(ENV, st.threshold, RATE);
  st.symbolUs = est.value || TRUE_SYMBOL_US;
  st.symEvidence = est;
}

const reAuto = () => {
  if (st.thrAuto) st.threshold = AUTO.value;
  if (st.symAuto) {
    const est = estimateSymbolPeriod(ENV, st.threshold, RATE);
    if (est.value) st.symbolUs = est.value;
    st.symEvidence = est;
  }
};

/* ── drawing the waveform ──────────────────────────────────────────────────── */

function css(v, f) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim() || f; }

function drawWave() {
  const cv = $('#wave'), box = cv.parentElement.getBoundingClientRect();
  const dpr = Math.min(2, devicePixelRatio || 1);
  cv.width = Math.round(box.width * dpr); cv.height = Math.round(box.height * dpr);
  const g = cv.getContext('2d'), w = cv.width, h = cv.height;
  const pad = 10 * dpr, base = h - 26 * dpr;         // the ruler owns the bottom strip

  g.clearRect(0, 0, w, h);

  // min/max per column, so a pulse narrower than a pixel still draws
  const hi = Math.max(AUTO.hi, st.threshold * 1.25, 0.001);
  const y = (v) => base - (v / hi) * (base - pad);
  g.beginPath();
  for (let px = 0; px < w; px++) {
    const a = Math.floor((px / w) * ENV.length), b = Math.floor(((px + 1) / w) * ENV.length);
    let lo = Infinity, up = -Infinity;
    for (let i = a; i < Math.max(a + 1, b); i++) { if (ENV[i] < lo) lo = ENV[i]; if (ENV[i] > up) up = ENV[i]; }
    g.moveTo(px + 0.5, y(lo)); g.lineTo(px + 0.5, y(up));
  }
  g.strokeStyle = css('--trace', '#D2E8E3'); g.lineWidth = dpr; g.globalAlpha = 0.9; g.stroke();
  g.globalAlpha = 1;

  // Everything above the line is a mark. Shading it is what makes the line read as a
  // decision rather than as an annotation — you see what you are choosing, not a value.
  const ty = y(st.threshold);
  g.fillStyle = st.thrAuto ? css('--ok', '#4ADE9B') : css('--accent', '#FF7A5C');
  g.globalAlpha = 0.07;
  g.fillRect(0, pad, w, Math.max(0, ty - pad));
  g.globalAlpha = 1;

  return { ty: ty / dpr, base: base / dpr, pad: pad / dpr, hi, dpr };
}

// The symbol period is a spacing, so it is shown as one: ticks along the foot of the
// waveform at the current period, which line up with the pulse edges when it is right
// and walk off them when it is not. That walk is the feedback a number in a strip cell
// could never give.
function drawRuler(geom) {
  const cv = $('#ruler'), box = cv.parentElement.getBoundingClientRect();
  const dpr = geom.dpr;
  cv.width = Math.round(box.width * dpr); cv.height = Math.round(26 * dpr);
  const g = cv.getContext('2d'), w = cv.width, h = cv.height;
  g.clearRect(0, 0, w, h);

  const sps = (st.symbolUs * 1e-6) * RATE;
  const step = (sps / ENV.length) * w;
  if (!(step > 0.5)) return;
  const end = step * SPAN;

  g.strokeStyle = st.symAuto ? css('--ok', '#4ADE9B') : css('--accent', '#FF7A5C');
  g.lineWidth = dpr;

  // Inside the measured span the ticks are the ruler and read at full strength; past it
  // they continue faintly, because watching them drift off the pulse edges further down
  // the record is the feedback a number in a strip cell could never give.
  for (const [from, to, alpha, tall] of [[0, end, 0.9, 0.62], [end, w, 0.22, 0.4]]) {
    g.globalAlpha = alpha;
    g.beginPath();
    for (let x = from; x < to; x += step) {
      g.moveTo(Math.round(x) + 0.5, 0);
      g.lineTo(Math.round(x) + 0.5, h * tall);
    }
    g.stroke();
  }
  g.globalAlpha = 0.9;
  g.beginPath(); g.moveTo(0, h * 0.7); g.lineTo(end, h * 0.7); g.stroke();
  g.globalAlpha = 1;
}

/* ── the result, from the production slicer ────────────────────────────────── */

function slice() {
  return pwmSlice(ENV, st.threshold, RATE, st.symbolUs);
}

function renderBits(groups) {
  const el = $('#bits');
  const total = groups.reduce((n, gr) => n + gr.bits.length, 0);
  const lens = groups.map((gr) => gr.bits.length);
  const agree = lens.length > 1 && lens.every((n) => n === lens[0]);

  el.innerHTML = `
    <div class="bhead">
      <span>PWM · bits</span>
      <span>${groups.length} burst${groups.length === 1 ? '' : 's'} · ${total} bits</span>
      ${lens.length > 1 ? `<span style="color:var(--${agree ? 'ok' : 'warn'})">${
        agree ? 'all bursts the same length' : 'bursts disagree: ' + lens.join(' / ')}</span>` : ''}
    </div>
    ${groups.length ? groups.map((gr) => `
      <div class="burst">
        <span class="at">${(gr.start / RATE).toFixed(3)}s</span>
        <span class="bits">${gr.bits.join('')}</span>
        <span class="n">${gr.bits.length}b</span>
      </div>`).join('')
      : '<div class="none">Nothing decodes at this threshold.</div>'}`;
  return { groups, total, agree };
}

/* ── evidence ──────────────────────────────────────────────────────────────── */

function drawHist(cv, hist, markAt) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  cv.width = Math.round(cv.clientWidth * dpr); cv.height = Math.round(52 * dpr);
  const g = cv.getContext('2d'), w = cv.width, h = cv.height;
  g.clearRect(0, 0, w, h);
  const max = Math.max(...hist) || 1;
  const bw = w / hist.length;
  g.fillStyle = css('--dim', '#6E798C');
  for (let i = 0; i < hist.length; i++) {
    const bh = (hist[i] / max) * (h - 4);
    g.fillRect(i * bw, h - bh, Math.max(1, bw - dpr), bh);
  }
  if (markAt != null) {
    g.strokeStyle = st.thrAuto ? css('--ok', '#4ADE9B') : css('--accent', '#FF7A5C');
    g.lineWidth = 2 * dpr;
    g.beginPath(); g.moveTo(markAt * w, 0); g.lineTo(markAt * w, h); g.stroke();
  }
}

function showEvidence(which, topPx) {
  const el = $('#eviz');
  el.hidden = false;
  el.style.top = `${Math.max(6, Math.min(topPx, $('#wavewrap').clientHeight - 120))}px`;
  if (which === 'thr') {
    const frac = (st.threshold - AUTO.lo) / Math.max(1e-9, AUTO.hi - AUTO.lo);
    el.innerHTML = `<div class="eh">level distribution</div><canvas></canvas>
      <div class="ex">Otsu over the envelope. Auto would sit at
        ${AUTO.value.toFixed(3)}${st.thrAuto ? '' : `; you have it at ${st.threshold.toFixed(3)}`}.</div>`;
    drawHist(el.querySelector('canvas'), AUTO.hist, Math.max(0, Math.min(1, frac)));
  } else {
    const ev = st.symEvidence || {};
    el.innerHTML = `<div class="eh">pulse lengths</div><canvas></canvas>
      <div class="ex">Two clusters — a short mark is a zero, a long one a one.
        ${ev.confident ? 'Clean split' : 'Blurred: the estimate is weak'}${
        ev.value ? `, auto reads ${Math.round(ev.value)} µs` : ''}.</div>`;
    drawHist(el.querySelector('canvas'), ev.hist || new Float32Array(8), null);
  }
}

/* ── the one number this page is really about ──────────────────────────────── */

function tally(res) {
  // Correctness, not preference: the generator knows what it sent, so a threshold can
  // be scored rather than admired. Three bursts, sixteen bits each.
  const want = 3, wantBits = 16;
  const ok = res.groups.length === want && res.groups.every((gr) => gr.bits.length === wantBits);
  $('#nums').innerHTML = `
    <span>decode <b class="${ok ? 'good' : 'bad'}">${ok ? 'correct' : 'wrong'}</b>
      — ${res.groups.length}/${want} bursts</span>
    <span>threshold <b class="${st.thrAuto ? 'good' : ''}">${st.threshold.toFixed(3)}</b>
      ${st.thrAuto ? '⟲ auto' : '🔒 manual'}</span>
    <span>symbol <b class="${st.symAuto ? 'good' : ''}">${Math.round(st.symbolUs)} µs</b>
      ${st.symAuto ? '⟲ auto' : '🔒 manual'}</span>
    <span>pointer travel <b class="good">${Math.round(st.travel)} px</b> over ${st.drags} drag${st.drags === 1 ? '' : 's'}</span>`;
}

/* ── draw everything ───────────────────────────────────────────────────────── */

function paint() {
  const geom = drawWave();
  drawRuler(geom);

  const thr = $('#thr');
  thr.style.top = `${geom.ty}px`;
  thr.classList.toggle('manual', !st.thrAuto);
  thr.querySelector('.tag').innerHTML =
    `${st.threshold.toFixed(3)}${st.thrAuto ? ' ⟲' : '<i class="re" title="back to auto">⟲ auto</i>'}`;

  const sps = (st.symbolUs * 1e-6) * RATE;
  const wide = $('#wavewrap').clientWidth;
  const x = (sps * SPAN / ENV.length) * wide;
  const h = $('#rhandle'), tag = $('#rtag');
  h.style.left = `${x}px`; h.classList.toggle('manual', !st.symAuto);
  // Clamped, because at the short end the tag was half off the left edge and "421 µs"
  // rendered as "1 µs" — a label that lies is worse than one that moves.
  tag.style.left = `${Math.max(34, Math.min(x, wide - 34))}px`;
  tag.classList.toggle('manual', !st.symAuto);
  tag.textContent = `${Math.round(st.symbolUs)} µs`;

  tally(renderBits(slice()));
  if (!$('#eviz').hidden) showEvidence(st.hoverSym ? 'sym' : 'thr', geom.ty - 60);
}

/* ── the gestures ──────────────────────────────────────────────────────────── */

function charge(e) {
  if (st.last) st.travel += Math.hypot(e.clientX - st.last.x, e.clientY - st.last.y);
  st.last = { x: e.clientX, y: e.clientY };
}

function wire() {
  const wrap = $('#wavewrap'), thr = $('#thr');

  thr.addEventListener('pointerdown', (e) => {
    if (e.target.classList.contains('re')) {
      st.thrAuto = true; st.symAuto = true; reAuto(); paint(); return;
    }
    thr.setPointerCapture(e.pointerId);
    st.drags++; st.last = { x: e.clientX, y: e.clientY };
    thr._drag = true;
  });
  thr.addEventListener('pointermove', (e) => {
    if (!thr._drag) return;
    charge(e);
    const box = wrap.getBoundingClientRect();
    const pad = 10, base = box.height - 26;
    const hi = Math.max(AUTO.hi, 0.001);
    const v = ((base - (e.clientY - box.top)) / (base - pad)) * hi;
    st.threshold = Math.max(0, Math.min(hi, v));
    // Placing it by hand pins it, exactly as dragging the color bar pins the dB range.
    st.thrAuto = false;
    if (st.symAuto) { const est = estimateSymbolPeriod(ENV, st.threshold, RATE);
                      if (est.value) st.symbolUs = est.value; st.symEvidence = est; }
    paint();
  });
  const end = (e) => { if (thr._drag) { thr._drag = false; try { thr.releasePointerCapture(e.pointerId); } catch {} } };
  thr.addEventListener('pointerup', end);
  thr.addEventListener('pointercancel', end);

  thr.addEventListener('pointerenter', () => { st.hoverThr = true; showEvidence('thr', thr.offsetTop - 60); });
  thr.addEventListener('pointerleave', () => { st.hoverThr = false; if (!thr._drag) $('#eviz').hidden = true; });

  const rh = $('#rhandle');
  rh.addEventListener('pointerdown', (e) => {
    rh.setPointerCapture(e.pointerId); rh._drag = true;
    st.drags++; st.last = { x: e.clientX, y: e.clientY };
  });
  rh.addEventListener('pointermove', (e) => {
    if (!rh._drag) return;
    charge(e);
    const box = wrap.getBoundingClientRect();
    const px = Math.max(4, e.clientX - box.left);
    const samples = (px / box.width) * ENV.length / SPAN;
    st.symbolUs = Math.max(40, (samples / RATE) * 1e6);
    st.symAuto = false;
    paint();
  });
  const rend = (e) => { if (rh._drag) { rh._drag = false; try { rh.releasePointerCapture(e.pointerId); } catch {} } };
  rh.addEventListener('pointerup', rend);
  rh.addEventListener('pointercancel', rend);
  rh.addEventListener('pointerenter', () => { st.hoverSym = true; showEvidence('sym', 20); });
  rh.addEventListener('pointerleave', () => { st.hoverSym = false; if (!rh._drag) $('#eviz').hidden = true; });

  $('#reset').addEventListener('click', () => {
    st.thrAuto = true; st.symAuto = true; st.drags = 0; st.travel = 0; st.last = null;
    reAuto(); paint();
  });
}

{
  const t = new URLSearchParams(location.search).get('theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
}
wire();
requestAnimationFrame(paint);
addEventListener('resize', paint);

// so a headless driver can assert on the real slicer rather than on pixels
window.__thr = { st, paint, slice, ENV, AUTO, RATE, TRUE_SYMBOL_US };
