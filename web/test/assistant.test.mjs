// The assistant's tools against a real chain, and its loop against a scripted model.
// Nothing here calls the API.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MockEngine } from '../src/engine.js';
import { Capture } from '../src/capture.js';
import { Assistant, findPeaks } from '../../server/assistant.js';

const FIX = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'fixtures', 'manchester-crc');

async function manchester() {
  const b = fs.readFileSync(path.join(FIX, 'capture.sigmf-data'));
  const cap = new Capture({ buffer: b.buffer.slice(b.byteOffset, b.byteOffset + b.length),
    format: 'cu8', sampleRate: 200_000, centerHz: 433_920_000, label: 'manchester' });
  const e = new MockEngine({ latency: false });
  await e.createSession();
  await e.openCapture(cap);
  let parent = e.root.id;
  const ids = [];
  for (const op of ['core.am_envelope', 'core.manchester', 'core.framer']) {
    parent = (await e.addNode({ parent, op, at: 0.05, selection: { f0: 433_870_000, f1: 433_970_000 } })).id;
    ids.push(parent);
  }
  await e.setParam(parent, 'syncHex', '2dd4');
  const a = new Assistant({ engine: e, read: async (id, opts) => e.frame(id, opts) });
  return { e, a, framer: ids[2] };
}

test('describe_session lists every step, with the evidence for what was derived', async () => {
  const { a, framer } = await manchester();
  const d = await a.run('describe_session', {});
  assert.equal(d.capture.centerHz, 433_920_000);
  assert.deepEqual(d.steps.map((s) => s.op), ['core.source', 'core.am_envelope', 'core.manchester', 'core.framer']);
  const f = d.steps.find((s) => s.id === framer);
  assert.equal(f.params.syncHex, '2dd4');
  assert.ok('derived' in f.params.crc, 'an auto parameter carries where it came from');
});

test('read_records returns the framer\'s frames and its CRC verdict', async () => {
  const { a, framer } = await manchester();
  const r = await a.run('read_records', { node_id: framer });
  assert.equal(r.count, 9);
  assert.match(r.summary, /9 of 9 pass CRC-16\/CCITT-FALSE/);
  assert.equal(r.records[0].text, '54 45 4d 50 32 31');
});

test('compare_frames says which bits change, per length group', async () => {
  const { a, framer } = await manchester();
  const c = await a.run('compare_frames', { node_id: framer });
  assert.equal(c.total_frames, 9);
  assert.deepEqual(c.groups.map((g) => [g.frames, g.bits]), [[6, 64], [3, 56]]);
  const g = c.groups[0];
  assert.equal(g.crc, '6 of 6 pass');
  assert.equal(g.runs[0].state, 'fixed');
  assert.equal(g.runs[0].hex_if_byte_aligned, undefined, 'the fixed run is not a whole number of bytes here');
  assert.ok(g.runs.some((r) => r.state === 'changes'));
  const f = (await a.run('compare_frames', { node_id: framer, from_bit: 40, to_bit: 48 })).field;
  assert.deepEqual(f.values_hex.slice(0, 2), ['31', '33']);
});

test('spectrum_peaks finds the transmitter, and refuses a stream that is not IQ', async () => {
  const { a, e } = await manchester();
  const p = await a.run('spectrum_peaks', { at_s: 0.3, span_s: 0.6 });
  assert.ok(p.peaks.length >= 1, JSON.stringify(p));
  assert.ok(Math.abs(p.peaks[0].hz - 433_920_000) < 20_000, `strongest at ${p.peaks[0].hz}`);
  const demod = e._snapshot().nodes[1].id;
  await assert.rejects(() => a.run('spectrum_peaks', { node_id: demod }), /not IQ/);
});

test('findPeaks puts a peak at its bin\'s frequency and ignores the floor', () => {
  const db = new Array(1024).fill(-80);
  for (let i = 700; i < 705; i++) db[i] = -40;
  const r = findPeaks(db, 100e6, 1.024e6);
  assert.equal(r.floor_db, -80);
  assert.equal(r.peaks.length, 1);
  assert.equal(r.peaks[0].hz, Math.round(100e6 + (700.5 - 512) * 1000));
  assert.equal(r.peaks[0].width_hz, 5000);
});

