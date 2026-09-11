// `Identify` — the auto mode of choosing a decoder (ADR-0017).
//
// Two halves, tested separately because they fail differently. The *plan* is pure: given
// a stream and a table of adapters, which could read it and why not the rest. It needs no
// subprocess and no capture, so it is tested exhaustively. The *run* needs real decoders
// and real signal, so it goes through the fixtures and skips where a program is absent.
//
// The thing worth protecting here is the report's honesty. A speculative pass across
// every decoder at once produces false positives — a modem locks onto anything, a Morse
// demodulator reads a noise blip as "E" — and a report that ranks those alongside two
// decoded APRS frames is worse than one that found nothing, because it sends you
// somewhere. Half these tests are about what `Identify` refuses to claim.
//
//   node --test web/test/identify.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockEngine, demodsFor } from '../src/engine.js';
import { Capture } from '../src/capture.js';
import { plan, settings, RATE_HEADROOM } from '../src/identify.js';
import * as adapters from '../../server/adapters.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');
const DEMODS = demodsFor('iq');

// A table that does not depend on what happens to be installed on this machine.
const TABLE = [
  { id: 'a.iq', name: 'iqdec', in: 'iq', out: 'events', wants: { format: 'cu8', rate: 250_000 },
    available: true, command: 'iqdec', params: [{ id: 'mode', default: 'one' }] },
  { id: 'a.audio', name: 'audiodec', in: 'real', out: 'events', wants: { format: 's16', rate: 22_050 },
    available: true, command: 'audiodec', params: [], sweep: { modes: 'ALL OF THEM' } },
  { id: 'a.greedy', name: 'greedy', in: 'iq', out: 'events', wants: { format: 'cu8', rate: 2_400_000 },
    available: true, command: 'greedy', params: [] },
  { id: 'a.absent', name: 'absent', in: 'iq', out: 'events', wants: { format: 'cu8', rate: 250_000 },
    available: false, command: 'absent-a / absent-b', params: [] },
];

const by = (rows, id, via = null) => rows.find((r) => r.id === id && (r.via || null) === via);

// ── the plan ────────────────────────────────────────────────────────────────

test('an adapter that takes this stream directly is tried', () => {
  const { tried } = plan(TABLE, { kind: 'iq', sampleRate: 250_000, demods: DEMODS });
  assert.ok(by(tried, 'a.iq'), 'the iq decoder is tried on iq');
  assert.equal(by(tried, 'a.iq').viaLabel, null, 'with nothing in front of it');
});

test('an audio decoder on IQ is tried behind each demodulator', () => {
  const { tried } = plan(TABLE, { kind: 'iq', sampleRate: 250_000, demods: DEMODS });
  const vias = tried.filter((r) => r.id === 'a.audio').map((r) => r.via);
  assert.deepEqual(vias.sort(), ['core.am_envelope', 'core.fm_discriminator'],
                   'both demodulators, because which one is right is the question');
});

test('on audio there is nothing to demodulate, so only audio decoders are tried', () => {
  const { tried, skipped } = plan(TABLE, { kind: 'real', sampleRate: 48_000, demods: [] });
  assert.deepEqual(tried.map((r) => r.id), ['a.audio']);
  assert.match(by(skipped, 'a.iq').why, /takes iq, and this is audio/);
});

test('a decoder that wants bandwidth the capture never had is skipped, with the arithmetic', () => {
  const { tried, skipped } = plan(TABLE, { kind: 'iq', sampleRate: 96_000, demods: DEMODS });
  assert.ok(!by(tried, 'a.greedy'), 'not tried');
  assert.match(by(skipped, 'a.greedy').why, /wants 2\.40 MS\/s and this stream is 96 kS\/s/);
  assert.match(by(skipped, 'a.greedy').why, /25×/, 'and says how far off it is');
});

