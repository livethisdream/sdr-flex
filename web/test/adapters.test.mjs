// Do the decoders we shell out to actually decode?
//
// Every one of these adapters was first written from documentation, and every one of
// them was wrong in a way that produced silence rather than an error:
//
//   · dump1090 is installed as `dump1090-mutability` on Debian and `dump1090-fa` from
//     FlightAware. The adapter named only the upstream binary, so it reported "not
//     installed" on the machines that had it.
//   · `--quiet` on dump1090 does not mean "no banner", it means "no stdout" — which is
//     where `--raw` puts the decodes. The shipped arguments asked for output and then
//     turned it off.
//   · `-` is not stdin to direwolf; getopt eats it and the program is left with no file
//     argument. The word is `stdin`.
//   · direwolf opens a sound card unless a config file says otherwise, and exits with
//     "Pointless to continue without audio device" on anything headless — which is
//     every machine this runs on.
//   · `-q hd` on direwolf suppresses exactly the decoded lines we run it for.
//   · minimodem reads through libsndfile, which refuses headerless samples on a pipe.
//
// None of those could be caught by reading the code. So this test hands each adapter a
// signal built by the matching modulator in support/modulate.mjs and asserts the text
// comes back — the adapter's own `run()`, its own format negotiation, its own parser.
// The modulator is the inverse of the decoder, so the check is two-sided: if either
// drifts the other stops agreeing.
//
//   node --test web/test/adapters.test.mjs
//
// A program that is not installed is skipped rather than failed. This is a test of the
// adapters, and a box without direwolf on it has nothing to say about the direwolf
// adapter — but the skip is loud, because a suite that is silently all-skips is worse
// than no suite.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, available, resolve, list, run, convert, multimonDemods, wants as adapterWants } from '../../server/adapters.js';
import * as mod from './support/modulate.mjs';
import { demodulate } from '../src/engine.js';

const AUDIO_RATE = 48_000;                    // what the modulators produce; convert() resamples

/** Ask an adapter for a decode, the way the session does. */
const decode = (id, data, kind, opts = {}) =>
  run(id, { data, kind, sampleRate: opts.sampleRate ?? AUDIO_RATE, timeoutMs: 30_000, ...opts });

const texts = (out) => out.records.map((r) => r.text).join('\n');

function skip(t, id) {
  if (available(id)) return false;
  const names = [].concat(ADAPTERS[id].command).join(' or ');
  t.diagnostic(`skipped: ${names} is not installed on this machine`);
  return true;
}

// ── the table itself ────────────────────────────────────────────────────────

test('every adapter declares what it needs and what it produces', () => {
  for (const [id, a] of Object.entries(ADAPTERS)) {
    assert.ok(a.command, `${id} names a command`);
    assert.ok(['iq', 'real'].includes(a.in), `${id} takes samples`);
    assert.ok(['events', 'bits', 'bytes'].includes(a.out), `${id} produces records`);
    // `wants` may be a function of the parameters — LoRa's rate follows its bandwidth —
    // so it is asked rather than read.
    const w = adapterWants(a, Object.fromEntries((a.params || []).map((p) => [p.id, p.default])));
    assert.ok(w && w.format && w.rate, `${id} says what it wants on stdin`);
    assert.ok(typeof a.args === 'function', `${id} builds its own command line`);
    assert.ok(typeof a.parse === 'function' || ['jsonl', 'lines'].includes(a.parse),
              `${id} knows how to read its own output`);
  }
});

