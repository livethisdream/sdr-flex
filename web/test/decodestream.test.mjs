// A decoder fed as the capture plays (adapters.DecoderStream, session `decodeTo`).
//
//   node --test web/test/decodestream.test.mjs
//
// Runs where multimon-ng and GNU Radio are installed, which is the image `Dockerfile.full`
// builds. The known answer for each is the same decoder given the whole span at once: fed in
// pieces, nothing may be cut, doubled or lost.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as mod from './support/modulate.mjs';
import { ADAPTERS, available, run, DecoderStream } from '../../server/adapters.js';
import { Session, METHODS } from '../../server/session.js';
import { FileCapture } from '../../server/filecapture.js';

const python = process.env.SDRFLEX_GR_PYTHON || 'python3';
const hasGr = spawnSync(python, ['-c', 'import gnuradio.gr'], { stdio: 'ignore' }).status === 0;
const skip = !hasGr ? 'GNU Radio is not installed' : !available('ext.multimon') ? 'multimon-ng is not installed' : false;
const FEED = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'gr', 'feed.py');
const TEXT = 'CQ CQ DE SDRFLEX TEST 73 THE QUICK BROWN FOX 1234';

const words = (s) => s.replace(/\s+/g, ' ').trim();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Feed `data` to a stream in pieces of `piece` samples (pairs, for IQ), then end it. */
async function fedInPieces(stream, data, rate, piece, { iq = false } = {}) {
  const w = iq ? 2 : 1;
  for (let k = 0; k < data.length; k += piece * w) {
    const part = data.subarray(k, Math.min(data.length, k + piece * w));
    await stream.write(part, (k + part.length) / w / rate);
  }
  await stream.end();
  return stream.take();
}

/** Records as a decoder reported them, without when the stream heard them. */
const plain = (records) => records.map(({ at, ...r }) => r);

test('Morse fed in pieces reads the same as Morse read whole', { skip }, async (t) => {
  // At 25 kS/s, so the feed resamples to multimon's 22 050 the way a channel's rate would.
  const rate = 25_000, audio = mod.morse(TEXT, { rate, wpm: 18, toneHz: 700, tailS: 1 });
  const whole = await run('ext.multimon', { data: audio, kind: 'real', sampleRate: rate, params: { modes: 'MORSE_CW' } });
  const s = new DecoderStream('ext.multimon', { kind: 'real', sampleRate: rate, params: { modes: 'MORSE_CW' } });
  t.after(() => s.close());
  // 0.37 s pieces: every one of them ends somewhere in the middle of a character.
  const got = await fedInPieces(s, audio, rate, Math.round(0.37 * rate));
  const streamed = words([...got.records.map((r) => r.text), got.partial].join(' '));
  const once = words(whole.records.map((r) => r.text).join(' '));
  t.diagnostic(`whole: ${once} | streamed: ${streamed}`);
  assert.ok(once.includes('SDRFLEX TEST 73'), `the whole-span decode is the known answer: ${once}`);
  assert.equal(streamed, once);
  for (const r of got.records) assert.ok(r.at > 0 && r.at <= audio.length / rate + 1e-9, `stamped inside the span: ${r.at}`);
});

test('a packet that straddles a feed is reported once, and none is lost', { skip }, async (t) => {
  const rate = 22_050;
  const frames = [1, 2, 3, 4].map((i) => mod.ax25('N0CALL', 'APRS', `>packet ${i} of four`));
  const audio = mod.afsk1200(frames, { rate });
  const whole = await run('ext.multimon', { data: audio, kind: 'real', sampleRate: rate, params: { modes: 'AFSK1200' } });
  const s = new DecoderStream('ext.multimon', { kind: 'real', sampleRate: rate, params: { modes: 'AFSK1200' } });
  t.after(() => s.close());
  // A tenth of a second is shorter than any of these packets, so each is cut by several feeds.
  const got = await fedInPieces(s, audio, rate, Math.round(0.1 * rate));
  const text = (rs) => rs.map((r) => r.text).filter((x) => /packet \d/.test(x));
  t.diagnostic(`whole ${text(whole.records).length}, streamed ${text(got.records).length}`);
  assert.equal(text(whole.records).length, 4, 'the whole-span decode finds all four');
  assert.deepEqual(text(got.records), text(whole.records));
});

test('the feed has no seams: a tone fed in pieces comes out as the tone fed whole', { skip }, async () => {
  const from = 25_000, n = from * 2, x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 700 * i) / from);
  const convert = async (pieces) => {
    const p = spawn(python, [FEED, JSON.stringify({ kind: 'real', from, to: 22_050, format: 's16', gain: 1 })],
                    { stdio: ['pipe', 'ignore', 'ignore', 'pipe'] });
    const out = [];
    p.stdio[3].on('data', (b) => out.push(b));
    const done = new Promise((r) => p.on('close', r));
    for (const [a, b] of pieces) { p.stdin.write(Buffer.from(x.buffer, a * 4, (b - a) * 4)); await wait(20); }
    p.stdin.end();
    await done;
    return Buffer.concat(out);
  };
  const cuts = [0, 1234, 7777, 7778, 20_000, 33_333, n];
  const whole = await convert([[0, n]]);
  const pieces = await convert(cuts.slice(1).map((b, i) => [cuts[i], b]));
  assert.ok(whole.length > 40_000);
  assert.ok(whole.equals(pieces), 'byte for byte');
});

