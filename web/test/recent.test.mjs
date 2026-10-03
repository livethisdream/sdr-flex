// The library leads with what you opened last, then the newest files — so the first tap
// on a phone shows captures rather than a search box and "more… 40".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrange, LEAD_ROWS } from '../src/menu.js';
import { leadRanks } from '../src/recent.js';

const caps = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, label: `c${i}`, modified: i }));
const asOps = (ranks) => caps.map((c) => ({ id: c.id, name: c.label, group: 'SigMF', rank: ranks.get(c.id) }));

test('with nothing opened yet, the newest files lead', () => {
  const m = arrange(asOps(leadRanks(caps, [])));
  assert.deepEqual(m.top.map((o) => o.id), ['c39', 'c38', 'c37', 'c36', 'c35', 'c34']);
  assert.equal(m.folded, caps.length - LEAD_ROWS);
});

test('recently opened lead, in the order they were opened, ahead of newer files', () => {
  const m = arrange(asOps(leadRanks(caps, ['c3', 'c10'])));
  assert.deepEqual(m.top.map((o) => o.id), ['c3', 'c10', 'c39', 'c38', 'c37', 'c36']);
});

test('a remembered capture that is no longer in the library is skipped', () => {
  const r = leadRanks(caps, ['gone', 'c5']);
  assert.equal(r.get('c5'), 1);
  assert.ok(!r.has('gone'));
});

test('everything stays reachable: the rest is behind more…, and search sees it all', () => {
  const ops = asOps(leadRanks(caps, []));
  assert.equal(arrange(ops, { expanded: true }).groups.flatMap((g) => g.items).length, caps.length - LEAD_ROWS);
  assert.deepEqual(arrange(ops, { filter: 'c1' }).groups.flatMap((g) => g.items).length, 11);
});