test('a command can be several names, and list() reports the one that is here', () => {
  const rows = list();
  const d = rows.find((r) => r.id === 'ext.dump1090');
  assert.ok(Array.isArray(ADAPTERS['ext.dump1090'].command), 'dump1090 has candidate names');
  if (d.available) {
    assert.ok(ADAPTERS['ext.dump1090'].command.includes(d.command),
              `reports the binary it found: ${d.command}`);
    assert.equal(resolve('ext.dump1090'), d.command);
  } else {
    assert.match(d.command, /\//, 'when none is here it names all the candidates');
  }
});

test('a missing program is an error and not a crash', async () => {
  const out = await run('ext.nothing-like-this', { data: new Float32Array(16), kind: 'real', sampleRate: 48_000 });
  assert.match(out.error, /no adapter/);
  assert.equal(out.records.length, 0);
});

// ── redsea, on the composite rather than on audio ───────────────────────────
//
// The one adapter whose input is not something you could listen to. RDS rides a
// suppressed 57 kHz subcarrier, so what redsea wants is the discriminator's whole
// output — and the failure mode this protects against is the quiet one: hand it a
// channel narrow enough to hear and it decodes nothing, with no error, because the
// subcarrier it is looking for was filtered away three nodes upstream.

const RDS_RATE = 171_000;             // redsea's own internal rate; see the adapter

/**
 * A composite carrying a station that calls itself SDR FLEX.
 *
 * Sixteen groups — two full passes of the four name segments — because one pass is not
 * enough for anything: the first few groups go to finding block boundaries, and a name
 * is then held back until its four segments have arrived twice. Eight groups of this
 * decode to the PI code and nothing else.
 */
const rdsComposite = (opts = {}) =>
  mod.rdsMpx(mod.rdsGroups({ pi: 0x2af1, ps: 'SDR FLEX', radiotext: 'SDR RDS\r',
                             groups: 16, ...opts }),
             { rate: RDS_RATE });

test('redsea reads a station off the composite', async (t) => {
  if (skip(t, 'ext.redsea')) return;
  const out = await decode('ext.redsea', rdsComposite(), 'real', { sampleRate: RDS_RATE });
  assert.equal(out.error, undefined, out.error);
  const all = texts(out);
  assert.match(all, /SDR FLEX/, 'the program service name comes back');
  assert.ok(out.records.some((r) => r.ps === 'SDR FLEX'), 'as a field, not only as text');
  assert.ok(out.records.some((r) => r.radiotext === 'SDR RDS'), 'and so does the radiotext');
  assert.ok(out.records.every((r) => /^0x[0-9A-F]{4}$/.test(r.pi || '')),
            `every record carries the station it came from: ${JSON.stringify(out.records[0])}`);
  assert.equal(out.records[0].pi, '0x2AF1', 'and it is the PI the modulator sent');
});

test('the checkword is the standard one, not one that only agrees with itself', () => {
  // Worth pinning separately from the round trip: a generator polynomial that is wrong
  // in the same way at both ends would pass every decode test there is, and this one is
  // checked against IEC 62106's own worked example rather than against redsea.
  assert.equal(mod.rdsCheckword(0x0000), 0x000, 'an all-zero word has an all-zero checkword');
  // Linearity: the code is cyclic, so the checkword of a XOR b is the XOR of theirs.
  const a = 0x2af1, b = 0x1234;
  assert.equal(mod.rdsCheckword(a ^ b), mod.rdsCheckword(a) ^ mod.rdsCheckword(b));
});

test('a group that repeats what the last one said is not a record', async (t) => {
  if (skip(t, 'ext.redsea')) return;
  // The control, and the one that decides whether this adapter is usable. redsea prints
  // a line per group and a station sends ten a second, nearly all of them repeating the
  // name and the program type the line before already carried. An adapter that turned
  // each into a record would pass every decode test here and bury a real decode under
  // four hundred identical rows on any real signal.
  const out = await decode('ext.redsea', rdsComposite({ groups: 48 }), 'real', { sampleRate: RDS_RATE });
  assert.equal(out.error, undefined, out.error);
  assert.ok(out.records.length <= 8,
            `forty-eight groups should still be a handful of records, ` +
            `got ${out.records.length}: ${JSON.stringify(out.records.map((r) => r.text))}`);
  assert.equal(out.records.filter((r) => r.ps === 'SDR FLEX').length, 1, 'the name is news once');
  assert.equal(out.records.filter((r) => r.radiotext === 'SDR RDS').length, 1, 'and so is the radiotext');
});

test('a name and a radiotext that read alike are still two things said', async (t) => {
  if (skip(t, 'ext.redsea')) return;
  // Most stations put the same string in both for the first few seconds, and a filter
  // that compared only the text dropped whichever arrived second — so the station with
  // the simplest possible metadata was the one the adapter reported half of.
  // More groups than the others need: 'SDR FLEX' plus its terminator is three radiotext
  // segments rather than two, and each of them has to arrive twice.
  const out = await decode('ext.redsea', rdsComposite({ radiotext: 'SDR FLEX\r', groups: 24 }), 'real',
                           { sampleRate: RDS_RATE });
  assert.ok(out.records.some((r) => r.ps === 'SDR FLEX'), 'the name');
  assert.ok(out.records.some((r) => r.radiotext === 'SDR FLEX'), 'and the radiotext');
});

test('partial is off by default and reachable, because a short span is all partials', async (t) => {
  if (skip(t, 'ext.redsea')) return;
  // A name arrives two characters at a time and redsea withholds it until it has seen
  // the same four segments twice, which is right and is useless on a span that is not
  // long enough for two. The knob trades certainty for something rather than nothing,
  // and it shows the gaps rather than filling them.
  const quiet = await decode('ext.redsea', rdsComposite(), 'real', { sampleRate: RDS_RATE });
  assert.ok(!quiet.records.some((r) => r.partialPs), 'no half-names by default');

  const loud = await decode('ext.redsea', rdsComposite(), 'real',
                            { sampleRate: RDS_RATE, params: { partial: 'yes' } });
  const pieces = loud.records.map((r) => r.partialPs).filter(Boolean);
  assert.ok(pieces.length > 1, `the name assembles: ${JSON.stringify(pieces)}`);
  assert.ok(pieces.every((p) => 'SDR FLEX'.startsWith(p.replace(/\s+$/, '').slice(0, 2))),
            `and every piece is part of the name it is building: ${JSON.stringify(pieces)}`);
});

test('an all-spaces partial is not something the station said', async (t) => {
  if (skip(t, 'ext.redsea')) return;
  // redsea pads a partial name to eight characters and radiotext to sixty-four, so the
  // empty one is spaces rather than absent. Read as "it said something" that is a pane
  // of blank rows, which is what the first version of this parser produced.
  const out = await decode('ext.redsea', rdsComposite(), 'real',
                           { sampleRate: RDS_RATE, params: { partial: 'yes' } });
  assert.ok(out.records.every((r) => r.text.trim().length > 0), 'no blank rows');
  assert.ok(out.records.every((r) => !/ $/.test(r.text)), 'and no padding left on the end');
});

test('redsea is told its own rate, and refuses one it cannot use', () => {
  const a = ADAPTERS['ext.redsea'];
  assert.equal(adapterWants(a, {}).rate, 171_000,
               'redsea resamples to 171 kHz internally; feeding it that is one resample, not two');
  assert.ok(adapterWants(a, {}).rate >= 128_000,
            'below 128 kHz the 57 kHz subcarrier is above Nyquist and redsea exits');
  const args = a.args({ rate: 171_000, params: { region: 'rds', partial: 'no' } });
  assert.deepEqual(args.slice(0, 2), ['--input', 'mpx'], 'raw PCM on stdin, not a wave file');
  assert.ok(!args.includes('--rbds'), 'Europe by default');
  assert.ok(ADAPTERS['ext.redsea'].args({ rate: 171_000, params: { region: 'rbds' } }).includes('--rbds'));
});

test('RBDS is a different set of program types and a callsign', async (t) => {
  if (skip(t, 'ext.redsea')) return;
  const out = await decode('ext.redsea', rdsComposite(), 'real',
                           { sampleRate: RDS_RATE, params: { region: 'rbds' } });
  assert.equal(out.error, undefined, out.error);
  // The same PI code, read under the North American rules, is a callsign. Nothing in the
  // signal says which continent it came from, which is exactly why this is a knob.
  assert.ok(out.records.some((r) => /^K[A-Z]{3}$/.test(r.callsign || '')),
            `PI 0x2AF1 translates to a callsign under RBDS: ${JSON.stringify(out.records[0])}`);
});

// ── an adapter that is not a program ────────────────────────────────────────

test('a flowgraph adapter names the module, not the interpreter', () => {
  const a = ADAPTERS['ext.lora'];
  assert.ok(a.module, 'it says which GNU Radio module has to be there');
  assert.ok(a.flowgraph, 'and which of our flowgraphs runs it');
  assert.ok([].concat(a.command).includes('python3.12'),
            'the interpreter is a candidate list: GNU Radio builds its bindings against ' +
            'one CPython and a box can have five');
  const row = list().find((r) => r.id === 'ext.lora');
  assert.match(row.command, /gnuradio\.lora_sdr/,
               'and a box without it is told to install the module, not Python');
});

test('the flowgraph ships with the tool and is on disk', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fg = path.join(here, '..', '..', 'server', 'flowgraphs', ADAPTERS['ext.lora'].flowgraph);
  assert.ok(fs.existsSync(fg), `${fg} is missing`);
  const src = fs.readFileSync(fg, 'utf8');
  assert.match(src, /file_descriptor_source/, 'it reads the span off the pipe, not a temp file');
  assert.match(src, /json\.dumps/, 'and writes records the jsonl parser already reads');
});

