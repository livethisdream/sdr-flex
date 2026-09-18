// The keys that add an operation.
//
//   node --test web/test/keys.test.mjs
//
// A hotkey is a shortcut into the contextual menu, so almost everything worth asserting
// is about the two staying the same: that every key names an operation that exists, that
// what a key means is decided by the same type filter the menu is drawn from, and that
// no key quietly does two things because the rest of the keyboard already claimed it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { HOTKEYS, KEY_FOR, RESERVED, opForKey, firstOpNamed, menuTakesKey } from '../src/keys.js';
import { MockEngine, OPS } from '../src/engine.js';
import { Capture } from '../src/capture.js';

const RATE = 240_000, CENTER = 98_500_000;

/** An engine on a plain FM carrier, which is enough to have a palette on. */
async function engine() {
  const count = Math.round(RATE * 0.4);
  const buf = Buffer.allocUnsafe(count * 2);
  let phase = 0;
  for (let i = 0; i < count; i++) {
    phase += (2 * Math.PI * 8000 * Math.sin((2 * Math.PI * 1000 * i) / RATE)) / RATE;
    buf[i * 2] = Math.round(Math.cos(phase) * 110 + 127.5);
    buf[i * 2 + 1] = Math.round(Math.sin(phase) * 110 + 127.5);
  }
  const e = new MockEngine({ latency: false });
  await e.createSession();
  await e.openCapture(new Capture({
    buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    format: 'cu8', sampleRate: RATE, centerHz: CENTER, label: 'fm',
  }));
  return e;
}

// ── the table ───────────────────────────────────────────────────────────────

test('every key names operations that exist', () => {
  for (const [key, ops] of Object.entries(HOTKEYS)) {
    assert.equal(key.length, 1, `${key} is a single key`);
    assert.ok(ops.length, `${key} names something`);
    for (const id of ops) assert.ok(OPS[id], `${key} names ${id}, which is not an operation`);
  }
});

test('no key is one the rest of the keyboard already owns', () => {
  // The transport and zoom bindings are matched first and do not return, so a key in
  // both sets would fire both — the metrics pane would open *and* a node would appear.
  for (const key of Object.keys(HOTKEYS)) {
    assert.ok(!RESERVED.includes(key), `${key} is already bound to something else`);
  }
});

test('the badge the menu draws points back at the key that reaches it', () => {
  for (const [key, ops] of Object.entries(HOTKEYS)) {
    for (const id of ops) assert.equal(KEY_FOR[id], key, `${id} should badge as ${key}`);
  }
});

// ── what a key means, which depends on where you are ────────────────────────

test('a key means the first operation the palette actually offers', () => {
  const ssb = { id: 'core.ssb', name: 'SSB demod' };
  const stereo = { id: 'core.stereo', name: 'Stereo decode' };
  assert.equal(opForKey('s', [ssb]).id, 'core.ssb');
  assert.equal(opForKey('s', [stereo]).id, 'core.stereo');
  // The order in the table is the tie-break, for a palette that somehow offered both.
  assert.equal(opForKey('s', [stereo, ssb]).id, 'core.ssb');
});

test('a key nothing here can take resolves to nothing, and says what it wanted', () => {
  assert.equal(opForKey('s', [{ id: 'core.pwm_slicer' }]), null);
  assert.equal(opForKey('z', []), null, 'and an unbound key is simply not a hotkey');
  assert.equal(firstOpNamed('s'), 'core.ssb', 'so the refusal can name the thing by name');
  assert.equal(firstOpNamed('z'), null);
});

test('inherited properties are not hotkeys', () => {
  // `HOTKEYS[key]` with key === 'constructor' finds a function on the prototype, and a
  // handler that tested truthiness would have treated it as a list of operations.
  assert.equal(opForKey('constructor', []), null);
  assert.equal(opForKey('toString', []), null);
});

// ── the key, with the menu open ─────────────────────────────────────────────

test('a menu row answers to the key it advertises', () => {
  // Reported as "hotkeys aren't working — it just enters text into the search box", and
  // that is exactly what happened: the drag that opens the menu is the main gesture, the
  // menu draws `press f to add this` on the row, and every printable key then went to the
  // search box. Two features that were each right on their own.
  const keys = ['t', 'a', 'f', 's', 'c', 'e'];
  assert.equal(menuTakesKey('f', { filter: '', keys }), true);
  assert.equal(menuTakesKey('t', { filter: '', keys }), true);
});

