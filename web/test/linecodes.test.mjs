// Manchester and differential: the layer between symbols and bits that exists because
// a radio link cannot afford two hundred zeros in a row.

import test from 'node:test';
import assert from 'node:assert/strict';
import { manchesterSlice, estimateManchesterSymbol, differentialDecode,
         unpackBits, packBits, otsuThreshold } from '../src/dsp.js';

const RATE = 100_000, SYMBOL_US = 400;
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');

/** Draw a Manchester waveform for these bytes, the way a transmitter would. */
function manchester(bytes, { symbolUs = SYMBOL_US, polarity = 'ieee', noise = 0, lead = 0 } = {}) {
  const sps = symbolUs * 1e-6 * RATE, half = sps / 2;
  const bits = [];
  for (const b of bytes) for (let k = 7; k >= 0; k--) bits.push((b >> k) & 1);
  const env = new Float32Array(Math.round((bits.length + lead) * sps));
  const put = (from, len, v) => {
    for (let s = 0; s < len; s++) {
      const i = Math.round(from) + s;
      if (i < env.length) env[i] = v + (noise ? (Math.random() - 0.5) * 2 * noise : 0);
    }
  };
  for (let i = 0; i < lead; i++) { put((i) * sps, half, 0); put(i * sps + half, half, 1); }
  bits.forEach((bit, i) => {
    // IEEE 802.3: a 1 is low then high; a 0 is high then low. Thomas is the reverse.
    const one = polarity === 'ieee' ? bit : 1 - bit;
    put((lead + i) * sps, half, one ? 0 : 1);
    put((lead + i) * sps + half, half, one ? 1 : 0);
  });
  return env;
}

test('a clean Manchester waveform decodes to the bytes that drew it', () => {
  const msg = Uint8Array.from([0xaa, 0x3c, 0x69, 0x01]);
  const env = manchester(msg);
  const r = manchesterSlice(env, 0.5, RATE, SYMBOL_US);
  assert.equal(hex(r.bytes), hex(msg));
  assert.equal(r.violations, 0, 'a correct decode has a transition in every symbol');
  assert.equal(r.symbols, 32);
});

test('the symbol period is derived from the signal, not told to it', () => {
  for (const symbolUs of [200, 400, 1000]) {
    const env = manchester(Uint8Array.from([0x5a, 0xc3, 0x0f, 0xf0]), { symbolUs });
    const est = estimateManchesterSymbol(env, 0.5, RATE);
    assert.ok(Math.abs(est.value - symbolUs) < symbolUs * 0.05,
      `${symbolUs} µs estimated as ${est.value.toFixed(1)}`);
    assert.ok(est.confident, `should be confident at ${symbolUs} µs (${(est.agreement * 100).toFixed(0)}%)`);
    assert.match(hex(manchesterSlice(env, 0.5, RATE, est.value).bytes), /5a c3 0f f0/);
  }
});

test('violations are how a wrong symbol rate announces itself', () => {
  const env = manchester(Uint8Array.from([0xaa, 0x3c, 0x69, 0x01]));
  const right = manchesterSlice(env, 0.5, RATE, SYMBOL_US);
  const wrong = manchesterSlice(env, 0.5, RATE, SYMBOL_US * 1.5);
  assert.equal(right.violations, 0);
  assert.ok(wrong.violations > wrong.symbols * 0.1,
    `a rate 50% off should violate constantly, got ${wrong.violations}/${wrong.symbols}`);
});

test('the two conventions are exact inverses, which is why neither can be derived', () => {
  const msg = Uint8Array.from([0xaa, 0x3c, 0x69, 0x01]);
  const env = manchester(msg, { polarity: 'ieee' });
  const asIeee = manchesterSlice(env, 0.5, RATE, SYMBOL_US, { polarity: 'ieee' });
  const asThomas = manchesterSlice(env, 0.5, RATE, SYMBOL_US, { polarity: 'thomas' });
  assert.equal(hex(asIeee.bytes), hex(msg));
  for (let i = 0; i < msg.length; i++) {
    assert.equal(asThomas.bytes[i], (~msg[i]) & 0xff, 'byte ' + i);
  }
  assert.equal(asIeee.violations, asThomas.violations,
    'and both are equally valid decodes — the signal cannot tell you which');
});

