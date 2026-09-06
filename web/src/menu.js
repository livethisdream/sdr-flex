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
      if (e.key === 'Escape') { this.close(); e.preventDefault(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Typing anywhere in an open menu goes to the search box — which is also how
      // the box arrives when the list was short enough not to draw one. `/` asks for
      // it empty; any other printable key asks for it and is the first thing in it.
      const opening = e.key === '/';
      if (!opening && e.key.length !== 1) return;
      const input = this.el.querySelector('input');
      if (!input) {
        this.searching = true;
        this.filter = opening ? '' : e.key;
        this._render();
        const ni = this.el.querySelector('input');
        if (ni) { ni.focus(); ni.setSelectionRange(ni.value.length, ni.value.length); }
        e.preventDefault();
        e.stopPropagation();
      } else if (document.activeElement !== input) {
        input.focus();
        if (opening) { e.preventDefault(); e.stopPropagation(); }
      }
    }, true);
  }

  open(x, y, ops, onPick) {
    this.ops = ops;
    this.onPick = onPick;
    this._picked = false;
    this.filter = '';
    this.searching = false;
    this.el.hidden = false;
    this._render();

    const r = this.el.getBoundingClientRect();
    const pad = 8;
    const left = Math.min(x, innerWidth - r.width - pad);
    const top = Math.min(y, innerHeight - r.height - pad);
    this.el.style.left = Math.max(pad, left) + 'px';
    this.el.style.top = Math.max(pad, top) + 'px';

    // Focusing the search box summons the on-screen keyboard on a touch device,
    // which covers half the screen to save a keystroke nobody asked for. Autofocus
    // only where a hardware keyboard is implied; elsewhere the first printable key
    // still focuses it (see _render), so the desktop flow is unchanged.
    if (this._wantsKeyboard()) {
      const input = this.el.querySelector('input');
      if (input) input.focus();
    }
  }

  close() {
    const wasOpen = !this.el.hidden;
    this.el.hidden = true;
    if (wasOpen && !this._picked && this.onClose) this.onClose();
  }

  _wantsKeyboard() {
    try {
      return matchMedia('(pointer: fine)').matches && !matchMedia('(hover: none)').matches;
    } catch (e) {
      return true;
    }
  }

  _render() {
    const q = this.filter.toLowerCase();
    const shown = this.ops.filter((o) => !q || o.name.toLowerCase().includes(q) || o.group.toLowerCase().includes(q));
    const groups = [];
    for (const o of shown) {
      let g = groups.find((x) => x.name === o.group);
      if (!g) { g = { name: o.group, items: [] }; groups.push(g); }
      g.items.push(o);
    }

    // Headings are for finding your way in a list too long to read, and this list is
    // type-filtered before it is drawn. A heading above two items is a label on a
    // label. Past about half a dozen the list stops being read and starts being
    // scanned, and then the headings earn their space — as they do on an `iq` node
    // now that the wave 1 detectors are in. Searching still matches on group name
    // either way, so "decode" finds the decoders whether or not the word is shown.
    const headed = shown.length > 5 && groups.length > 1;
    // A search box over four self-describing items is a control for a problem the
    // list does not have — and on a phone it is a keyboard covering half the screen
    // on the way to a menu. It appears with the headings, or the moment someone
    // types, whichever comes first; `/` asks for it by name.
    const searchable = headed || this.searching || !!this.filter;
    // a hairline still separates the runs — the grouping was worth keeping, the
    // words above it were not
    const item = (o, i, gi) =>
      `<button class="ctx-i${o.stub ? ' stub' : ''}${!headed && gi > 0 && i === 0 ? ' gsep' : ''}" data-op="${o.id}">${o.name}` +
      `${o.external ? '<span class="ext">ext</span>' : ''}` +
      `${o.stub ? '<span class="soon">M4</span>' : ''}</button>`;

    this.el.innerHTML =
      (searchable
        ? `<div class="ctx-search"><input type="text" placeholder="search…" value="${this.filter}" aria-label="Search operations"></div>`
        : '') +
      (groups.length
        ? groups.map((g, gi) => (headed ? `<div class="ctx-grp">${g.name}</div>` : '') +
                                g.items.map((o, i) => item(o, i, gi)).join('')).join('')
        : '<div class="ctx-none">nothing valid here</div>');

    const input = this.el.querySelector('input');
    if (input) {
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
    }

    for (const b of this.el.querySelectorAll('.ctx-i')) {
      b.addEventListener('click', () => {
        if (b.classList.contains('stub')) return;
        const op = b.dataset.op;
        this._picked = true;
        this.close();
        this.onPick && this.onPick(op);
      });
    }
  }
}
