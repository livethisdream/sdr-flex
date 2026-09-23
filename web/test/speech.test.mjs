// Speech to text, and the one decoder here whose failure mode is being convincing.
//
//   node --test web/test/speech.test.mjs
//
// Every other program in the adapter table either decodes a frame or does not: a CRC
// agrees or it does not, a syncword correlates or it does not. Whisper always produces
// fluent, well-punctuated English — including from silence, where "Thank you." and
// "Thanks for watching!" are its two most famous inventions. A transcript of static that
// reads like a sentence is the worst thing this tool could hand anybody.
//
// So what is pinned here is the *honesty*, not the accuracy: that a low-confidence
// segment is marked as a guess rather than presented as a decode, that the evidence for
// each record travels with it (ADR-0017), and that the flags which raise whisper's own
// silence gates are actually on the command line.
//
// The JSON below is the shape `output_json` in whisper.cpp's `examples/cli/cli.cpp`
// writes — segment `timestamps`/`offsets`/`text`, and with `-ojf` a `tokens` array whose
// entries carry `id`, `p` and `t_dtw`. Offsets are milliseconds (the writer emits the
// centisecond timestamp times ten). Read off the writer rather than guessed at.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as adapters from '../../server/adapters.js';

const A = adapters.ADAPTERS['ext.whisper'];

/** One segment, the way whisper writes it. */
const seg = (text, ps, fromMs = 0, toMs = 2000) => ({
  timestamps: { from: '00:00:00,000', to: '00:00:02,000' },
  offsets: { from: fromMs, to: toMs },
  text,
  tokens: ps.map((p, i) => ({
    text: i === 0 ? '[_BEG_]' : ` w${i}`, offsets: { from: fromMs, to: toMs },
    id: 1000 + i, p, t_dtw: -1,
  })),
});
const doc = (...segments) => JSON.stringify({
  systeminfo: 'AVX = 1', model: { type: 'base' }, params: {}, result: { language: 'en' },
  transcription: segments,
});
const parse = (stdout, stderr = '', params = {}) =>
  A.parse(stdout, stderr, A, { params });

test('it is an audio decoder that produces events, like the rest of them', () => {
  assert.equal(A.in, 'real');
  assert.equal(A.out, 'events');
  assert.equal(A.wants.rate, 16_000);
  assert.equal(A.wants.container, 'wav', 'whisper reads through miniaudio, which wants a header');
});

test('the audio goes in on stdin and the JSON comes back on stdout', () => {
  // `-` is a filename whisper understands: it reads the WAV off stdin. So a decode
  // writes nothing to disk, and two decodes cannot read each other's audio.
  const args = A.args({ params: { language: 'en' } });
  assert.deepEqual(args.slice(args.indexOf('-f'), args.indexOf('-f') + 2), ['-f', '-']);
  assert.ok(args.includes('-ojf'), 'without full JSON there are no token probabilities');
  assert.deepEqual(args.slice(args.indexOf('-of'), args.indexOf('-of') + 2), ['-of', '-']);
});

test('the silence gates are raised, and can be put back', () => {
  // The defaults are chosen for audio known to contain speech. A radio channel very
  // often does not, which is the whole difference.
  const strict = A.args({ params: { quiet: 'strict' } });
  assert.ok(strict.includes('-nth'), 'no-speech threshold not set');
  assert.ok(strict.includes('-lpt'), 'log-probability threshold not set');
  assert.ok(strict.includes('-sns'), 'non-speech tokens not suppressed');
  const loose = A.args({ params: { quiet: 'default' } });
  for (const f of ['-nth', '-lpt', '-sns']) assert.ok(!loose.includes(f), `${f} should be off`);
  // And it asks the same question the same way twice, which is the least a decoder owes
  // anybody trying to debug one.
  assert.deepEqual(A.args({ params: {} }).slice(A.args({ params: {} }).indexOf('-tp')).slice(0, 2),
                   ['-tp', '0']);
});

test('a confident segment is a record with its evidence beside it', () => {
  const [r] = parse(doc(seg(' Control this is dispatch.', [0.4, 0.93, 0.88, 0.91], 3000, 5000)));
  assert.equal(r.text, 'Control this is dispatch.');
  assert.equal(r.fromS, 3);
  // The `[_BEG_]` token is whisper's own punctuation and says nothing about the words,
  // so it is not in the average — with it, this segment would read 0.78.
  assert.ok(Math.abs(r.confidence - 0.907) < 0.002, `confidence ${r.confidence}`);
  assert.ok(!r.suspect, 'a confident segment should not be marked as a guess');
});

test('an unconvincing segment is reported as a guess, not withheld', () => {
  // Both halves matter. Dropping it would turn "whisper invented a sentence here" into
  // "nothing here", which points at a different next move; presenting it plainly would
  // be the tool telling you a lie in its own voice.
  const [r] = parse(doc(seg(' Thanks for watching!', [0.9, 0.31, 0.28, 0.35])));
  assert.equal(r.text, 'Thanks for watching!');
  assert.match(r.suspect, /mean token probability 0\.31, under 0\.6/);
});

test('the floor is a judgment, so it is a parameter', () => {
  const low = parse(doc(seg(' maybe words', [0.9, 0.55, 0.55])), '', { confidence: 0.4 });
  assert.ok(!low[0].suspect, 'a floor of 0.4 should accept 0.55');
  const high = parse(doc(seg(' maybe words', [0.9, 0.55, 0.55])), '', { confidence: 0.8 });
  assert.ok(high[0].suspect, 'a floor of 0.8 should reject 0.55');
});

test('nothing said is said as nothing, and says which gates were up', () => {
  const strict = parse(doc(), '', { quiet: 'strict' });
  assert.deepEqual(strict.records, []);
  assert.match(strict.note, /no speech in this span/);
  assert.match(strict.note, /gates are raised/);
  const loose = parse(doc(), '', { quiet: 'default' });
  assert.match(loose.note, /defaults/);
});

test('a model that did not load is named rather than read as silence', () => {
  // These two look identical from the outside — no records — and point at completely
  // different next moves, which is the distinction ADR-0031 is built on.
  const out = parse('', 'whisper_init_from_file_with_params_no_state: loading model\n' +
                        'error: failed to initialize whisper context\n');
  assert.deepEqual(out.records, []);
  assert.match(out.note, /failed to initialize whisper context|error:/);
});

test('an empty segment is not a record', () => {
  // Whisper emits these around its own timestamp tokens; a blank row in the pane is
  // worse than no row.
  assert.equal(parse(doc(seg('   ', [0.9, 0.9]), seg(' real', [0.9, 0.9]))).length, 1);
});
