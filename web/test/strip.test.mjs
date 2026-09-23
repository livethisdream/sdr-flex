// The control strip's popover, and the one thing it must not do: close itself while
// somebody is using it.
//
//   node --test web/test/strip.test.mjs
//
// The strip re-renders on every parameter change, which throws away and rebuilds its
// pills. An open popover therefore has to be re-anchored afterwards, and how that was
// done had a hole: it looked for the pill belonging to the control, and a *folded*
// control does not have one — it lives behind its group's `more` chip. So the lookup
// found nothing and the popover closed.
//
// `min` and `max` on the spectrum's dB range fold at every width anybody uses. Adjusting
// either one changes a parameter, which re-renders the strip, which closed the control
// that was doing the adjusting: the slider vanished the moment you moved it.
//
// There is no browser here, so this drives the method against stub elements. That is
// enough, because what was wrong is a choice of selector rather than anything about
// layout: given a group whose control is folded, does it find the chip or give up?

import test from 'node:test';
import assert from 'node:assert/strict';
import { Strip } from '../src/strip.js';

// `_place` clamps the popover to the window, so it reads `innerWidth`. Node has no
// window; the browser always does. One global rather than a whole DOM.
globalThis.innerWidth = globalThis.innerWidth ?? 1440;

/** The smallest thing `_reopen` can be asked to work on. */
function stub({ inlinePills = [], morePills = ['view'] } = {}) {
  const made = [];
  const el = (cls, data) => {
    const node = { className: cls, dataset: data, classList: {
      _on: new Set(),
      add(c) { this._on.add(c); }, remove(c) { this._on.delete(c); },
      toggle(c, on) { if (on) this.add(c); else this.remove(c); },
      contains(c) { return this._on.has(c); },
    }, getBoundingClientRect: () => ({ left: 10, top: 100, width: 40, height: 20 }) };
    made.push(node);
    return node;
  };
  const inline = inlinePills.map(([g, k]) => el('pill', { g, k }));
  const more = morePills.map((g) => el('pill more', { g }));
  const closed = [];
  const rebuiltVia = [];
  const self = {
    groups: [{ key: 'view', title: 'view', cells: [
      { key: 'dbMin', label: 'min', type: 'num', value: -74, canAuto: true, mode: 'manual',
        autoNote: 'the tenth percentile of what is on screen' },
      { key: 'bins', label: 'fft', type: 'enum', value: '1024', values: ['512', '1024'] },
    ] }],
    el: {
      querySelector(sel) {
        const k = /data-k="([^"]+)"/.exec(sel);
        const g = /data-g="([^"]+)"/.exec(sel);
        if (sel.includes('.more')) return more.find((m) => !g || m.dataset.g === g[1]) || null;
        return inline.find((p) => k && p.dataset.k === k[1] && (!g || p.dataset.g === g[1])) || null;
      },
    },
    pop: { hidden: false, style: {}, querySelector: () => null,
           getBoundingClientRect: () => ({ width: 200, height: 120 }) },
    closePop() { closed.push(true); this.pop.hidden = true; },
    // The old version reached for this; the new one must not, because rebuilding the
    // popover replaces the element being dragged. Stubbed so the difference shows up as
    // a behavior difference rather than as a missing method.
    openPop(g, k, pill) { self._openPill = pill; rebuiltVia.push(k); },
    _find: Strip.prototype._find,
    _mode: Strip.prototype._mode,
    _place: Strip.prototype._place,
    _openPill: null,
  };
  return { self, closed, more, inline, rebuiltVia };
}

test('a folded control re-anchors to its group chip instead of closing', () => {
  // The regression. `dbMin` has no pill of its own — it is behind `more` — and the
  // popover must survive the re-render that adjusting it causes.
  const { self, closed, more } = stub({ inlinePills: [], morePills: ['view'] });
  Strip.prototype._reopen.call(self, { g: 'view', k: 'dbMin' });
  assert.equal(closed.length, 0, 'the popover closed on a folded control');
  assert.equal(self._openPill, more[0], 'it did not re-anchor to the group chip');
  assert.equal(self.pop.hidden, false);
});

test('an inline control still re-anchors to its own pill', () => {
  const { self, closed, inline } = stub({ inlinePills: [['view', 'dbMin']] });
  Strip.prototype._reopen.call(self, { g: 'view', k: 'dbMin' });
  assert.equal(closed.length, 0);
  assert.equal(self._openPill, inline[0], 'an inline control should anchor to its own pill');
});

test('a control whose group has gone closes, because there is nothing to point at', () => {
  const { self, closed } = stub({ inlinePills: [], morePills: [] });
  Strip.prototype._reopen.call(self, { g: 'view', k: 'dbMin' });
  assert.equal(closed.length, 1, 'with no pill and no chip the popover has no anchor');
});

test('re-anchoring repositions but does not rebuild the popover', () => {
  // The other half, and the reason this does not simply call `openPop` again: rebuilding
  // replaces the range input the pointer is dragging, and a native drag does not survive
  // its element being swapped. The popover would stay on screen and stop following the
  // mouse — which looks like the control working, and is worse.
  const { self, rebuiltVia } = stub();
  let rebuilt = false;
  Object.defineProperty(self.pop, 'innerHTML', { set() { rebuilt = true; }, get: () => '' });
  Strip.prototype._reopen.call(self, { g: 'view', k: 'dbMin' });
  assert.equal(rebuilt, false, 'the popover contents were rebuilt under the pointer');
  assert.deepEqual(rebuiltVia, [], 'it went back through openPop, which rebuilds everything');
  assert.equal(self.pop.style.left, '10px', 'it should still be placed against its anchor');
});