test('LoRa is the one adapter whose rate follows a parameter', () => {
  const a = ADAPTERS['ext.lora'];
  assert.equal(typeof a.wants, 'function');
  // Sampled at a whole multiple of the bandwidth, so the bandwidth decides what the
  // decoder is fed. A static `wants` would have starved every setting but the default.
  assert.equal(adapterWants(a, { bw: '125000' }).rate, 250_000);
  assert.equal(adapterWants(a, { bw: '250000' }).rate, 500_000);
  assert.equal(adapterWants(a, {}).rate, 250_000, 'and it has a default');
  assert.equal(list().find((r) => r.id === 'ext.lora').wants.rate, 250_000,
               'which is what the table reports');
});

test('LoRa decodes its own transmitter, and only at the right spreading factor', async (t) => {
  if (skip(t, 'ext.lora')) return;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const data = path.join(here, '..', '..', 'fixtures', 'lora-sf7', 'capture.sigmf-data');
  if (!fs.existsSync(data)) { t.diagnostic('skipped: no LoRa fixture on disk'); return; }
  const buf = fs.readFileSync(data);
  const iq = new Float32Array(buf.length);              // cu8 back to float, as Capture does
  for (let i = 0; i < buf.length; i++) iq[i] = (buf[i] - 127.5) / 127.5;

  const at = (sf) => run('ext.lora', { data: iq, kind: 'iq', sampleRate: 250_000,
                                       timeoutMs: 60_000, params: { sf, bw: '125000', cr: '1', sync: '0x12' } });
  const good = await at('7');
  assert.equal(good.error, undefined, good.error);
  assert.ok(good.records.length >= 3, `SF7 found ${good.records.length} frames`);
  assert.match(good.records[0].text, /sdrflex lora fixture/);
  assert.match(good.note, /gnuradio\.lora_sdr/, 'the note names what ran, not python3.12');

  // The control. A decoder that finds something at every setting has found nothing.
  const wrong = await at('9');
  assert.equal(wrong.records.length, 0, 'SF9 should read a SF7 frame as noise');
});

