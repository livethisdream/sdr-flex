// The parameter bar: a floating row of pills over the bottom of the canvas.
//
// Cells that had to be scrub-dragged were hard to change and, on a touch screen,
// fought the bar's own horizontal scroll. Tapping a pill now opens a popover with a
// control shaped to the parameter — a list for an enum, a slider for a number, and
// an Auto switch wherever something can derive the value (ADR-0017). Dragging a
// number pill still scrubs, so the fast path survives for a mouse.

export class Strip {
  constructor(el, tip) {
    this.el = el;
    this.tip = tip;
    this.onScrub = null;   // (groupKey, key, value)
    this.onMode = null;    // (groupKey, key, 'auto' | 'manual')
    this.pop = document.createElement('div');
    this.pop.className = 'pop';
    this.pop.hidden = true;
    document.body.appendChild(this.pop);

    addEventListener('pointerdown', (e) => {
      if (this.pop.hidden) return;
      if (!this.pop.contains(e.target) && !e.target.closest('.pill')) this.closePop();
    });
    addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closePop(); });
  }

  closePop() {
    this.pop.hidden = true;
    if (this._openPill) this._openPill.classList.remove('open');
    this._openPill = null;
  }

  render(groups) {
    this.groups = groups;
    const wasOpen = this._openKey;
    // A bar that shows everything is the old strip with round corners. Each group
    // keeps its most-used controls inline and folds the rest behind one pill.
    const INLINE = 3;
    this.el.innerHTML = groups.map((g) => {
      // read-only values stay on the bar — they are what the top row stopped
      // repeating — they simply do not open anything
      const shown = g.cells;
      if (!shown.length) return '';
      const inline = shown.slice(0, INLINE);
      const rest = shown.slice(INLINE).filter((c) => c.type !== 'ro');
      return `<div class="pgroup" data-g="${g.key}">
        <span class="ptitle">${g.title}</span>
        ${inline.map((c) => this._pill(g.key, c)).join('')}
        ${rest.length ? `<button class="pill more" data-g="${g.key}">⋯<span class="pu">${rest.length}</span></button>` : ''}
      </div>`;
    }).join('');
    this._wire();
    if (wasOpen && !this.pop.hidden) this._reopen(wasOpen);
  }

  _mode(c) {
    if (c.type === 'ro') return 'ro';
    return c.canAuto ? (c.mode || 'manual') : 'plain';
  }

  _pill(gk, c) {
    const mode = this._mode(c);
    const cls = mode === 'auto' ? 'au' : mode === 'ro' ? 'ro' : mode === 'plain' ? 'pl' : 'mn';
    const val = c.fmt ? c.fmt(c.value) : c.value;
    return `<button class="pill ${cls}${c.type === 'num' ? ' scrub' : ''}" data-g="${gk}" data-k="${c.key}"
              ${c.type === 'ro' ? 'disabled' : ''}>
      <span class="pk">${c.label}</span><span class="pv">${val}</span>${c.unit ? `<span class="pu">${c.unit}</span>` : ''}
    </button>`;
  }

  _find(gk, key) {
    const g = this.groups.find((x) => x.key === gk);
    return g && g.cells.find((c) => c.key === key);
  }

  _wire() {
    for (const more of this.el.querySelectorAll('.pill.more')) {
      more.addEventListener('click', () => this.openMore(more.dataset.g, more));
    }
    for (const pill of this.el.querySelectorAll('.pill:not(.more)')) {
      const gk = pill.dataset.g, key = pill.dataset.k;
      const spec = this._find(gk, key);
      if (!spec || spec.type === 'ro') continue;

      pill.addEventListener('pointerdown', (e) => {
        const start = { x: e.clientX, t: performance.now(), v: spec.value };
        let moved = false;
        try { pill.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }

        const move = (ev) => {
          const dx = ev.clientX - start.x;
          if (Math.abs(dx) < 4) return;
          moved = true;
          if (spec.type !== 'num') return;
          let v = start.v + dx * (spec.step || 1);
          if (spec.min != null) v = Math.max(spec.min, v);
          if (spec.max != null) v = Math.min(spec.max, v);
          if (spec.integer) v = Math.round(v);
          this.onScrub && this.onScrub(gk, key, v);
        };
        const up = () => {
          pill.removeEventListener('pointermove', move);
          pill.removeEventListener('pointerup', up);
          // a tap opens the control; a drag was the control
          if (!moved && performance.now() - start.t < 600) this.openPop(gk, key, pill);
        };
        pill.addEventListener('pointermove', move);
        pill.addEventListener('pointerup', up);
      });
    }
  }

  /** The folded controls of one group, each opening its own popover. */
  openMore(gk, anchor) {
    const g = this.groups.find((x) => x.key === gk);
    if (!g) return;
    const rest = g.cells.slice(3).filter((c) => c.type !== 'ro');
    this._openKey = null;
    if (this._openPill) this._openPill.classList.remove('open');
    this._openPill = anchor;
    anchor.classList.add('open');

    this.pop.innerHTML = `<div class="pophead"><span>${g.title}</span></div>` +
      `<div class="morelist">${rest.map((c) => {
        const mode = this._mode(c);
        const dot = mode === 'auto' ? 'au' : mode === 'manual' ? 'mn' : 'pl';
        return `<button class="moreitem ${dot}" data-k="${c.key}">
          <span class="mk">${c.label}</span>
          <span class="mv">${c.fmt ? c.fmt(c.value) : c.value}${c.unit ? ' ' + c.unit : ''}</span>
        </button>`;
      }).join('')}</div>`;
    this.pop.hidden = false;

    for (const b of this.pop.querySelectorAll('.moreitem')) {
      b.addEventListener('click', () => this.openPop(gk, b.dataset.k, anchor));
    }
    const r = anchor.getBoundingClientRect();
    const pr = this.pop.getBoundingClientRect();
    this.pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pr.width - 8)) + 'px';
    this.pop.style.top = Math.max(8, r.top - pr.height - 8) + 'px';
  }

  _reopen(k) {
    const pill = this.el.querySelector(`.pill[data-g="${k.g}"][data-k="${k.k}"]`);
    if (pill) this.openPop(k.g, k.k, pill, true);
    else this.closePop();
  }

  openPop(gk, key, pill, keepPosition) {
    const spec = this._find(gk, key);
    if (!spec) return;
    this._openKey = { g: gk, k: key };
    if (this._openPill) this._openPill.classList.remove('open');
    this._openPill = pill;
    pill.classList.add('open');

    const mode = this._mode(spec);
    const auto = spec.canAuto
      ? `<button class="autobtn${mode === 'auto' ? ' on' : ''}" data-act="auto">⟲ auto</button>` : '';

    let body = '';
    if (spec.type === 'enum') {
      body = `<div class="popopts">${spec.values.map((v) =>
        `<button class="opt${String(v) === String(spec.value) ? ' on' : ''}" data-v="${v}">${v}</button>`).join('')}</div>`;
    } else if (spec.type === 'num') {
      const lo = spec.min != null ? spec.min : spec.value / 4;
      const hi = spec.max != null ? spec.max : spec.value * 4;
      body = `
        <div class="popnum">
          <button class="nudge" data-d="-1">−</button>
          <input type="range" min="${lo}" max="${hi}" step="${spec.integer ? 1 : (hi - lo) / 400}" value="${spec.value}">
          <button class="nudge" data-d="1">+</button>
        </div>
        <div class="popval">${spec.fmt ? spec.fmt(spec.value) : spec.value}${spec.unit ? ' ' + spec.unit : ''}</div>`;
    }

    this.pop.innerHTML =
      `<div class="pophead"><span>${spec.label}</span>${auto}</div>${body}` +
      (mode === 'auto' && spec.autoNote ? `<div class="popnote">from ${spec.autoNote}</div>` : '');
    this.pop.hidden = false;

    const commit = (v) => {
      this.onScrub && this.onScrub(gk, key, v);
      const s = this._find(gk, key) || spec;
      const out = this.pop.querySelector('.popval');
      if (out) out.textContent = (s.fmt ? s.fmt(v) : v) + (s.unit ? ' ' + s.unit : '');
    };

    for (const b of this.pop.querySelectorAll('.opt')) {
      b.addEventListener('click', () => { commit(b.dataset.v); this.closePop(); });
    }
    const range = this.pop.querySelector('input[type=range]');
    if (range) {
      range.addEventListener('input', () => {
        let v = parseFloat(range.value);
        if (spec.integer) v = Math.round(v);
        commit(v);
      });
    }
    for (const b of this.pop.querySelectorAll('.nudge')) {
      b.addEventListener('click', () => {
        const s = this._find(gk, key) || spec;
        const d = parseInt(b.dataset.d, 10);
        const stepAmt = s.integer ? 1 : ((s.max ?? s.value * 4) - (s.min ?? 0)) / 100;
        let v = s.value + d * stepAmt;
        if (s.min != null) v = Math.max(s.min, v);
        if (s.max != null) v = Math.min(s.max, v);
        commit(s.integer ? Math.round(v) : v);
        if (range) range.value = v;
      });
    }
    const ab = this.pop.querySelector('[data-act=auto]');
    if (ab) {
      ab.addEventListener('click', () => {
        this.onMode && this.onMode(gk, key, ab.classList.contains('on') ? 'manual' : 'auto');
      });
    }

    if (!keepPosition) {
      const r = pill.getBoundingClientRect();
      const pr = this.pop.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.left, innerWidth - pr.width - 8));
      this.pop.style.left = left + 'px';
      this.pop.style.top = Math.max(8, r.top - pr.height - 8) + 'px';
    }
  }
}
