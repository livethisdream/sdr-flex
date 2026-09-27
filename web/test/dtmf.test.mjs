// The touch-tone digits, and the first plugin that reads samples rather than bytes.
//
//   node --test web/test/dtmf.test.mjs
//
// Two things are under test and they are worth keeping apart. One is the decoder: does
// it read the sixteen digits, and does it decline to read them out of things that are
// not digits — which is the half that matters, because a tone detector that fires on
// speech is worse than none. The other is the *path*: a plugin declaring `in: 'real'`
// could not run at all until recently, whatever its manifest said, and a manifest that
// is honored only sometimes is the bug this exists to pin down.

import test from 'node:test';
import assert from 'node:assert/strict';
import { decode, manifest } from '../plugins/dtmf.js';
import * as plugins from '../src/plugins.js';
import { MockEngine } from '../src/engine.js';
import { Capture } from '../src/capture.js';

const RATE = 48_000;
const LOW = { 1: 697, 2: 697, 3: 697, A: 697, 4: 770, 5: 770, 6: 770, B: 770,
              7: 852, 8: 852, 9: 852, C: 852, '*': 941, 0: 941, '#': 941, D: 941 };
const HIGH = { 1: 1209, 4: 1209, 7: 1209, '*': 1209, 2: 1336, 5: 1336, 8: 1336, 0: 1336,
               3: 1477, 6: 1477, 9: 1477, '#': 1477, A: 1633, B: 1633, C: 1633, D: 1633 };

const rng = (seed) => { let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5); };

/** Digits as a transmitter would send them: tone, gap, tone. */
function tones(digits, { rate = RATE, toneMs = 80, gapMs = 60, noiseDb = null, seed = 7 } = {}) {
  const tn = Math.round((rate * toneMs) / 1000), gn = Math.round((rate * gapMs) / 1000);
  const x = new Float32Array(digits.length * (tn + gn) + gn);
  let w = gn;
  for (const d of digits) {
    for (let i = 0; i < tn; i++) {
      x[w + i] = 0.5 * Math.sin((2 * Math.PI * LOW[d] * i) / rate)
               + 0.5 * Math.sin((2 * Math.PI * HIGH[d] * i) / rate);
    }
    w += tn + gn;
  }
  if (noiseDb != null) {
    const rand = rng(seed), amp = 10 ** (-noiseDb / 20);
    for (let i = 0; i < x.length; i++) x[i] += rand() * 2 * amp;
  }
  return x;
}

const read = (x, params = {}, rate = RATE) =>
  decode(x, params, { sampleRate: rate, count: x.length, t0: 0 }).map((r) => r.text).join('');

// ── the digits ──────────────────────────────────────────────────────────────

test('all sixteen come back', () => {
  // A and D are the ones a half-built keypad table drops: the 1633 Hz column is not on
  // a telephone and is the column a radio actually uses.
  assert.equal(read(tones('0123456789')), '0123456789');
  assert.equal(read(tones('*#ABCD')), '*#ABCD');
});

test('it works at whatever rate it is handed, because it is told', () => {
  // The whole point of the third argument. A decoder that assumed 8 kHz and was handed
  // 48 would report every digit as a different one — a broken keypad rather than a
  // missing number.
  for (const rate of [8000, 22_050, 44_100, 48_000]) {
    assert.equal(read(tones('19*D', { rate }), {}, rate), '19*D', `at ${rate}`);
  }
});

test('with no rate it says so rather than guessing one', () => {
  const out = decode(new Float32Array(4096), {}, {});
  assert.equal(out.length, 1);
  assert.match(out[0].text, /sample rate/);
});

// ── and the things that are not digits ──────────────────────────────────────

test('noise is not a keypress', () => {
  const rand = rng(0x51), x = new Float32Array(RATE);
  for (let i = 0; i < x.length; i++) x[i] = rand();
  assert.equal(read(x), '', 'a second of noise');
});

test('one tone is not a keypress, because a digit is two', () => {
  const x = new Float32Array(RATE / 2);
  for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * 697 * i) / RATE);
  assert.equal(read(x), '');
});

test('a sweep through the whole band is not a keypad being played', () => {
  // The failure this guards is the one that makes a tone decoder useless: firing on
  // speech, music, or anything else that passes through the eight frequencies.
  const x = new Float32Array(RATE);
  for (let i = 0; i < x.length; i++) {
    const f = 200 + (1400 * i) / x.length;
    x[i] = Math.sin((2 * Math.PI * f * i) / RATE);
  }
  assert.equal(read(x), '');
});

