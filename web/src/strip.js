// The inspector strip: cells, not a text run (ADR-0019). Label above, value in
// tabular mono, unit beneath, and a 2 px left edge carrying the auto/manual mode
// instead of a text chip — state earns a cheaper visual encoding than a word
// (law 11). Hovering the edge explains the mode and what the other one would pick.

export class Strip {
  constructor(el, tip) {
    this.el = el;
    this.tip = tip;
    this.onScrub = null;     // (groupKey, key, value)
    this.onMode = null;      // (groupKey, key, mode)
  }

  /** groups: [{ key, title, cells: [...] }] */
  render(groups) {
    this.groups = groups;
    this.el.innerHTML = groups.map((g) => `
      <div class="sgroup" data-g="${g.key}">
        <div class="sg-h">${g.title}</div>
        <div class="cells">${g.cells.map((c) => this._cell(g.key, c)).join('')}</div>
      </div>`).join('') + '<div class="sgroup grow"><span class="chev" title="expand">⌄</span></div>';
    this._wire();
  }

  _cell(gk, c) {
    const mode = c.mode || (c.type === 'ro' ? 'ro' : 'manual');
    const cls = mode === 'auto' ? 'au' : mode === 'ro' ? 'ro' : 'mn';
    let value;
    if (c.type === 'enum') {
      value = `<select class="cv csel" data-g="${gk}" data-k="${c.key}">${
        c.values.map((v) => `<option${v === c.value ? ' selected' : ''}>${v}</option>`).join('')}</select>`;
    } else {
      value = `<span class="cv" data-g="${gk}" data-k="${c.key}">${c.fmt ? c.fmt(c.value) : c.value}</span>`;
    }
    return `<div class="cell ${cls}${c.type === 'num' ? ' scrub' : ''}" data-g="${gk}" data-k="${c.key}"
                 data-mode="${mode}" data-auto="${c.autoNote ? encodeURIComponent(c.autoNote) : ''}">
      <span class="ck">${c.label}</span>${value}<span class="cu">${c.unit || '&nbsp;'}</span>
    </div>`;
  }

  _find(gk, key) {
    const g = this.groups.find((x) => x.key === gk);
    return g && g.cells.find((c) => c.key === key);
  }

  _wire() {
    for (const sel of this.el.querySelectorAll('.csel')) {
      sel.addEventListener('change', () => this.onScrub && this.onScrub(sel.dataset.g, sel.dataset.k, sel.value));
      sel.addEventListener('pointerdown', (e) => e.stopPropagation());
    }

    for (const cell of this.el.querySelectorAll('.cell')) {
      const gk = cell.dataset.g, key = cell.dataset.k;
      const spec = this._find(gk, key);
      if (!spec) continue;

      // clicking the left edge toggles auto / manual
      cell.addEventListener('pointerdown', (e) => {
        if (e.offsetX <= 6 && spec.canAuto) {
          e.preventDefault(); e.stopPropagation();
          const next = cell.dataset.mode === 'auto' ? 'manual' : 'auto';
          this.onMode && this.onMode(gk, key, next);
          return;
        }
        if (spec.type !== 'num') return;
        e.preventDefault();
        const startX = e.clientX;
        const start = spec.value;
        cell.setPointerCapture(e.pointerId);
        const move = (ev) => {
          const dx = ev.clientX - startX;
          let v = start + dx * (spec.step || 1);
          if (spec.min != null) v = Math.max(spec.min, v);
          if (spec.max != null) v = Math.min(spec.max, v);
          if (spec.integer) v = Math.round(v);
          this.onScrub && this.onScrub(gk, key, v);
        };
        const up = () => {
          cell.removeEventListener('pointermove', move);
          cell.removeEventListener('pointerup', up);
        };
        cell.addEventListener('pointermove', move);
        cell.addEventListener('pointerup', up);
      });

      cell.addEventListener('pointerenter', () => this._showTip(cell, spec));
      cell.addEventListener('pointerleave', () => { this.tip.hidden = true; });
    }
  }

  _showTip(cell, spec) {
    const mode = cell.dataset.mode;
    if (mode === 'ro') {
      this.tip.innerHTML = `<span class="tk">${spec.label} · derived</span>A consequence, not a control.`;
    } else if (mode === 'auto') {
      this.tip.innerHTML = `<span class="tk">${spec.label} · auto</span>` +
        `<b>Re-derives</b> when anything upstream changes.` +
        (spec.autoNote ? `<br>From ${spec.autoNote}.` : '') +
        `<br><span class="dim">Click the edge to pin it.</span>`;
    } else {
      this.tip.innerHTML = `<span class="tk">${spec.label} · manual</span>` +
        `<b>Pinned</b> — stays put when upstream changes.` +
        (spec.autoValue != null
          ? `<br>Auto would suggest <em>${spec.fmt ? spec.fmt(spec.autoValue) : spec.autoValue}${spec.unit ? ' ' + spec.unit : ''}</em>.`
          : '') +
        `<br><span class="dim">Click the edge to release it.</span>`;
    }
    const r = cell.getBoundingClientRect();
    this.tip.hidden = false;
    const t = this.tip.getBoundingClientRect();
    this.tip.style.left = Math.max(8, Math.min(r.left, innerWidth - t.width - 8)) + 'px';
    this.tip.style.top = Math.max(8, r.top - t.height - 8) + 'px';
  }
}