// ── the adapter whose records are not on stdout ─────────────────────────────

test('M17 puts its records on stderr, because stdout is voice', () => {
  const a = ADAPTERS['ext.m17'];
  assert.equal(a.recordsOn, 'stderr');
  assert.equal(typeof a.parse, 'function');
  assert.equal(a.in, 'real', 'it reads the discriminator output, not IQ');
  assert.equal(adapterWants(a, {}).rate, 48_000);
  assert.ok(a.args({ params: {} }).includes('-l'), 'the link setup frame is the record');
  assert.ok(a.args({ params: { invert: 'yes' } }).includes('-i'));
  assert.ok(!a.args({ params: { invert: 'no' } }).includes('-i'));
});

test('M17 reads a link setup frame out of its own modulator', async (t) => {
  if (skip(t, 'ext.m17')) return;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const data = path.join(here, '..', '..', 'fixtures', 'm17-lsf', 'capture.sigmf-data');
  if (!fs.existsSync(data)) { t.diagnostic('skipped: no M17 fixture on disk'); return; }

  // The fixture is FM-modulated IQ, so the discriminator has to run first — the same
  // two steps the graph would build.
  const buf = fs.readFileSync(data);
  const iq = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) iq[i] = (buf[i] - 127.5) / 127.5;
  const audio = demodulate('core.fm_discriminator', iq, iq.length / 2, 96_000).data;

  const out = await run('ext.m17', { data: audio, kind: 'real', sampleRate: 96_000,
                                     params: { invert: 'no', blanker: 'no' }, timeoutMs: 60_000 });
  assert.equal(out.error, undefined, out.error);
  assert.equal(out.records.length, 1, `one transmission, one link setup: got ${out.records.length}`);
  const r = out.records[0];
  assert.equal(r.src, 'AB1CDE');
  assert.equal(r.dest, 'N0CALL');
  assert.match(r.text, /AB1CDE → N0CALL/);
  assert.ok(r.crc, 'and the frame check it reported');
  // The voice is real and this node does not carry it, which is said rather than dropped.
  assert.ok(r.voiceS > 0.5, `${r.voiceS} s of voice decoded alongside it`);
});

