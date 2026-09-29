// The operations menu's order (ADR-0039), as data. Before this the order was whatever the
// catalog happened to be written in, which read as random.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrange, GROUP_ORDER, LEAD_ROWS } from '../src/menu.js';
import { OPS } from '../src/engine.js';

const catalog = (kind) => Object.entries(OPS)
  .filter(([, o]) => (Array.isArray(o.in) ? o.in : [o.in]).some((k) => k === '*' || k === kind))
  .map(([id, o]) => ({ id, ...o }));
const identify = { id: '__identify', name: 'Identify', group: '', lead: true, key: '?' };

test('every built-in operation has a rank and a known group', () => {
  for (const [id, o] of Object.entries(OPS)) {
    assert.equal(typeof o.rank, 'number', `${id} has no rank`);
    assert.ok(GROUP_ORDER.includes(o.group), `${id} is in unknown group ${o.group}`);
  }
});

test('on IQ, Identify leads on its own, then the chain, then a fold', () => {
  const m = arrange([...catalog('iq'), identify]);
  assert.equal(m.lead.id, '__identify');
  assert.deepEqual(m.top.map((o) => o.name),
    ['Tune here', 'AM demod', 'FM demod', 'SSB demod', 'CW demod', 'De-hop']);
  assert.ok(m.folded > 0);
  assert.deepEqual(m.groups, []);
});

test('Identify is never filed under a heading', () => {
  const m = arrange([...catalog('iq'), identify], { expanded: true });
  for (const g of m.groups) assert.ok(!g.items.some((o) => o.lead), `Identify under ${g.name}`);
  const s = arrange([...catalog('iq'), identify], { filter: 'e' });
  for (const g of s.groups) assert.ok(!g.items.some((o) => o.lead));
});

test('expanded, the rest is grouped in chain order and ranked inside each group', () => {
  const m = arrange(catalog('iq'), { expanded: true });
  assert.equal(m.folded, 0);
  const order = m.groups.map((g) => GROUP_ORDER.indexOf(g.name));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  for (const g of m.groups) {
    const r = g.items.map((o) => o.rank);
    assert.deepEqual(r, [...r].sort((a, b) => a - b), `${g.name} is out of rank order`);
  }
  // nothing is lost to the fold
  assert.equal(m.top.length + m.groups.reduce((n, g) => n + g.items.length, 0), catalog('iq').length);
});

test('at most six lead, and only first-tier operations', () => {
  for (const kind of ['iq', 'real', 'bytes', 'bits', 'events']) {
    const m = arrange(catalog(kind));
    assert.ok(m.top.length <= LEAD_ROWS, kind);
    for (const o of m.top) assert.ok(o.rank < 50, `${o.name} leads on ${kind}`);
  }
});

test('a short list is drawn whole, by rank, with no fold', () => {
  const m = arrange(catalog('bits'));
  assert.equal(m.folded, 0);
  const all = m.groups.flatMap((g) => g.items).map((o) => o.name);
  assert.equal(all[0], 'Frames & CRC');
  assert.deepEqual(all.slice(-2), ['Export', 'Stream out']);
});

test('search sees folded operations', () => {
  const m = arrange(catalog('iq'), { filter: 'raster' });
  assert.deepEqual(m.groups.flatMap((g) => g.items).map((o) => o.name), ['Raster']);
});

test('an unranked operation (a plugin, a local decoder) never leads', () => {
  const plugin = { id: 'p', name: 'Aardvark', group: 'Decode', in: 'iq' };
  const m = arrange([...catalog('iq'), plugin]);
  assert.ok(!m.top.includes(plugin));
});
