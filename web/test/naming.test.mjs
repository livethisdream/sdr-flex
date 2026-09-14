// What a node is called.
//
// `label` is what the node does and the palette set it. `name` is what the person
// building the graph calls it, and it is the only field in the graph that exists purely
// for a human — which is exactly why it needs bounding: it is the one value in the tool
// that arrives by being typed rather than measured.
//
//   node --test web/test/naming.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { MockEngine, cleanName } from '../src/engine.js';
import { Capture } from '../src/capture.js';

const RATE = 200_000, CENTER = 433_920_000;

function tone(seconds = 0.5) {
  const n = Math.round(RATE * seconds);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    buf[i * 2] = Math.round(127.5 + 90 * Math.cos(2 * Math.PI * 12_000 * t));
    buf[i * 2 + 1] = Math.round(127.5 + 90 * Math.sin(2 * Math.PI * 12_000 * t));
  }
  return new Capture({ buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
                       format: 'cu8', sampleRate: RATE, centerHz: CENTER, label: 'tone' });
}

async function opened() {
  const e = new MockEngine({ latency: false });
  await e.createSession();
  await e.openCapture(tone());
  const tuner = await e.addNode({ parent: e.root.id, op: 'core.tuner',
    selection: { f0: CENTER + 2_000, f1: CENTER + 22_000 }, at: 0.1 });
  return { e, tuner };
}

test('a name is squeezed onto one line and bounded', () => {
  assert.equal(cleanName('  fan  remote '), 'fan remote');
  // A label containing a newline is a rendering bug waiting for the first person who
  // pastes one in, so control characters are collapsed rather than escaped.
  assert.equal(cleanName('two\nlines'), 'two lines');
  assert.equal(cleanName('tab\there'), 'tab here');
  assert.equal(cleanName('bell\u0007here'), 'bell here');
  assert.equal(cleanName('del\u007fhere'), 'del here');
  // Long enough to be useful, short enough not to push a sibling off the most
  // horizontally constrained row in the layout.
  assert.equal(cleanName('x'.repeat(80)).length, 32);
  assert.equal(cleanName(''), '');
  assert.equal(cleanName(null), '');
  assert.equal(cleanName(undefined), '');
});

test('renaming replaces what it is called, not what it is', async () => {
  const { e, tuner } = await opened();
  assert.equal(e.node(tuner.id).label, 'Tuner');
  assert.equal(e.node(tuner.id).letter, 'A');

  await e.renameNode(tuner.id, 'fan remote');
  const n = e.node(tuner.id);
  assert.equal(n.name, 'fan remote');
  // Both survive, and they have to: `label` is how the flow view and every error
  // message refer to the node, and `letter` is the handle the channel markers, the
  // torn-off tiles and the export filenames all use.
  assert.equal(n.label, 'Tuner');
  assert.equal(n.letter, 'A');
});

test('an empty name clears it rather than setting one', async () => {
  const { e, tuner } = await opened();
  await e.renameNode(tuner.id, 'fan remote');
  await e.renameNode(tuner.id, '   ');
  // Absent, not empty string: a node with `name: ''` would be a node whose name is
  // falsy in every check and present in every serialization.
  assert.equal('name' in e.node(tuner.id), false);
});

test('any node can be named, not only a channel', async () => {
  const { e, tuner } = await opened();
  const det = await e.addNode({ parent: tuner.id, op: 'core.am_envelope', at: 0.1 });
  await e.renameNode(det.id, 'wide detector');
  assert.equal(e.node(det.id).name, 'wide detector');
  assert.equal(e.node(det.id).label, 'AM demod');
  // Blocks are not lettered (08-ui-principles), and naming one does not change that.
  assert.equal(e.node(det.id).letter, null);
});

test('renaming something that is not there is not an error', async () => {
  const { e } = await opened();
  assert.equal(await e.renameNode('nope', 'x'), null);
});

test('a name travels in the graph snapshot', async () => {
  const { e, tuner } = await opened();
  await e.renameNode(tuner.id, 'fan remote');
  const snap = e._snapshot();
  const n = snap.nodes.find((x) => x.id === tuner.id);
  assert.equal(n.name, 'fan remote');
  // And nothing private went with it — the snapshot is what crosses the wire.
  for (const k of Object.keys(n)) assert.notEqual(k[0], '_', k);
});

test('a name does not change what the node produces', async () => {
  const { e, tuner } = await opened();
  const before = await e.readSpan(tuner.id, 0, 0.2);
  await e.renameNode(tuner.id, 'fan remote');
  const after = await e.readSpan(tuner.id, 0, 0.2);
  assert.equal(after.count, before.count);
  assert.equal(after.sampleRate, before.sampleRate);
  for (let i = 0; i < 64; i++) assert.equal(after.data[i], before.data[i]);
});