test('M17 given something that is not M17 finds nothing, and does not error', async (t) => {
  if (skip(t, 'ext.m17')) return;
  const rand = mod.rng(0xbeef);
  const noise = new Float32Array(48_000);
  for (let i = 0; i < noise.length; i++) noise[i] = (rand() - 0.5) * 0.8;
  const out = await run('ext.m17', { data: noise, kind: 'real', sampleRate: 48_000,
                                     params: {}, timeoutMs: 30_000 });
  assert.equal(out.records.length, 0);
  assert.equal(out.error, undefined, `noise is a result, not a failure: ${out.error}`);
});

// ── the WAV wrapper, which is why minimodem works at all ────────────────────

test('convert() writes a truthful WAV header when a container is asked for', () => {
  const { bytes, note } = convert(new Float32Array(1000), 'real', 48_000,
                                  { format: 's16', rate: 48_000, container: 'wav' });
  assert.equal(bytes.length, 44 + 2000);
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  assert.equal(bytes.readUInt32LE(4), 36 + 2000, 'RIFF size covers the whole file');
  assert.equal(bytes.readUInt32LE(40), 2000, 'and the data chunk says how many bytes follow');
  assert.equal(bytes.readUInt16LE(22), 1, 'mono');
  assert.equal(bytes.readUInt32LE(24), 48_000);
  assert.equal(bytes.readUInt16LE(34), 16);
  assert.match(note, /WAV wrapper/);
});

// ── and then the decoders themselves ────────────────────────────────────────

const APRS = [
  mod.ax25('N0CALL', 'APRS', '=4903.50N/07201.75W-sdrflex adapter check'),
  mod.ax25('KC1ABC', 'APRS', 'sdrflex-ax25-round-trip'),
];

test('multimon-ng reads AX.25 over Bell 202', async (t) => {
  if (skip(t, 'ext.multimon')) return;
  const out = await decode('ext.multimon', mod.afsk1200(APRS, { rate: AUDIO_RATE }), 'real',
                           { params: { modes: 'AFSK1200' } });
  assert.equal(out.error, undefined, out.error);
  const all = texts(out);
  assert.match(all, /sdrflex-ax25-round-trip/);
  assert.match(all, /sdrflex adapter check/);
  // The two lines multimon-ng prints per packet are one record, not two: the header
  // line has no message in it and the payload line has no sender.
  const flag = out.records.find((r) => /ax25-round-trip/.test(r.text));
  assert.match(flag.envelope || '', /KC1ABC/, 'the sender travels with the message');
});

test('multimon-ng reads touch tones', async (t) => {
  if (skip(t, 'ext.multimon')) return;
  const out = await decode('ext.multimon', mod.dtmf('5551234#', { rate: AUDIO_RATE }), 'real', { params: { modes: 'DTMF' } });
  assert.equal(out.error, undefined, out.error);
  assert.equal(out.records.map((r) => r.text).join(''), '5551234#');
  assert.ok(out.records.every((r) => r.demod === 'DTMF'), 'each digit says which demodulator read it');
});

test('multimon-ng reads Morse', async (t) => {
  if (skip(t, 'ext.multimon')) return;
  const out = await decode('ext.multimon', mod.morse('CQ DE N0CALL FLAG', { rate: AUDIO_RATE }), 'real',
                           { params: { modes: 'MORSE_CW' } });
  assert.equal(out.error, undefined, out.error);
  // MORSE_CW prints bare text with no demodulator prefix, which is the case that would
  // break a parser that glued every unprefixed line onto the record above it.
  assert.match(texts(out), /CQ DE N0CALL/);
  assert.ok(!out.records.some((r) => r.envelope), 'and nothing gets folded into anything');
});

// The `modes` control was a text field, and a text field is the wrong shape for a set
// whose members are fixed, finite and published by the program itself. These three say
// what the list has to keep true, because all three failure modes were live: a name the
// binary does not have makes multimon-ng exit 2 and decode nothing at all; the list the
// UI offers has to come from the binary rather than from a constant here; and the
// speculative pass has to stay narrower than the control, which is the opposite of what
// "cast the widest net" sounds like.

