// Keys that add an operation.
//
// A hotkey here is a third way into the contextual menu (ADR-0018), not a second way of
// building a graph: pressing one runs the same code the menu's own entry runs, with the
// same selection, and is refused in exactly the places the menu would not have offered
// the operation. There is nothing a key can build that a click cannot, which is the
// property that keeps the two from drifting apart.
//
// It lives in its own file so the table and the rule can be read and tested without a
// browser — the rest of the keyboard is bound inside `app.js` against real DOM, and a
// table of what-does-what does not need to be.

/**
 * One key per operation you reach for constantly, keyed by what the menu calls it.
 *
 * **A key names a list, not an operation.** Two of them want `s` — SSB demod and Stereo
 * decode — and that is not a collision, because they can never be offered at once: one
 * takes `iq` and the other takes `real`, so the type filter that decides what is in the
 * menu (ADR-0006) decides what the key means too. The first entry the current palette
 * actually offers is the one it means. That is the rule the menu already runs on rather
 * than a special case bolted beside it.
 */
export const HOTKEYS = {
  t: ['core.tuner'],
  a: ['core.am_envelope'],
  f: ['core.fm_discriminator'],
  s: ['core.ssb', 'core.stereo'],
  c: ['core.cw'],
  l: ['core.audio'],
  e: ['core.export'],
};

/**
 * Keys the application already binds to something else, which are therefore not
 * available here.
 *
 * Listed rather than remembered: the transport and zoom bindings are matched before this
 * table is consulted and do not `return`, so a key in both would fire both — the metrics
 * pane would open *and* a node would appear. That is the kind of bug that gets noticed
 * three weeks later, so a test asserts the two sets stay disjoint.
 */
export const RESERVED = [' ', 'ArrowLeft', 'ArrowRight', 'Escape', 'm', 'M', '=', '+', '-', '_', '0', '/'];

/** The key that reaches an operation, for the badge the menu draws beside it. */
export const KEY_FOR = {};
for (const [key, ops] of Object.entries(HOTKEYS)) for (const op of ops) KEY_FOR[op] = key;

/**
 * What this key means here, given what the palette is offering.
 *
 * `ops` is the palette for the current node — the same list the menu draws. Returns the
 * descriptor, so the caller can tell a stub from a real operation and can report the
 * name rather than the id, or null when nothing this key names is valid.
 */
export function opForKey(key, ops) {
  const wanted = Object.prototype.hasOwnProperty.call(HOTKEYS, key) ? HOTKEYS[key] : null;
  if (!wanted) return null;
  for (const id of wanted) {
    const found = (ops || []).find((o) => o.id === id);
    if (found) return found;
  }
  return null;
}

/** What a key names when nothing here can take it, for the sentence that says so. */
export function firstOpNamed(key) {
  const wanted = HOTKEYS[key];
  return wanted ? wanted[0] : null;
}
