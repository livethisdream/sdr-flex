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
import { ADAPTERS, available, resolve, list, run, convert } from '../../server/adapters.js';
import * as mod from './support/modulate.mjs';

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
    assert.ok(a.wants && a.wants.format && a.wants.rate, `${id} says what it wants on stdin`);
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
