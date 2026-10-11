// The contextual menu (ADR-0018). It opens where the drag was released, so the one
// gesture the tool teaches is also how you discover it. Flat, grouped, searchable —
// menu depth stays at 1.

import { menuTakesKey } from './keys.js';

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

      // A row that says "press f to add this" has to answer to f — see `menuTakesKey`,
      // which is where that rule and its exceptions are written down.
      // Folded rows answer too: a key is a way to the operation, and the fold is about
      // what the eye has to read, not about what is available.
      const keyed = this.ops.filter((o) => o.key && !o.stub);
      if (menuTakesKey(e.key, { filter: this.filter, keys: keyed.map((o) => o.key) })) {
        e.preventDefault();
        e.stopPropagation();
        this._pick(keyed.find((o) => o.key === e.key).id);
        return;
      }

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
    // The fold does not persist (ADR-0039): an expansion that remembers is a preference
    // nobody set, and the menu would open differently depending on the last one.
    this.expanded = false;
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
    const { lead, top, groups, folded, headed } = arrange(this.ops, { filter: this.filter, expanded: this.expanded });
    // A search box over four self-describing items is a control for a problem the
    // list does not have — and on a phone it is a keyboard covering half the screen
    // on the way to a menu. It appears with the headings, or the moment someone
    // types, whichever comes first; `/` asks for it by name.
    const searchable = headed || folded > 0 || this.searching || !!this.filter;
    // The key an operation also answers to, shown where the operation is. A shortcut
    // documented in a help screen is a shortcut nobody learns; shown on the row you were
    // about to click, it is learned by the third time you click it.
    const item = (o, cls) =>
      `<button class="ctx-i${cls ? ' ' + cls : ''}${o.stub ? ' stub' : ''}"` +
      ` data-op="${o.id}"${o.key && !o.stub ? ` data-key="${o.key}"` : ''}${o.hint ? ` title="${o.hint}"` : ''}>${o.name}` +
      `${o.local ? `<span class="ext mine" title="from your ${o.local} pack">yours</span>`
        : o.external ? '<span class="ext">ext</span>'
        // A recipe: a saved arrangement of GNU Radio blocks (ADR-0043), not one operation.
        : o.recipe ? '<span class="ext rcp" title="a recipe: a GNU Radio Companion hier block in recipes/">recipe</span>' : ''}` +
      `${o.soon ? `<span class="soon">${o.soon}</span>` : ''}` +
      `${o.key && !o.stub ? `<kbd class="ctx-k" title="press ${o.key} to add this">${o.key}</kbd>` : ''}</button>`;

    const body =
      (lead ? item(lead, 'lead') : '') +
      top.map((o) => item(o)).join('') +
      (folded ? `<button class="ctx-more" data-more="1">more… <span>${folded}</span></button>` : '') +
      groups.map((g) => (headed ? `<div class="ctx-grp">${g.name}</div>` : '') +
                        g.items.map((o) => item(o, headed ? 'under' : '')).join('')).join('');

    this.el.innerHTML =
      (searchable
        ? `<div class="ctx-search"><input type="text" placeholder="search…" value="${this.filter}" aria-label="Search operations"></div>`
        : '') +
      (body || '<div class="ctx-none">nothing valid here</div>');

    const more = this.el.querySelector('.ctx-more');
    if (more) {
      more.addEventListener('click', () => {
        this.expanded = true;
        this._render();
      });
    }

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
        this._pick(b.dataset.op);
      });
    }
  }

  _pick(op) {
    this._picked = true;
    this.close();
    this.onPick && this.onPick(op);
  }
}

/**
 * The headings, in the order a chain is built: narrow it, demodulate it, decode it, hear
 * it — then the things beside the chain. Before this the order was whichever operation
 * happened to be written first in the catalog, so De-hop sat under Narrow and Export came
 * before Analyze on one stream type and after it on another.
 */
export const GROUP_ORDER = ['Narrow', 'Demodulate', 'Decode', 'Listen', 'Analyze', 'Convert', 'Export'];

/** Where the fold goes (ADR-0039), and the rank below which an operation leads. */
export const LEAD_ROWS = 6;
export const FIRST_TIER = 50;

const UNRANKED = 90;
const rankOf = (o) => (o.rank == null ? UNRANKED : o.rank);
const groupIndex = (g) => { const i = GROUP_ORDER.indexOf(g); return i < 0 ? GROUP_ORDER.length : i; };
const byRank = (a, b) => rankOf(a) - rankOf(b) || a.name.localeCompare(b.name);

/**
 * What the menu draws, as data — so the order is testable without a DOM.
 *
 * - `lead` is the one row that is not an operation on the chain (`Identify`). It sits
 *   above everything under no heading, because it is not a kind of step; it is the way to
 *   find out which step you want.
 * - `top` is at most six first-tier operations by rank, with no headings: six
 *   self-describing rows do not need labels.
 * - `folded` counts what `more…` would show. Expanded, or when there is nothing worth
 *   folding, the rest is `groups`, in chain order and by rank inside each.
 * - A search sees everything, folded or not, and returns it grouped.
 */
export function arrange(ops, { filter = '', expanded = false } = {}) {
  const q = filter.toLowerCase();
  const hit = (o) => !q || o.name.toLowerCase().includes(q) || (o.group || '').toLowerCase().includes(q);
  const leadOp = ops.find((o) => o.lead && hit(o)) || null;
  const rest = ops.filter((o) => !o.lead && hit(o)).sort(byRank);

  const grouped = (list) => {
    const out = [];
    for (const o of list) {
      let g = out.find((x) => x.name === o.group);
      if (!g) { g = { name: o.group, items: [] }; out.push(g); }
      g.items.push(o);
    }
    out.sort((a, b) => groupIndex(a.name) - groupIndex(b.name));
    return out;
  };

  // Searching, or a list short enough to read whole: no fold.
  if (q || rest.length <= LEAD_ROWS) {
    const groups = q ? grouped(rest) : [{ name: '', items: rest }];
    // Headings are for finding your way in a list too long to read. A heading above two
    // items is a label on a label.
    const headed = !!q && rest.length > 5 && groups.length > 1;
    return { lead: leadOp, top: [], groups: headed ? groups : [{ name: '', items: rest }], folded: 0, headed };
  }

  const top = rest.filter((o) => rankOf(o) < FIRST_TIER && !o.stub).slice(0, LEAD_ROWS);
  const below = rest.filter((o) => !top.includes(o));
  if (!expanded) return { lead: leadOp, top, groups: [], folded: below.length, headed: false };
  const groups = grouped(below);
  return { lead: leadOp, top, groups, folded: 0, headed: groups.length > 1 || below.length > 5 };
}