test('the demodulator list comes from the installed binary', (t) => {
  if (skip(t, 'ext.multimon')) return;
  const modes = list().find((a) => a.id === 'ext.multimon').params.find((p) => p.id === 'modes');
  assert.equal(modes.type, 'multi', 'a set is picked from, not typed');
  assert.ok(Array.isArray(modes.values) && modes.values.length >= 10,
            `expected a probed list, got ${JSON.stringify(modes.values)}`);
  assert.ok(modes.values.includes('POCSAG1200'));
  // Debugging sinks are not demodulators and produce no record, so they are not offered.
  assert.ok(!modes.values.includes('SCOPE') && !modes.values.includes('DUMPCSV'));
  for (const m of String(modes.default).split(' ')) {
    assert.ok(modes.values.includes(m), `the default names ${m}, which is not on offer`);
  }
});

test('a demodulator this build has not got is dropped, not passed through', (t) => {
  if (skip(t, 'ext.multimon')) return;
  const args = ADAPTERS['ext.multimon'].args({ params: { modes: 'AFSK1200 NOTAREALDEMOD' } });
  assert.deepEqual(args.filter((a, i) => args[i - 1] === '-a'), ['AFSK1200'],
                   'one unknown name must not cost the decodes of the others');
});

test('the speculative pass is narrower than the list on offer', (t) => {
  if (skip(t, 'ext.multimon')) return;
  const have = multimonDemods();
  const sweep = ADAPTERS['ext.multimon'].sweep().modes.split(' ');
  assert.ok(sweep.length < have.length, 'sweeping everything is not the same as sweeping well');
  for (const m of sweep) assert.ok(have.includes(m), `sweep names ${m}, which is not installed`);
  // The tone decoders print on noise. identify.test.mjs is where that is measured; this
  // just holds the line, because the fix is one edit away from being undone.
  for (const m of ['ZVEI1', 'ZVEI2', 'EEA', 'EIA', 'CCIR']) {
    assert.ok(!sweep.includes(m), `${m} emits a record per tone it thinks it heard`);
  }
});

// M17 packet mode: the one decoder here that does not read samples.
//
// It reads one float per symbol, so there is a `core.symbols` node in front of it and the
// end-to-end proof is `fixtures/m17-packet` rather than a modulator call here — the
// encoder writes a symbol stream, which is what the decoder eats, so a round trip through
// this adapter alone would skip the part that was hard. What these check is the parse,
// because what the program prints is a drawing: a colored tree with box characters, and
// every field name arrives wrapped in four escape sequences.

test('the M17 packet parse reads a drawn report', () => {
  const E = String.fromCharCode(27);
  const c = (n, t) => `${E}[${n}m${t}${E}[39m`;
  const drawn = [
    `${E}[96m[04:01:07] ${c(92, 'Packet received')}`,
    ` \u251c ${c(93, 'Destination:')} N0CALL`,
    ` \u251c ${c(93, 'Source:')} AB1CDE`,
    ` \u251c ${c(93, 'Type:')} 0380`,
    ` \u2514 ${c(93, 'LSF CRC:')} ${c(92, 'match')}`,
    ` ${c(93, 'Content')}`,
    ` \u251c ${c(93, 'Type:')} SMS`,
    ` \u251c ${c(93, 'Text:')} sdr-flex packet mode fixture`,
    ` \u2514 ${c(93, 'Payload CRC:')} ${c(92, 'match')}`,
  ].join('\n');
  const out = ADAPTERS['ext.m17_packet'].parse('', drawn, {}, {});
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.equal(out[0].text, 'sdr-flex packet mode fixture');
  assert.equal(out[0].src, 'AB1CDE');
  assert.equal(out[0].dest, 'N0CALL');
  assert.equal(out[0].payloadCrc, 'match');
  assert.equal(out[0].suspect, undefined);
});

test('a packet whose CRC did not match says so rather than being dropped', () => {
  // ADR-0031: "decoded" and "decoded and the CRC agreed" are different claims, and the
  // second one is the only one worth making silently.
  const E = String.fromCharCode(27);
  const drawn = [
    `${E}[92mPacket received${E}[39m`,
    ' \u251c Source: AB1CDE',
    ' \u251c Text: probably',
    ' \u2514 Payload CRC: mismatch',
  ].join('\n');
  const out = ADAPTERS['ext.m17_packet'].parse('', drawn, {}, {});
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'probably');
  assert.match(out[0].suspect, /CRC/);
});