test('the headroom is a threshold, not a ban on resampling up', () => {
  const under = plan(TABLE, { kind: 'iq', sampleRate: 2_400_000 / RATE_HEADROOM, demods: DEMODS });
  assert.ok(by(under.tried, 'a.greedy'), 'exactly at the headroom it is still tried');
  const over = plan(TABLE, { kind: 'iq', sampleRate: 2_400_000 / RATE_HEADROOM - 1, demods: DEMODS });
  assert.ok(!by(over.tried, 'a.greedy'), 'a hair past it, it is not');
});

test('a decoder that is not installed is named, not dropped', () => {
  const { tried, skipped } = plan(TABLE, { kind: 'iq', sampleRate: 250_000, demods: DEMODS });
  assert.ok(!by(tried, 'a.absent'));
  assert.match(by(skipped, 'a.absent').why, /absent-a \/ absent-b is not installed/,
               'and every name it might have gone by is named');
});

test('nothing is dropped silently — every adapter is in one list or the other', () => {
  for (const [kind, rate] of [['iq', 250_000], ['iq', 10_000], ['real', 48_000], ['bytes', 1000]]) {
    const { tried, skipped } = plan(TABLE, { kind, sampleRate: rate, demods: demodsFor(kind) });
    const seen = new Set([...tried, ...skipped].map((r) => r.id));
    assert.equal(seen.size, TABLE.length, `${kind} at ${rate}: ${seen.size} of ${TABLE.length} accounted for`);
    for (const s of skipped) assert.ok(s.why && s.why.length > 10, `${s.id} has a reason worth reading`);
  }
});

test('a candidate carries the settings it will run with', () => {
  const { tried } = plan(TABLE, { kind: 'iq', sampleRate: 250_000, demods: DEMODS });
  assert.deepEqual(by(tried, 'a.iq').params, { mode: 'one' }, 'an adapter\'s own defaults');
  // Running with no parameters at all asks every adapter for its least capable
  // configuration — which is how multimon-ng came to be asked for three POCSAG rates
  // and nothing else on a signal that was AX.25.
  assert.deepEqual(settings(TABLE[1]), { modes: 'ALL OF THEM' },
                   'and whatever "try everything" means for it, which only it knows');
});

test('the shipped table says what "try everything" means where it matters', () => {
  const mm = adapters.list().find((a) => a.id === 'ext.multimon');
  assert.match(mm.sweep.modes, /AFSK1200/, 'AX.25 is not in the default mode list');
  assert.match(mm.sweep.modes, /MORSE_CW/);
  assert.match(mm.sweep.modes, /DTMF/);
});

// ── the window ──────────────────────────────────────────────────────────────

const FS = 100_000;
function ramped(seconds) {
  const n = Math.round(FS * seconds);
  const buf = Buffer.alloc(n * 2, 127);
  return new Capture({ buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
                       format: 'cu8', sampleRate: FS, centerHz: 0, label: 'flat' });
}
async function opened(seconds) {
  const e = new MockEngine({ latency: false });
  await e.createSession();
  await e.openCapture(ramped(seconds));
  return e;
}

test('a short capture is identified whole', async () => {
  const e = await opened(2);
  assert.deepEqual(e.identifyWindow(e.root.id, 0.1), { t0: 0, t1: 2, pinned: false });
});

test('a long capture is identified eight seconds at a time, ending at the playhead', async () => {
  const e = await opened(100);
  // Eight decoders over a hundred seconds is minutes of waiting for an answer the
  // first eight seconds would have given.
  assert.deepEqual(e.identifyWindow(e.root.id, 0.1), { t0: 0, t1: 8, pinned: false });
  assert.deepEqual(e.identifyWindow(e.root.id, 50), { t0: 42, t1: 50, pinned: false });
  assert.deepEqual(e.identifyWindow(e.root.id, 99), { t0: 91, t1: 99, pinned: false },
                   'the window ends at the playhead, not at the end of the file');
  assert.deepEqual(e.identifyWindow(e.root.id, 200), { t0: 92, t1: 100, pinned: false },
                   'and a playhead past the end does not run off it');
});