test('a key for something not on offer here goes to the search box', () => {
  // `keys` is what the rows actually show, not the whole table. On a stream where FM
  // demod is not valid there is no row wearing an `f`, so `f` is a letter.
  assert.equal(menuTakesKey('f', { filter: '', keys: ['e'] }), false);
  assert.equal(menuTakesKey('z', { filter: '', keys: ['t', 'f'] }), false);
});

test('once you are searching, letters are a search', () => {
  // The case the old rule existed to protect, and it still holds: `f` cannot mean both
  // "FM demod" and "type an f", so the moment there is a filter it means the letter.
  const keys = ['t', 'a', 'f'];
  assert.equal(menuTakesKey('f', { filter: 'x', keys }), false);
  assert.equal(menuTakesKey('t', { filter: 'fm', keys }), false);
});

test('slash always asks for the search box, never a row', () => {
  assert.equal(menuTakesKey('/', { filter: '', keys: ['/', 't'] }), false);
});

test('a keystroke that is not a single character is not a pick', () => {
  for (const k of ['Enter', 'ArrowDown', 'Escape', 'Shift', '', undefined, null]) {
    assert.equal(menuTakesKey(k, { filter: '', keys: ['t'] }), false, `${k}`);
  }
});

test('every key the table names can be taken by a row that offers it', () => {
  // The badge and the handler read the same table, so a key drawn on a row is a key a
  // row answers to. If these ever came from two places this is what would catch it.
  for (const key of Object.keys(HOTKEYS)) {
    assert.equal(menuTakesKey(key, { filter: '', keys: [key] }), true, `${key} is takeable`);
  }
});

// ── against a real palette ──────────────────────────────────────────────────

test('the demod keys resolve on a channel of IQ', async () => {
  const e = await engine();
  const tuner = await e.addNode({ parent: e.root.id, op: 'core.tuner',
    selection: { f0: CENTER - 60_000, f1: CENTER + 60_000 }, at: 0.1 });
  const ops = await e.palette(tuner.id);
  assert.equal(opForKey('a', ops).id, 'core.am_envelope');
  assert.equal(opForKey('f', ops).id, 'core.fm_discriminator');
  assert.equal(opForKey('s', ops).id, 'core.ssb', 'on IQ, s is the sideband one');
  assert.equal(opForKey('c', ops).id, 'core.cw');
  // and the outputs are not, because IQ is not something you listen to directly
  assert.equal(opForKey('l', ops), null);
});

test('the output keys resolve on what a demodulator produced', async () => {
  const e = await engine();
  const tuner = await e.addNode({ parent: e.root.id, op: 'core.tuner',
    selection: { f0: CENTER - 60_000, f1: CENTER + 60_000 }, at: 0.1 });
  const fm = await e.addNode({ parent: tuner.id, op: 'core.fm_discriminator', at: 0.1 });
  const ops = await e.palette(fm.id);
  assert.equal(opForKey('l', ops).id, 'core.audio');
  assert.equal(opForKey('e', ops).id, 'core.export');
  assert.equal(opForKey('s', ops).id, 'core.stereo', 'on a composite, s is the stereo one');
  assert.equal(opForKey('a', ops), null, 'and a detector does not take a detector');
});

test('every operation with a key is reachable from somewhere', async () => {
  // A key for an operation no palette ever offers is a key that does nothing forever,
  // and nothing else in the table would notice.
  const e = await engine();
  const tuner = await e.addNode({ parent: e.root.id, op: 'core.tuner',
    selection: { f0: CENTER - 60_000, f1: CENTER + 60_000 }, at: 0.1 });
  const fm = await e.addNode({ parent: tuner.id, op: 'core.fm_discriminator', at: 0.1 });
  const reachable = new Set();
  for (const id of [e.root.id, tuner.id, fm.id]) {
    for (const o of await e.palette(id)) reachable.add(o.id);
  }
  for (const id of Object.keys(KEY_FOR)) {
    assert.ok(reachable.has(id), `${id} has the key ${KEY_FOR[id]} and is offered nowhere`);
  }
});