/** A model that answers from a script, and remembers what it was sent. */
function scripted(...turns) {
  const sent = [];
  return {
    sent,
    beta: { messages: { create: async (req) => {
      sent.push(structuredClone(req));
      const t = turns.shift();
      if (t instanceof Error) throw t;
      return t;
    } } },
  };
}
const usage = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

test('a question runs the tools the model asks for and returns its answer', async () => {
  const { e } = await manchester();
  const client = scripted(
    { stop_reason: 'tool_use', model: 'claude-opus-5-5', usage,
      content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'describe_session', input: {} }] },
    { stop_reason: 'end_turn', model: 'claude-opus-5-5', usage,
      content: [{ type: 'text', text: 'Manchester at 500 µs.' }] },
  );
  const a = new Assistant({ engine: e, read: async () => null, client });
  const steps = [];
  const r = await a.ask('what is this?', { focus: { nodeId: e.root.id, at: 0.2 }, onStep: (s) => steps.push(s.tool) });

  assert.equal(r.text, 'Manchester at 500 µs.');
  assert.deepEqual(steps, ['describe_session']);
  // The second request carries the tool's result, answering the call by its id.
  const second = client.sent[1].messages;
  assert.equal(second.at(-1).role, 'user');
  assert.equal(second.at(-1).content[0].tool_use_id, 't1');
  assert.match(second.at(-1).content[0].content, /core\.framer/);
  // What was on screen went with the question.
  assert.match(client.sent[0].messages[0].content, new RegExp(`On screen: step ${e.root.id} .*Playhead: 0\\.20 s\\.\\n\\nwhat is this\\?`, "s"));
  // Two calls of 1000 in, 100 out at $4 and $20 per million.
  assert.ok(Math.abs(r.usd - 2 * (0.004 + 0.002)) < 1e-9, `cost ${r.usd}`);
  assert.equal(client.sent[0].fallbacks, 'default');
});

test('a tool that fails is reported to the model, not thrown', async () => {
  const { e } = await manchester();
  const client = scripted(
    { stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id: 't1', name: 'read_records', input: { node_id: 'nope' } }] },
    { stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'ok' }] },
  );
  await new Assistant({ engine: e, read: async () => null, client }).ask('x');
  const res = client.sent[1].messages.at(-1).content[0];
  assert.equal(res.is_error, true);
  assert.match(res.content, /no step nope/);
});

test('a declined question says so, and the conversation carries on', async () => {
  const { e } = await manchester();
  const client = scripted(
    { stop_reason: 'refusal', usage, content: [] },
    { stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'second' }] },
  );
  const a = new Assistant({ engine: e, read: async () => null, client });
  assert.match((await a.ask('one')).text, /declined/);
  assert.equal((await a.ask('two')).text, 'second');
});

test('a question that runs past the spend limit stops, and leaves the history valid', async () => {
  const { e } = await manchester();
  const big = { ...usage, input_tokens: 200_000 };   // $0.80 at $4 per million
  const client = scripted(
    { stop_reason: 'tool_use', usage: big, content: [{ type: 'tool_use', id: 't1', name: 'describe_session', input: {} }] },
  );
  const a = new Assistant({ engine: e, read: async () => null, client });
  const r = await a.ask('expensive');
  assert.match(r.text, /passed the \$0\.50 limit/);
  const last = a.messages.at(-1);
  assert.equal(last.content[0].tool_use_id, 't1', 'every tool call has an answer');
});

test('a rejected key is said in plain words, and the question leaves no trace', async () => {
  const { e } = await manchester();
  const bad = Object.assign(new Error('401 {"type":"error","error":{"type":"authentication_error"}}'), { status: 401 });
  const client = scripted(bad, { stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'fine now' }] });
  const a = new Assistant({ engine: e, read: async () => null, client });
  await assert.rejects(a.ask('one'), /API key was rejected\. It may have expired/);
  assert.equal((await a.ask('two')).text, 'fine now');
  assert.equal(client.sent[1].messages.length, 1, 'the failed question is not resent');
});