test('a sync word is what actually settles the polarity', () => {
  // The honest way to choose: decode both ways and see which one contains the sync.
  const msg = Uint8Array.from([0x2d, 0xd4, 0x41, 0x42, 0x43]);
  const env = manchester(msg, { polarity: 'thomas' });
  const syncBits = [...unpackBits(Uint8Array.from([0x2d, 0xd4]), true)];
  const tries = ['ieee', 'thomas'].map((polarity) =>
    ({ polarity, ...manchesterSlice(env, 0.5, RATE, SYMBOL_US, { polarity, syncBits }) }));
  const found = tries.filter((t) => t.syncAt >= 0);
  assert.equal(found.length, 1, 'exactly one convention should contain the sync word');
  assert.equal(found[0].polarity, 'thomas');
  assert.equal(hex(found[0].bytes), '41 42 43', 'and the payload follows the sync');
});

test('it still decodes with noise on the line and a preamble in front', () => {
  const msg = Uint8Array.from([0x5a, 0xa5, 0x3c, 0xc3]);
  const env = manchester(msg, { noise: 0.15, lead: 8 });
  const th = otsuThreshold(env).value;
  const est = estimateManchesterSymbol(env, th, RATE);
  const r = manchesterSlice(env, th, RATE, est.value || SYMBOL_US);
  assert.ok(r.violations <= 1, `noise should not break it, got ${r.violations} violations`);
  // the preamble is alternating, so the message is somewhere after it
  assert.match(hex(r.bytes), /5a a5 3c c3/);
});

test('something that is not Manchester says so instead of guessing', () => {
  // A run-length distribution with five different lengths in it is not a line code
  // that guarantees a transition every symbol.
  const env = new Float32Array(20000);
  let i = 0, k = 0;
  while (i < env.length) {
    const len = [7, 31, 3, 19, 53][k++ % 5];
    for (let j = 0; j < len && i < env.length; j++, i++) env[i] = (k % 2) ? 1 : 0;
  }
  const est = estimateManchesterSymbol(env, 0.5, RATE);
  assert.equal(est.confident, false, 'should not claim a symbol period it cannot see');
});

test('differential decoding inverts differential encoding', () => {
  for (const mode of ['nrz-m', 'nrz-s']) {
    const bits = [1, 0, 0, 1, 1, 1, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1];
    // encode: NRZ-M transitions on a 1, NRZ-S transitions on a 0
    const line = [];
    let level = 0;
    for (const b of bits) {
      const change = mode === 'nrz-m' ? b === 1 : b === 0;
      level = change ? 1 - level : level;
      line.push(level);
    }
    const encoded = packBits(line, { msbFirst: true }).bytes;
    const got = differentialDecode(encoded, mode, { initial: 0 });
    assert.deepEqual([...unpackBits(got.bytes, true)], bits, mode);
  }
});

test('differential decoding does not care which way round the wires are', () => {
  // The whole reason it is used: invert the line and the bits come out the same.
  const line = Uint8Array.from([0b11001010, 0b01110001]);
  const inverted = Uint8Array.from([...line].map((b) => (~b) & 0xff));
  const a = differentialDecode(line, 'nrz-m', { initial: 0 });
  const b = differentialDecode(inverted, 'nrz-m', { initial: 1 });
  assert.deepEqual([...a.bytes], [...b.bytes]);
});

test('bits and bytes survive a round trip in both bit orders', () => {
  const bytes = Uint8Array.from([0x01, 0x80, 0xa5, 0xff, 0x00]);
  for (const msbFirst of [true, false]) {
    const back = packBits(unpackBits(bytes, msbFirst), { msbFirst }).bytes;
    assert.equal(hex(back), hex(bytes), `msbFirst=${msbFirst}`);
  }
});
