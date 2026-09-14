// BBC concurrent codes: the codec, and the property it is named for.
//
// `web/plugins/bbc.js` is the reference plugin for ADR-0028 and it went a long time with
// no test, for a mechanical reason rather than a lazy one: it only decodes, and a decoder
// with no way to generate an input cannot have a golden capture (ADR-0025). Adding
// `encode()` fixes that, and creates a new problem — a codec checked only against itself
// agrees with itself no matter what it does.
//
// So there are two independent anchors, and neither of them is our own encoder:
//
//   1. The glowworm's published check value, the hash of the empty string. It needs
//      nothing installed and it catches the one mistake this algorithm invites.
//   2. The reference implementation's own codewords, compared byte for byte — when
//      SDRFLEX_GRBBC points at a checkout of it, and skipped loudly when it does not.
//
//   node --test web/test/bbc.test.mjs
//   SDRFLEX_GRBBC=~/src/gr-bbc node --test web/test/bbc.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as bbc from '../plugins/bbc.js';
import * as plugins from '../src/plugins.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const P = { msgBytes: 16, codBytes: 1024, checkBits: 32 };
const A = 'FAN REMOTE DEMO ';
const B = 'SDR FLEX  v1    ';

const text = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const marksIn = (u8) => [...u8].reduce((t, v) => t + (v.toString(2).match(/1/g) || []).length, 0);
const superimpose = (x, y) => x.map((v, i) => v | y[i]);

// ── the hash ────────────────────────────────────────────────────────────────

test('the glowworm reproduces the published hash of the empty string', () => {
  // The trap this guards. The register words are 64 bits, so the shifts wrap modulo
  // 2^64 — but the inversion applied when the folded bit is 1 is only 32 bits wide.
  // That reads like a C integer-width accident and is not: widening it moves every
  // mark and silently stops interoperating with every other implementation. Nothing
  // else complains — the density still looks right, messages simply never come back.
  const w = new bbc.Glowworm();
  assert.equal(w._h >>> 0, bbc.CHECKVALUE.hi, 'high word of the warm-up hash');
  assert.equal(w._l >>> 0, bbc.CHECKVALUE.lo, 'low word of the warm-up hash');
  assert.equal(bbc.CHECKVALUE.hi, 0xCCA4220F);
  assert.equal(bbc.CHECKVALUE.lo, 0xC78D45E0);
});

test('two glowworms do not share a register', () => {
  // They did once, upstream, as module globals — and two blocks in one flowgraph then
  // corrupted each other silently.
  const a = new bbc.Glowworm(), b = new bbc.Glowworm();
  for (let i = 0; i < 40; i++) a.addBit(i & 1);
  assert.equal(b._h >>> 0, bbc.CHECKVALUE.hi);
  assert.equal(b._l >>> 0, bbc.CHECKVALUE.lo);
});

// ── the codec ───────────────────────────────────────────────────────────────

test('a message goes in and comes back', () => {
  const cw = bbc.encode(text(A), P);
  assert.equal(cw.length, P.codBytes);
  // 16 bytes is 128 message bits plus 32 check bits: 160 marks, minus any collisions.
  assert.ok(marksIn(cw) > 150 && marksIn(cw) <= 160, `${marksIn(cw)} marks`);
  assert.deepEqual(bbc.decode(cw, P).map((r) => r.text), [A]);
});

test('two messages in one codeword both come back', () => {
  // The property the codec is named for, and the one a plausible regression loses: a
  // decoder that returns element zero and stops passes every test above this one.
  const both = superimpose(bbc.encode(text(A), P), bbc.encode(text(B), P));
  const out = bbc.decode(both, P).map((r) => r.text);
  assert.equal(out.length, 2, out.join(' | '));
  assert.deepEqual(out.slice().sort(), [A, B].slice().sort());
});

test('the channel is asymmetric: marks may be added, never removed', () => {
  const both = superimpose(bbc.encode(text(A), P), bbc.encode(text(B), P));

  // Jam it: set two hundred extra cells at random. Both messages survive, because a
  // false path still has to find every one of its own marks.
  const jammed = both.slice();
  let seed = 0x9e37;
  for (let i = 0; i < 200; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const cell = seed % (P.codBytes * 8);
    jammed[cell >> 3] |= 1 << (cell & 7);
  }
  const survived = bbc.decode(jammed, P).map((r) => r.text).sort();
  assert.deepEqual(survived, [A, B].sort(), 'both messages survive added marks');

  // Clear one mark that a message depends on, and that message is gone. Not a flaw —
  // it is the direction the code does not defend, and a fixture that never checked it
  // could not tell a working decoder from one that ignores the codeword.
  const one = bbc.encode(text(A), P);
  const holed = one.slice();
  const at = holed.findIndex((v) => v !== 0);
  holed[at] &= holed[at] - 1;                      // clear its lowest set bit
  assert.deepEqual(bbc.decode(holed, P).map((r) => r.text), []);
});