test('nothing decoded names the mistake it is most likely to be', () => {
  const a = ADAPTERS['ext.m17_packet'];
  // Handed samples rather than symbols is the failure this adapter invites, because the
  // conversion in front of it will quietly resample 48 kS/s down to 4800 and there was
  // never a symbol grid to find.
  const resampled = a.parse('', '', {}, { inputNote: 'resampled 48.0 \u2192 4.8 kS/s, f32 at 4.8 kS/s' });
  assert.equal(resampled.records.length, 0);
  assert.match(resampled.note, /Symbol sync/);
  assert.match(resampled.note, /resampled/);
  const plain = a.parse('', '', {}, { inputNote: 'f32 at 4.8 kS/s' });
  assert.match(plain.note, /invert|eye/);
});

test('M17 stream mode no longer measures voice that was never there', () => {
  // It used to quote `0.0 s of voice decoded` whether or not any came out, which on a
  // packet-mode burst is a true statement about the wrong mode — and a confident one.
  const out = ADAPTERS['ext.m17'].parse('', '', {}, { outBytes: 0 });
  assert.equal(out.records.length, 0);
  assert.ok(!/0\.0 s of voice/.test(out.note), out.note);
  assert.match(out.note, /packet/);
  // With voice on stdout and no LSF in the span, the old message is still the right one.
  const voiced = ADAPTERS['ext.m17'].parse('', '', {}, { outBytes: 8000 });   // 4000 samples, half a second
  assert.match(voiced.note, /0\.5 s of voice/);
});

test('direwolf reads AX.25 over Bell 202', async (t) => {
  if (skip(t, 'ext.direwolf')) return;
  const out = await decode('ext.direwolf', mod.afsk1200(APRS, { rate: AUDIO_RATE }), 'real');
  assert.equal(out.error, undefined, out.error);
  const all = texts(out);
  assert.match(all, /KC1ABC>APRS:sdrflex-ax25-round-trip/);
  assert.match(all, /N0CALL>APRS:=4903\.50N/);
  // direwolf measures the level it saw, which is worth keeping: "no decodes" and "no
  // decodes and the audio was at 4%" are different problems (ADR-0017).
  assert.ok(out.records.some((r) => typeof r.level === 'number'), 'the audio level comes back too');
  assert.ok(!/audio level/.test(all), 'and it is a field rather than a record of its own');
});

test('direwolf is given a config, because otherwise it wants a sound card', (t) => {
  const files = ADAPTERS['ext.direwolf'].files({ rate: 44_100, params: {} });
  const conf = files.find((f) => f.name === 'direwolf.conf').text;
  assert.match(conf, /^ADEVICE stdin null$/m, 'it reads stdin and writes nowhere');
  assert.match(conf, /^AGWPORT 0$/m, 'and does not open 8000');
  assert.match(conf, /^KISSPORT 0$/m, 'or 8001');
  assert.match(ADAPTERS['ext.direwolf'].files({ rate: 44_100, params: { modem: '9600' } })[0].text,
               /^MODEM 9600$/m, 'the modem parameter reaches the config');
});

test('direwolf is handed the word stdin, not a dash', () => {
  const args = ADAPTERS['ext.direwolf'].args({ rate: 44_100, dir: '/tmp/x', params: {} });
  assert.ok(args.includes('stdin'), 'getopt eats a bare dash, so the word is stdin');
  assert.ok(!args.includes('-'), 'and a dash would leave it with no file at all');
  assert.ok(!args.join(' ').includes('-q hd'), '-q hd suppresses the decodes we want');
  assert.equal(args[args.indexOf('-c') + 1], '/tmp/x/direwolf.conf');
});

test('minimodem reads Bell 202 through a pipe', async (t) => {
  if (skip(t, 'ext.minimodem')) return;
  const out = await decode('ext.minimodem', mod.bell202('sdrflex-minimodem-round-trip\n'), 'real');
  assert.equal(out.error, undefined, out.error);
  assert.match(texts(out), /sdrflex-minimodem-round-trip/);
  const rec = out.records[0];
  // What the modem measured, alongside what it read (ADR-0017).
  assert.equal(rec.bps, 1200, 'it reports the bit rate it locked to');
  assert.ok(rec.confidence > 1, `and how sure it was (${rec.confidence})`);
  assert.equal(rec.carrierHz, 1200, 'and the mark tone it found');
});

