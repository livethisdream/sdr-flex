// HD Radio: the digital sidebands either side of an FM broadcast carrier.
//
//   node --test web/test/nrsc5.test.mjs
//
// Worth a row because an NRSC-5 station carries more than audio: a station name, the
// title and artist of what is playing, and — through Advanced Application Services —
// *files*. Album art arrives over the air as a LOT file, a whole channel of content no
// amount of listening reveals.
//
// The lines below are the ones `nrsc5` actually prints, read out of the `log_info` calls
// in its `src/main.c` rather than guessed: its logger writes to stderr unconditionally,
// prefixed with a wall-clock `HH:MM:SS `. That timestamp is when the decode ran, not a
// time in the signal, which is why it is stripped rather than reported.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as adapters from '../../server/adapters.js';

const A = adapters.ADAPTERS['ext.nrsc5'];
const log = (...lines) => lines.map((l) => `12:34:56 ${l}`).join('\n') + '\n';
const parse = (stderr) => A.parse('', stderr, A, {});

test('it reads IQ at the rate the program actually works in', () => {
  assert.equal(A.in, 'iq');
  assert.equal(A.out, 'events');
  assert.equal(A.wants.format, 'cs16');
  assert.equal(A.wants.rate, 744_188);
  // The sidebands reach about ±200 kHz, so a narrower channel has filtered off the very
  // thing being decoded and the decoder then reports nothing about a signal that was
  // there — which is the failure ADR-0031 exists to prevent.
  assert.equal(A.minRate, 400_000);
});

test('one positional argument, because the input is a file', () => {
  // `main.c` counts `optind + (!input_name + 1)`: with `-r` set it wants the program
  // number alone. Passing a frequency as well is a usage error and no decode at all.
  const args = A.args({ params: { program: 2 } });
  assert.deepEqual(args.slice(args.indexOf('-r'), args.indexOf('-r') + 2), ['-r', '-']);
  assert.equal(args[args.length - 1], '2', `last argument should be the program: ${args.join(' ')}`);
  assert.equal(args.filter((a) => /^\d+$/.test(a)).length, 1, 'more than one positional number');
});

test('a program number outside what a station can carry is clamped, not passed on', () => {
  assert.equal(A.args({ params: { program: 99 } }).pop(), '7');
  assert.equal(A.args({ params: { program: -3 } }).pop(), '0');
  assert.equal(A.args({ params: {} }).pop(), '0');
});

test('what is playing comes back, with the link quality as its evidence', () => {
  const out = parse(log(
    'Synchronized',
    'MER: 14.2 dB (lower), 13.8 dB (upper)',
    'BER: 0.000431, avg: 0.000502, min: 0.000000, max: 0.004000',
    'Station name: KEXP-HD1',
    'Title: Blue Monday',
    'Artist: New Order',
  ));
  const texts = out.map((r) => r.text);
  assert.ok(texts.some((t) => t === 'Station name: KEXP-HD1'), texts.join(' | '));
  assert.ok(texts.some((t) => t === 'Title: Blue Monday'));
  assert.ok(texts.some((t) => t === 'Artist: New Order'));
  // Attached to every record rather than printed once and scrolled away: a decode you
  // cannot argue with is not evidence (ADR-0017).
  for (const r of out) {
    assert.equal(r.merDb, '14.2 / 13.8');
    assert.equal(r.ber, '0.0004');
  }
});

test('a file sent over the air is named, because the name is how you decide you want it', () => {
  const [r] = parse(log('LOT file: port=1001 lot=17 name=cover.jpg size=24576 mime=1E653E9C expiry=none'));
  assert.equal(r.kind, 'file');
  assert.match(r.text, /cover\.jpg \(24576 bytes\)/);
  assert.equal(r.lot, 17);
});

test('the logger’s clock is not reported as a time in the signal', () => {
  // It is wall clock at decode time. Leaving it on a record would put a timestamp next
  // to a song that has nothing to do with where in the capture it played.
  const [r] = parse(log('Title: Something'));
  assert.equal(r.text, 'Title: Something');
  assert.ok(!/12:34:56/.test(JSON.stringify(r)), JSON.stringify(r));
});

test('locked but silent is a different answer from never locked', () => {
  // The two ways to get no records, and they point at different next moves: one is a
  // span too short to catch a metadata update, the other is a channel too narrow to
  // contain the sidebands at all.
  const quiet = parse(log('Synchronized', 'MER: 9.0 dB (lower), 9.4 dB (upper)'));
  assert.deepEqual(quiet.records, []);
  assert.match(quiet.note, /sent no metadata/);
  assert.match(quiet.note, /MER 9\.0 \/ 9\.4/);

  const nothing = parse(log('Best gain: 30.0 dB, Peak amplitude: -12.0 dBFS'));
  assert.deepEqual(nothing.records, []);
  assert.match(nothing.note, /never synchronized/);
  assert.match(nothing.note, /200 kHz/);
});

test('its own chatter is not mistaken for a decode', () => {
  // AGC and bit-rate lines arrive constantly and say nothing about content. A pane full
  // of "Best gain: 30.0 dB" is worse than an empty one.
  const out = parse(log(
    'Best gain: 30.0 dB, Peak amplitude: -12.0 dBFS',
    'Audio bit rate: 96.0 kbps',
    'Primary service mode: 1',
    'Frequency offset: -12 Hz',
    'Synchronized',
  ));
  assert.deepEqual(out.records, [], JSON.stringify(out.records));
});
