// The contextual menu (ADR-0018). It opens where the drag was released, so the one
// gesture the tool teaches is also how you discover it. Flat, grouped, searchable —
// menu depth stays at 1.

export class ContextMenu {
  constructor(root) {
    this.el = document.createElement('div');
    this.el.className = 'ctx';
    this.el.hidden = true;
    root.appendChild(this.el);
    this.onPick = null;
    addEventListener('pointerdown', (e) => {
      if (!this.el.hidden && !this.el.contains(e.target)) this.close();
    });
    addEventListener('keydown', (e) => {
      if (this.el.hidden) return;
      if (e.key === 'Escape') { this.close(); e.preventDefault(); }
    });
  }

  open(x, y, ops, onPick) {
    this.ops = ops;
    this.onPick = onPick;
    this.filter = '';
    this.el.hidden = false;
    this._render();

    const r = this.el.getBoundingClientRect();
    const pad = 8;
    const left = Math.min(x, innerWidth - r.width - pad);
    const top = Math.min(y, innerHeight - r.height - pad);
    this.el.style.left = Math.max(pad, left) + 'px';
    this.el.style.top = Math.max(pad, top) + 'px';
    const input = this.el.querySelector('input');
    if (input) input.focus();
  }

  close() { this.el.hidden = true; }

  _render() {
    const q = this.filter.toLowerCase();
    const shown = this.ops.filter((o) => !q || o.name.toLowerCase().includes(q) || o.group.toLowerCase().includes(q));
    const groups = [];
    for (const o of shown) {
      let g = groups.find((x) => x.name === o.group);
      if (!g) { g = { name: o.group, items: [] }; groups.push(g); }
      g.items.push(o);
    }

    this.el.innerHTML =
      `<div class="ctx-search"><input type="text" placeholder="search…" value="${this.filter}" aria-label="Search operations"></div>` +
      (groups.length
        ? groups.map((g) =>
            `<div class="ctx-grp">${g.name}</div>` +
            g.items.map((o) =>
              `<button class="ctx-i${o.stub ? ' stub' : ''}" data-op="${o.id}">${o.name}` +
              `${o.external ? '<span class="ext">ext</span>' : ''}` +
              `${o.stub ? '<span class="soon">M4</span>' : ''}</button>`).join('')
          ).join('')
        : '<div class="ctx-none">nothing valid here</div>');

    const input = this.el.querySelector('input');
    input.addEventListener('input', () => {
      this.filter = input.value;
      const pos = input.selectionStart;
      this._render();
      const ni = this.el.querySelector('input');
      ni.focus();
      ni.setSelectionRange(pos, pos);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = this.el.querySelector('.ctx-i:not(.stub)');
        if (first) first.click();
      }
    });

    for (const b of this.el.querySelectorAll('.ctx-i')) {
      b.addEventListener('click', () => {
        if (b.classList.contains('stub')) return;
        const op = b.dataset.op;
        this.close();
        this.onPick && this.onPick(op);
      });
    }
  }
}