test('silence produces nothing, including the digital kind', () => {
  assert.equal(read(new Float32Array(RATE)), '');
});

// ── the edges that were measured rather than assumed ────────────────────────

test('a tone too short to be a keypress is not one', () => {
  assert.equal(read(tones('7', { toneMs: 12 })), '');
  assert.equal(read(tones('7', { toneMs: 24 })), '');
});

test('the shortest tone the standard requires is accepted', () => {
  // ITU-T Q.24: a receiver must accept 40 ms. A tone is only seen on a 12 ms grid, so
  // one that truly lasts 40 ms measures as 36 or 48 depending on where it starts —
  // requiring the larger count would reject a legal tone on alignment alone.
  assert.equal(read(tones('7', { toneMs: 40 })), '7');
  assert.equal(read(tones('7', { toneMs: 48 })), '7');
});

test('a longer floor rejects what a shorter one accepts', () => {
  assert.equal(read(tones('7', { toneMs: 48 }), { minMs: 100 }), '');
  assert.equal(read(tones('7', { toneMs: 48 }), { minMs: 20 }), '7');
});

test('it survives noise well past the point the ear does', () => {
  // Eight narrow filters over a 12 ms block is about 25 dB of processing gain against
  // wideband noise, so this is unsurprising rather than impressive — but it is measured
  // rather than hoped, and it is the number to argue with if it ever regresses.
  for (const db of [10, 3, 0, -6, -12]) {
    assert.equal(read(tones('0123456789', { noiseDb: db })), '0123456789', `${db} dB`);
  }
});

test('each digit says when it was and how long it lasted', () => {
  const x = tones('12', { toneMs: 100, gapMs: 100 });
  const out = decode(x, {}, { sampleRate: RATE, count: x.length, t0: 5 });
  assert.deepEqual(out.map((r) => r.text), ['1', '2']);
  // Both quantized to the 12 ms block, and offset from the span's own start rather than
  // from zero — a record that says 0.1 s about a span beginning at 5 s is a record that
  // points at the wrong place in the capture.
  assert.ok(Math.abs(out[0].t - 5.1) < 0.013, `${out[0].t}`);
  assert.ok(Math.abs(out[1].t - 5.3) < 0.013, `${out[1].t}`);
  for (const r of out) assert.ok(Math.abs(r.ms - 100) <= 12, `${r.ms} ms`);
});

// ── through the plugin boundary, which is the part that was broken ──────────

test('the manifest declares audio in and records out', () => {
  assert.equal(manifest.in, 'real');
  assert.equal(manifest.out, 'events');
});

test('it runs through the plugin runner, which passes the rate along', async () => {
  await plugins.loadSource(
    (await import('node:fs')).readFileSync(new URL('../plugins/dtmf.js', import.meta.url), 'utf8'),
    'dtmf.js');
  const x = tones('42');
  const out = plugins.run('ext.dtmf', x, {}, { kind: 'real', sampleRate: RATE, count: x.length });
  assert.equal(out.error, undefined);
  assert.deepEqual(out.records.map((r) => r.text), ['4', '2']);
});

test('without the third argument it cannot work, and says which', () => {
  // Proof that the rate is genuinely arriving through `run` rather than being defaulted
  // somewhere: take it away and the decoder complains about exactly that.
  const out = plugins.run('ext.dtmf', tones('4'), {}, null);
  assert.match(out.records[0].text, /sample rate/);
});

// ── and on a real graph ─────────────────────────────────────────────────────