test('a pinned clip is the question, so it wins outright', async () => {
  const e = await opened(100);
  const t = await e.addNode({ parent: e.root.id, op: 'core.tuner', at: 1,
                              selection: { f0: -20_000, f1: 20_000, t0: 61, t1: 93 } });
  const w = e.identifyWindow(t.id, 1);
  assert.equal(w.pinned, true);
  assert.equal(w.t0, 61);
  assert.equal(w.t1, 93, 'even though that is longer than the default window');
});

// ── the run, against the fixtures ───────────────────────────────────────────

const SIGMF = { cf32_le: 'cf32', ci16_le: 'cs16', cu8: 'cu8', ci8: 'cs8' };
function fixture(name) {
  const dir = path.join(FIXTURES, name);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'capture.sigmf-meta'), 'utf8'));
  const buf = fs.readFileSync(path.join(dir, 'capture.sigmf-data'));
  return new Capture({
    buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    format: SIGMF[meta.global['core:datatype']] || 'cu8',
    sampleRate: meta.global['core:sample_rate'],
    centerHz: (meta.captures[0] || {})['core:frequency'] || 0,
    label: name,
  });
}

/** An engine with the adapter table wired in the way the server wires it. */
async function engineOn(name) {
  const e = new MockEngine({ latency: false });
  e.adapters = adapters.list();
  e.adapter = (id) => (adapters.ADAPTERS[id] ? { id, ...adapters.ADAPTERS[id] } : null);
  e.runAdapterData = (a) => adapters.run(a.adapter, a);
  await e.createSession();
  await e.openCapture(fixture(name));
  return e;
}

const have = (id) => adapters.available(id);
const hit = (r, id, via = null) => r.results.find((x) => x.id === id && (x.via || null) === via);

test('an engine with no decoders on the box says so', async () => {
  const e = new MockEngine({ latency: false });
  await e.createSession();
  await e.openCapture(fixture('adsb-modes'));
  const r = await e.identify(e.root.id);
  assert.match(r.error, /no engine on a box/);
  assert.deepEqual(r.results, [], 'rather than an empty report, which reads as "nothing matched"');
});

test('there is nothing to identify on a stream of records', async () => {
  const e = await engineOn('adsb-modes');
  const n = await e.addNode({ parent: e.root.id, op: 'ext.rtl433', at: 0.0005 });
  const r = await e.identify(n.id);
  assert.match(r.error, /events stream/);
});

test('Mode S: dump1090 straight off the spectrum', async (t) => {
  if (!have('ext.dump1090')) { t.skip('dump1090 is not installed on this machine'); return; }
  const e = await engineOn('adsb-modes');
  const r = await e.identify(e.root.id, { at: 0.0005 });
  const d = hit(r, 'ext.dump1090');
  assert.equal(d.records, 2, `dump1090 found ${d.records}`);
  assert.equal(d.thin, false);
  assert.equal(r.results[0].id, 'ext.dump1090', 'and it is the top row');
  assert.match(d.sample[0], /^8d4840d6/);
});

test('AX.25 over FM: both packet decoders, behind the right demodulator', async (t) => {
  if (!have('ext.direwolf') || !have('ext.multimon')) { t.skip('direwolf or multimon-ng is missing'); return; }
  const e = await engineOn('aprs-afsk1200');
  const tuner = await e.addNode({ parent: e.root.id, op: 'core.tuner', at: 0.05,
                                  selection: { f0: 144_382_000, f1: 144_398_000 } });
  const r = await e.identify(tuner.id, { at: 0.05 });

  const dw = hit(r, 'ext.direwolf', 'core.fm_discriminator');
  assert.equal(dw.records, 2, `direwolf behind FM found ${dw.records}`);
  assert.match(dw.sample.join(' '), /sdrflex-ax25-over-fm/);
  assert.ok(hit(r, 'ext.multimon', 'core.fm_discriminator').records >= 2, 'and so did multimon-ng');

  // The same decoder behind the wrong demodulator is the control: if AM found this too,
  // the report would not be telling anybody anything.
  assert.equal(hit(r, 'ext.direwolf', 'core.am_envelope').records, 0);

  assert.deepEqual(r.results.slice(0, 2).map((x) => x.via),
                   ['core.fm_discriminator', 'core.fm_discriminator'], 'what worked is on top');
  // The row has to be reproducible by clicking it, which means carrying the settings
  // that produced it rather than the adapter's cheap defaults.
  assert.match(hit(r, 'ext.multimon', 'core.fm_discriminator').params.modes, /AFSK1200/);
});

