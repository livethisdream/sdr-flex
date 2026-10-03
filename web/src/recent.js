// Which captures the library leads with.
//
// The library is a menu, and the menu leads with at most six ranked rows and folds the
// rest behind `more…` (ADR-0039). Captures had no rank, so on a phone the first tap
// showed a search box and "more… 40" — nothing you could open without a second tap and
// a scroll. What you are most likely to want is what you had open last, so those lead,
// and the newest files fill whatever is left. Per browser, in localStorage: which
// captures somebody opens is a fact about them, not about the box.

import { LEAD_ROWS } from './menu.js';

const STORE = 'sdrflex.recent.v1';
const KEEP = 12;

function store() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

/** Library ids, most recently opened first. */
export function recent() {
  try {
    const v = JSON.parse(store()?.getItem(STORE) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}

export function noteOpened(id) {
  const list = [id, ...recent().filter((x) => x !== id)].slice(0, KEEP);
  try { store()?.setItem(STORE, JSON.stringify(list)); } catch { /* private window */ }
}

/**
 * A rank for each capture that should lead, by id. Recently opened first, in the order
 * they were opened, then the newest by modification time. Anything not in the map is
 * left unranked and sorts by name behind `more…`, as before.
 */
export function leadRanks(caps, opened = recent(), n = LEAD_ROWS) {
  const ids = new Set(caps.map((c) => c.id));
  const lead = opened.filter((id) => ids.has(id));
  const newest = caps.filter((c) => !lead.includes(c.id))
    .sort((a, b) => (b.modified || 0) - (a.modified || 0)).map((c) => c.id);
  const ranks = new Map();
  for (const id of [...lead, ...newest].slice(0, n)) ranks.set(id, ranks.size + 1);
  return ranks;
}