test('a real-reading plugin builds a node and decodes, where it used to say “no bytes”', async () => {
  // The bug in one test. `runPlugin` fetched bytes whatever the manifest said, so this
  // node was offered by the palette, built without complaint, and then reported
  // "nothing upstream has produced bytes yet" — about a decoder that never wanted any.
  const digits = '5150';
  const audio = tones(digits, { toneMs: 90, gapMs: 70 });

  // An AM carrier with the tones on it, so the graph reaches `real` the way it would
  // from a capture rather than by being handed a float array.
  //
  // `cu8` is unsigned around 127.5, and getting that wrong is not a scaling error: an
  // envelope encoded as though zero were byte zero comes back centred on zero, and the
  // detector rectifies it — every tone doubles in frequency and nothing decodes. Written
  // out rather than folded into a constant, because it was wrong here first.
  const toByte = (v) => Math.max(0, Math.min(255, Math.round(v * 127.5 + 127.5)));
  const bytes = Buffer.alloc(audio.length * 2);
  for (let i = 0; i < audio.length; i++) {
    bytes[i * 2] = toByte(0.5 + 0.45 * audio[i]);     // a carrier with the tones on it
    bytes[i * 2 + 1] = toByte(0);                     // real-valued, so no quadrature
  }

  const e = new MockEngine({ latency: false });
  await e.createSession();
  await e.openCapture(new Capture({
    buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    format: 'cu8', sampleRate: RATE, centerHz: 100e6, label: 'dtmf',
  }));

  const am = await e.addNode({ parent: e.root.id, op: 'core.am_envelope', at: 0.05 });
  assert.equal(am.out.kind, 'real');
  const d = await e.addNode({ parent: am.id, op: 'ext.dtmf', at: 0.05 });
  assert.equal(d.out.kind, 'events');

  const out = await e.runRecords(d.id, 0.05);
  assert.equal(out.error, undefined, out.error);
  assert.equal(out.records.map((r) => r.text).join(''), digits);
});

test('Identify plans and runs it on an audio node, with no box behind it', async () => {
  // Both halves of the week's work in one place: a plugin planned for the kind it
  // declares, and fed what that kind means. The engine here has no adapters at all, so
  // everything below is the tab on its own — which is the hosted case.
  const { plan, runPlugins } = await import('../src/identify.js');
  const digits = '911';
  const audio = tones(digits, { toneMs: 90, gapMs: 70 });
  const toByte = (v) => Math.max(0, Math.min(255, Math.round(v * 127.5 + 127.5)));
  const bytes = Buffer.alloc(audio.length * 2);
  for (let i = 0; i < audio.length; i++) {
    bytes[i * 2] = toByte(0.5 + 0.45 * audio[i]);
    bytes[i * 2 + 1] = toByte(0);
  }
  const e = new MockEngine({ latency: false });
  await e.createSession();
  await e.openCapture(new Capture({
    buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    format: 'cu8', sampleRate: RATE, centerHz: 100e6, label: 'dtmf',
  }));
  const am = await e.addNode({ parent: e.root.id, op: 'core.am_envelope', at: 0.05 });

  const p = plan([], { kind: 'real', sampleRate: RATE, plugins: plugins.loaded() });
  const mine = p.tried.filter((c) => c.id === 'ext.dtmf');
  assert.equal(mine.length, 1, 'planned on an audio node, which it never was before');

  const win = e.identifyWindow(am.id, e.effectiveTime(am.id));
  const feed = await e.pluginFeed(am.id, null, win);
  assert.equal(feed.info.kind, 'real');
  const rows = runPlugins(mine, feed, plugins.run);
  assert.equal(rows[0].error, undefined);
  assert.equal(rows[0].sample.join(''), digits);
  assert.equal(rows[0].thin, false);
});

test('Identify reads only the window it reports, not the whole capture', async () => {
  // A plugin runs synchronously in the tab. Handed a hundred seconds of audio it would
  // lock the window while it worked, and the report would be claiming something about a
  // span it never looked at either way.
  const e = new MockEngine({ latency: false });
  await e.createSession();
  const am = await e.addNode({ parent: e.root.id, op: 'core.am_envelope', at: 0.05 });
  const whole = await e.pluginFeed(am.id, 0.05);
  const windowed = await e.pluginFeed(am.id, 0.05, { t0: 0, t1: 0.02 });
  assert.ok(windowed.info.count < whole.info.count,
            `${windowed.info.count} against ${whole.info.count}`);
  assert.equal(windowed.info.t0, 0);
  assert.equal(windowed.info.t1, 0.02);
});

test('the feed is chosen by the parent’s kind, not assumed', async () => {
  // `pluginFeed` is the whole of the fix, so it is asserted directly: audio comes back
  // as samples with a rate, and a byte stream comes back as bytes.
  const e = new MockEngine({ latency: false });
  await e.createSession();
  const am = await e.addNode({ parent: e.root.id, op: 'core.am_envelope', at: 0.05 });
  const feed = await e.pluginFeed(am.id, 0.05);
  assert.equal(feed.info.kind, 'real');
  assert.equal(feed.info.sampleRate, e.node(am.id).out.sampleRate);
  assert.ok(feed.data.length > 0);
  assert.ok(feed.info.count > 0);
});