test('a decoder that recognized nothing still says what it measured', async (t) => {
  if (!have('ext.rtl433')) { t.skip('rtl_433 is not installed on this machine'); return; }
  const e = await engineOn('rtl433-ook-pwm');
  const r = await e.identify(e.root.id, { at: 0.05 });
  const rtl = hit(r, 'ext.rtl433');
  assert.equal(rtl.records, 0, 'the fixture is a made-up protocol, so nothing should name it');
  assert.ok(rtl.explained && /pulses at/.test(rtl.explained.measured),
            `no measurement came back: ${JSON.stringify(rtl.explained)}`);
  assert.ok(rtl.explained.suggestion.includes('m=OOK'), 'and a decoder line to try');
});

test('a modem that locked onto something that is not text says which', async (t) => {
  if (!have('ext.minimodem')) { t.skip('minimodem is not installed on this machine'); return; }
  const e = await engineOn('rtl433-ook-pwm');
  const r = await e.identify(e.root.id, { at: 0.05 });
  const mm = r.results.filter((x) => x.id === 'ext.minimodem');
  assert.ok(mm.length, 'minimodem was tried');
  assert.ok(mm.every((x) => x.records === 0), 'and reported nothing, because bytes are not a message');
  assert.ok(mm.some((x) => /not text/.test(x.rejected || '')),
            'and said it had locked on rather than saying nothing at all');
});

test('a single symbol out of noise is not a decode', async (t) => {
  if (!have('ext.multimon')) { t.skip('multimon-ng is not installed on this machine'); return; }
  // Told to try everything, multimon-ng's Morse demodulator reads a noise blip in this
  // OOK capture as "E" — one dit. Ranking that alongside a real decode, and reporting
  // "1 decoder read something here", is worse than finding nothing.
  const e = await engineOn('manchester-crc');
  const r = await e.identify(e.root.id, { at: 0.05 });
  const thin = r.results.filter((x) => x.thin);
  for (const x of thin) {
    assert.ok(x.records > 0, 'a thin row did decode something');
    assert.ok(r.results.indexOf(x) > r.results.filter((y) => y.records && !y.thin).length - 1,
              'and it sorts below anything solid');
  }
  const solid = r.results.filter((x) => x.records > 0 && !x.thin);
  assert.equal(solid.length, 0, `nothing should read this capture: ${solid.map((x) => x.name)}`);
});

test('the report says what it looked at', async (t) => {
  if (!have('ext.rtl433')) { t.skip('rtl_433 is not installed on this machine'); return; }
  const e = await engineOn('rtl433-ook-pwm');
  const r = await e.identify(e.root.id, { at: 0.05 });
  assert.equal(r.kind, 'iq');
  assert.equal(r.sampleRate, 250_000);
  assert.ok(Math.abs(r.windowS - (r.t1 - r.t0)) < 1e-9);
  // "nothing in these eight seconds" and "nothing in this capture" are different claims.
  assert.ok(r.windowS > 0 && r.windowS <= 8.0001, `window was ${r.windowS} s`);
});

test('results arrive as they land, not all at the end', async (t) => {
  if (!have('ext.rtl433')) { t.skip('rtl_433 is not installed on this machine'); return; }
  const e = await engineOn('rtl433-ook-pwm');
  const seen = [];
  const r = await e.identify(e.root.id, { at: 0.05, onResult: (row) => seen.push(row) });
  assert.equal(seen.length, r.results.length, 'every result was announced');
  assert.ok(seen.every((row) => row.id && row.name), 'and each one identifies itself');
  // The panel keys rows on the pair, because the same decoder appears behind two
  // demodulators and the two are different answers.
  assert.equal(new Set(seen.map((row) => `${row.id}|${row.via || ''}`)).size, seen.length);
});