test('a codeword shorter than it should be is refused, not guessed at', () => {
  const cw = bbc.encode(text(A), P);
  assert.throws(() => bbc.decode(cw.subarray(0, 512), P), /needs 1024/);
});

test('a codeword must be longer than the message it carries', () => {
  assert.throws(() => bbc.encode(text(A), { msgBytes: 16, codBytes: 16 }), /must be longer/);
});

test('density is what to look at when nothing decodes', () => {
  const both = superimpose(bbc.encode(text(A), P), bbc.encode(text(B), P));
  const d = bbc.density(both);
  assert.ok(d > 0.03 && d < 0.05, `${(d * 100).toFixed(2)}%`);
  assert.equal(bbc.density(new Uint8Array(64).fill(0xff)), 1);
  assert.equal(bbc.density(new Uint8Array(64)), 0);
});

// ── against the reference implementation ────────────────────────────────────

const GRBBC = process.env.SDRFLEX_GRBBC;

test('the codewords are byte for byte the reference implementation\'s', (t) => {
  // xeno00/gr-bbc. Its codec imports nothing from GNU Radio, so this needs a checkout
  // and a Python and not a built OOT module. Skipped rather than failed when it is not
  // here: the port is still correct, it just cannot be exercised on this machine, and a
  // red suite on a laptop teaches people to ignore the suite.
  if (!GRBBC || !fs.existsSync(path.join(GRBBC, 'python', 'bbc', 'codec.py'))) {
    t.skip('set SDRFLEX_GRBBC to a checkout of github.com/xeno00/gr-bbc to run this');
    return;
  }
  // bbc/__init__.py pulls in GNU Radio, so the two pure modules are loaded by path.
  const script = `
import sys, importlib.util, types, json
pkg = types.ModuleType('b'); pkg.__path__ = [sys.argv[1] + '/python/bbc']; sys.modules['b'] = pkg
for name in ('glowworm', 'codec'):
    spec = importlib.util.spec_from_file_location('b.' + name, pkg.__path__[0] + '/%s.py' % name)
    m = importlib.util.module_from_spec(spec); sys.modules['b.' + name] = m; spec.loader.exec_module(m)
codec, glow = sys.modules['b.codec'], sys.modules['b.glowworm']
enc = codec.Encoder(16, 1024, 32)
print(json.dumps({
    'checkvalue': glow.CHECKVALUE,
    'a': bytes(enc.encode(sys.argv[2].encode())).hex(),
    'b': bytes(enc.encode(sys.argv[3].encode())).hex(),
}))
`;
  const got = spawnSync('python3', ['-c', script, GRBBC, A, B], { encoding: 'utf8' });
  assert.equal(got.status, 0, got.stderr);
  const ref = JSON.parse(got.stdout);

  assert.equal(ref.checkvalue,
               bbc.CHECKVALUE.hi * 2 ** 32 + bbc.CHECKVALUE.lo,
               'the published check value is the one this port pins');

  const hex = (u8) => Buffer.from(u8).toString('hex');
  assert.equal(hex(bbc.encode(text(A), P)), ref.a);
  assert.equal(hex(bbc.encode(text(B), P)), ref.b);

  // And the other direction: our decoder reads their codeword.
  const theirs = superimpose(Uint8Array.from(Buffer.from(ref.a, 'hex')),
                             Uint8Array.from(Buffer.from(ref.b, 'hex')));
  assert.deepEqual(bbc.decode(theirs, P).map((r) => r.text).sort(), [A, B].sort());
});

// ── as a plugin ─────────────────────────────────────────────────────────────

test('it loads as a plugin and runs through the registry', async () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'plugins', 'bbc.js'), 'utf8');
  const entry = await plugins.loadSource(src, 'bbc.js');
  assert.equal(entry.id, 'ext.bbc');
  assert.equal(entry.in, 'bytes');
  assert.equal(entry.out, 'events');
  // Every parameter has to arrive with a default, or the plugin is not usable as dropped.
  for (const p of entry.params) assert.notEqual(p.default, undefined, p.id);

  const both = superimpose(bbc.encode(text(A), P), bbc.encode(text(B), P));
  const out = plugins.run('ext.bbc', both, P);
  assert.equal(out.error, undefined);
  assert.deepEqual(out.records.map((r) => r.text).sort(), [A, B].sort());

  // A throw inside a decoder is a result, not a crash — the whole point is to try
  // several and see which one says something.
  const short = plugins.run('ext.bbc', both.subarray(0, 100), P);
  assert.match(short.error, /needs 1024/);
  assert.deepEqual(short.records, []);
});