test('a session streams a CW channel, starts again on a seek, and stops with the node', { skip }, async (t) => {
  // A capture whose I channel is Morse at 700 Hz: a CW signal 700 Hz above center.
  const rate = 8_000, audio = mod.morse(`${TEXT} ${TEXT}`, { rate, wpm: 18, toneHz: 700, tailS: 1 });
  const buf = Buffer.alloc(audio.length * 8);
  for (let i = 0; i < audio.length; i++) buf.writeFloatLE(audio[i], i * 8);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decodestream-'));
  const file = path.join(dir, 'cw.cf32');
  fs.writeFileSync(file, buf);
  const session = new Session({ on() {}, send() {} }, { library: null });
  t.after(() => { session.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  const e = session.engine;
  await e.createSession();
  await e.openCapture(new FileCapture({ path: file, format: 'cf32', sampleRate: rate, centerHz: 7_000_000, label: 'cw' }));
  const tu = await e.addNode({ parent: e.root.id, op: 'core.tuner', selection: { f0: 7_000_000, f1: 7_001_400 }, at: 2 });
  const cw = await e.addNode({ parent: tu.id, op: 'core.cw', at: 2 });
  const mm = await e.addNode({ parent: cw.id, op: 'ext.multimon', at: 2 });
  assert.equal(e.node(mm.id).params.modes.value, 'MORSE_CW', 'behind CW it starts on Morse');

  const end = audio.length / rate;
  let text = '', last = null;
  for (let at = 0.5; at <= end + 1e-9; at += 0.5) {
    last = await METHODS.decodeTo.call(session, { nodeId: mm.id, t: Math.min(at, end) });
    assert.equal(last.error, undefined, last.error);
    text += ` ${last.records.map((r) => r.text).join(' ')}`;
  }
  await wait(800);
  last = await METHODS.decodeTo.call(session, { nodeId: mm.id, t: end });
  text = words(`${text} ${last.records.map((r) => r.text).join(' ')} ${last.partial}`);
  t.diagnostic(text);
  assert.equal(last.from, 0, 'one run from the start');
  assert.ok(text.includes('SDRFLEX TEST 73 THE QUICK BROWN FOX'), text);

  const back = await METHODS.decodeTo.call(session, { nodeId: mm.id, t: 3 });
  assert.equal(back.from, 1, 'a seek back starts a new run, two seconds before where the playhead went');

  const proc = session.streams.get(mm.id).stream.proc;
  await METHODS.removeNode.call(session, { id: tu.id });
  assert.equal(session.streams.size, 0, 'removing a node above it stops the stream');
  await wait(200);
  assert.ok(proc.exitCode !== null || proc.signalCode !== null, 'and its process has gone');
});

// ── the other decoders that stream ──────────────────────────────────────────
//
// The same question for each: fed in pieces much shorter than one of its packets, does it
// report exactly what it reports given the whole span? The inputs are the ones
// adapters.test.mjs decodes, so a decoder that streams is held to the answers it gives as a job.

const STREAMED = [
  {
    id: 'ext.rtl433', kind: 'iq', rate: 250_000, piece: 0.004, centerHz: 433_920_000,
    params: { flex: 'n=test,m=OOK_PWM,s=250,l=500,g=750,r=6000' },
    input() {
      const rate = 250_000, us = (x) => Math.round(x * 1e-6 * rate), rand = mod.rng(0x5eed1), out = [];
      const push = (n, amp) => { for (let i = 0; i < n; i++) out.push(amp + (rand() - 0.5) * 0.008, (rand() - 0.5) * 0.008); };
      push(us(10_000), 0);
      for (let rep = 0; rep < 4; rep++) {
        for (const w of [0b101100110011010101100110, 0b110010101010011001011001]) {
          for (let k = 23; k >= 0; k--) { push((w >> k) & 1 ? us(500) : us(250), 0.45); push(us(250), 0); }
          push(us(6000), 0);
        }
      }
      return Float32Array.from(out);
    },
  },
  {
    id: 'ext.dump1090', kind: 'iq', rate: 2_400_000, piece: 0.00005,
    input: () => mod.modeS([mod.adsbIdent(0x4840d6, 'SDRFLEX'), mod.adsbIdent(0xabcdef, 'SDRFLX2')]),
  },
  {
    id: 'ext.direwolf', kind: 'real', rate: 48_000, piece: 0.05,
    input: () => mod.afsk1200([
      mod.ax25('N0CALL', 'APRS', '=4903.50N/07201.75W-sdrflex adapter check'),
      mod.ax25('KC1ABC', 'APRS', 'sdrflex-ax25-round-trip'),
    ], { rate: 48_000 }),
  },
];

test('the decoders that stream say so, and redsea does not', () => {
  for (const d of [...STREAMED, { id: 'ext.multimon' }]) assert.equal(ADAPTERS[d.id].stream, true, d.id);
  // Its parser joins RDS groups across the whole output, which line-at-a-time reading undoes.
  assert.ok(!ADAPTERS['ext.redsea'].stream);
});

for (const d of STREAMED) {
  test(`${d.id} fed in pieces reports what it reports given the whole span`, { skip: !hasGr ? 'GNU Radio is not installed' : !available(d.id) && `${d.id} is not installed` }, async (t) => {
    const data = d.input(), params = d.params || {};
    const whole = await run(d.id, { data, kind: d.kind, sampleRate: d.rate, centerHz: d.centerHz, params });
    assert.equal(whole.error, undefined, whole.error);
    assert.ok(whole.records.length > 0, 'the whole-span decode finds something to compare against');
    const s = new DecoderStream(d.id, { kind: d.kind, sampleRate: d.rate, centerHz: d.centerHz, params });
    t.after(() => s.close());
    const got = await fedInPieces(s, data, d.rate, Math.max(1, Math.round(d.piece * d.rate)), { iq: d.kind === 'iq' });
    t.diagnostic(`${whole.records.length} records whole, ${got.records.length} streamed${got.error ? `; ${got.error}` : ''}`);
    assert.deepEqual(plain(got.records), plain(whole.records));
  });
}