test('minimodem takes a tone pair and a baud rate that are not Bell 202', async (t) => {
  if (skip(t, 'ext.minimodem')) return;
  // Bell 103 originate: 300 baud, 1070 and 1270 Hz. A different rate and a different
  // pair, so it exercises both parameters rather than re-running the default.
  const signal = mod.bell202('sdrflex-bell103-300-baud\n', { baud: 300, mark: 1070, space: 1270 });
  const out = await decode('ext.minimodem', signal, 'real',
                           { params: { baudmode: '300', mark: '1070', space: '1270' } });
  assert.equal(out.error, undefined, out.error);
  assert.match(texts(out), /sdrflex-bell103-300-baud/);
  assert.equal(out.records[0].bps, 300, 'and it reports the rate it was told to expect');
});

test('dump1090 reads Mode S', async (t) => {
  if (skip(t, 'ext.dump1090')) return;
  const iq = mod.modeS([mod.adsbIdent(0x4840d6, 'SDRFLEX'), mod.adsbIdent(0xabcdef, 'SDRFLX2')]);
  const out = await decode('ext.dump1090', iq, 'iq', { sampleRate: 2_400_000 });
  assert.equal(out.error, undefined, out.error);
  assert.equal(out.records.length, 2, `two frames in, two frames out (${texts(out)})`);
  assert.equal(out.records[0].text, '8d4840d6204c448630562001163a');
  assert.equal(out.records[0].icao, '4840D6');
  assert.equal(out.records[0].df, 17, 'an extended squitter');
  assert.equal(out.records[0].bits, 112);
  assert.equal(out.records[1].icao, 'ABCDEF');
});

test('dump1090 is not silenced by its own arguments', () => {
  const args = ADAPTERS['ext.dump1090'].args({ rate: 2_400_000, params: {} });
  assert.ok(args.includes('--raw'), 'we want the messages');
  assert.ok(!args.includes('--quiet'), 'and --quiet turns off the stdout they arrive on');
  assert.equal(args[args.indexOf('--ifile') + 1], '-');
});

test('rtl_433 reads an OOK PWM burst', async (t) => {
  if (skip(t, 'ext.rtl433')) return;
  // The same shape as the shipped fixture, generated here so the test needs no file:
  // short pulse zero, long pulse one, fixed gap, a long reset between packets.
  const rate = 250_000, us = (x) => Math.round(x * 1e-6 * rate);
  const rand = mod.rng(0x5eed1);
  const out = [];
  const push = (n, amp) => { for (let i = 0; i < n; i++) out.push(amp + (rand() - 0.5) * 0.008, (rand() - 0.5) * 0.008); };
  push(us(10_000), 0);
  for (let rep = 0; rep < 4; rep++) {
    for (const w of [0b101100110011010101100110, 0b110010101010011001011001]) {
      for (let k = 23; k >= 0; k--) { push((w >> k) & 1 ? us(500) : us(250), 0.45); push(us(250), 0); }
      push(us(6000), 0);
    }
  }
  const res = await decode('ext.rtl433', Float32Array.from(out), 'iq',
                           { sampleRate: rate, centerHz: 433_920_000,
                             params: { flex: 'n=test,m=OOK_PWM,s=250,l=500,g=750,r=6000' } });
  assert.equal(res.error, undefined, res.error);
  assert.ok(res.records.length >= 2, `it found ${res.records.length} packets`);
  assert.match(texts(res), /test/, 'named by the flex spec it was given');
});

test('rtl_433 says what it measured when it recognizes nothing', async (t) => {
  if (skip(t, 'ext.rtl433')) return;
  const rate = 250_000, n = rate / 2;
  const rand = mod.rng(0xdead);
  const noise = new Float32Array(n * 2);
  for (let i = 0; i < n * 2; i++) noise[i] = (rand() - 0.5) * 0.02;
  const res = await decode('ext.rtl433', noise, 'iq', { sampleRate: rate, centerHz: 433_920_000 });
  assert.equal(res.records.length, 0, 'noise is not a device');
  // Nothing found is a result rather than a failure, and it comes with an account of
  // itself — but a guess is labelled a guess and kept apart from the measurement.
  if (res.explained) {
    assert.ok(!('suggestion' in res.explained) || typeof res.explained.suggestion === 'string');
    assert.ok(!res.explained.guess || typeof res.explained.guess === 'string');
  }
});
