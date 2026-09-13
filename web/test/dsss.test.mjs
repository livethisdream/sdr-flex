// Direct-sequence spread spectrum: finding the code, and then the bits.
//
// A spread signal is three unknowns — chip rate, chip phase, and which code — and the
// only one of them anybody cares about is the third. So most of this is about the search:
// that it finds the right code, that it says how strongly, that it does not find one in
// something that is not spread, and that it says what it did not try.
//
// The codes are generated rather than tabulated, so the first few tests check the
// generators against the properties that define them. An m-sequence whose off-peak
// autocorrelation is not exactly -1 is not an m-sequence, and a table of numbers cannot
// tell you that about itself.
//
//   node --test web/test/dsss.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockEngine } from '../src/engine.js';
import { Capture } from '../src/capture.js';
import * as dsp from '../src/dsp.js';
import * as codes from '../src/codes.js';
import * as mod from './support/modulate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RATE = 240_000, CENTER = 915_000_000, CHIPS = 60_000;
const TEXT = 'SPREAD PAYLOAD 12345';
const PREAMBLE = [0xaa, 0xaa, 0x2d, 0xd4];

const ascii = (bytes) => Buffer.from(bytes).toString('latin1');

/** The same signal the fixture holds, built here so the DSP tests need no file. */
function signal(opts = {}) {
  const code = codes.byId('m127/0x48');
  const payload = [...PREAMBLE, ...[...TEXT].map((c) => c.charCodeAt(0))];
  return { code, ...mod.dsss(payload, { rate: RATE, chipRate: CHIPS, code: code.chips,
                                        offsetHz: 900, noise: 0.03, seed: 0x5d55, ...opts }) };
}

/** Samples to chips, the way the node does it: timing, then carrier, then integrate. */
function chipsOf(iq, count, rate = RATE) {
  const chip = dsp.estimateChip(iq, count, rate);
  const off = dsp.estimateBpskOffset(iq, count, rate);
  const st = dsp.chipStream(iq, count, chip.samplesPerChip, chip.phase);
  dsp.derotateChips(st, (2 * Math.PI * off.hz) / chip.chipRate);
  return { chip, off, st };
}

function capture() {
  const data = fs.readFileSync(path.join(HERE, '..', '..', 'fixtures', 'dsss-m127', 'capture.sigmf-data'));
  return new Capture({ buffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
                       format: 'cu8', sampleRate: RATE, centerHz: CENTER, label: 'dsss' });
}

async function opened() {
  const e = new MockEngine({ latency: false });
  await e.createSession();
  await e.openCapture(capture());
  return e;
}

// ── the codes themselves ────────────────────────────────────────────────────

test('an m-sequence has an off-peak autocorrelation of exactly -1', () => {
  // The property that defines one, and the reason to generate rather than tabulate: a
  // polynomial that is not primitive fails this immediately and obviously.
  for (const n of [5, 7, 9]) {
    const poly = codes.primitivePolys(n)[0];
    const s = codes.mSequence(n, poly);
    assert.equal(s.length, (1 << n) - 1);
    for (let k = 1; k < s.length; k++) {
      let acc = 0;
      for (let i = 0; i < s.length; i++) acc += s[i] * s[(i + k) % s.length];
      assert.equal(acc, -1, `lag ${k} of the length-${s.length} sequence`);
    }
  }
});

test('the primitive polynomials of each degree are all of them', () => {
  // The counts are Euler's totient of 2^n-1 divided by n, which is a fact about finite
  // fields rather than about this code — so it is a real check and not a restatement.
  const phi = (m) => { let r = m; for (let p = 2; p * p <= m; p++) { if (m % p) continue; while (m % p === 0) m /= p; r -= r / p; } if (m > 1) r -= r / m; return r; };
  for (const n of [5, 6, 7, 8, 9, 10, 11]) {
    assert.equal(codes.primitivePolys(n).length, phi((1 << n) - 1) / n, `degree ${n}`);
  }
});

test('a Gold set is bounded where two m-sequences are not', () => {
  const set = codes.goldSet(7);
  assert.equal(set.codes.length, 129, 'two preferred sequences and 127 products');
  assert.equal(set.length, 127);
  const cross = (a, b) => {
    let peak = 0;
    for (let k = 0; k < a.length; k++) {
      let acc = 0;
      for (let i = 0; i < a.length; i++) acc += a[i] * b[(i + k) % a.length];
      peak = Math.max(peak, Math.abs(acc));
    }
    return peak;
  };
  for (let i = 0; i < 8; i++) {
    for (let j = i + 1; j < 8; j++) {
      assert.ok(cross(set.codes[i], set.codes[j]) <= set.bound,
                `${i} against ${j} exceeds t(7) = ${set.bound}`);
    }
  }
});

test('the catalog has no sequence in it twice', () => {
  // A Gold set is built from two m-sequences and then contains them, so without this the
  // top two hits are routinely the same code under two names — which reads as "no clear
  // winner" when it is the opposite.
  const all = codes.catalog();
  const seen = new Set();
  for (const c of all) {
    const key = `${c.length}:${Array.from(c.chips).join('')}`;
    assert.ok(!seen.has(key), `${c.id} duplicates an earlier entry`);
    seen.add(key);
  }
  assert.ok(all.length > 600, `${all.length} codes`);
});

test('the sweep leaves Walsh out, and says so', () => {
  const { candidates, excluded } = codes.sweep();
  assert.ok(!candidates.some((c) => c.family === 'Walsh'));
  assert.ok(codes.catalog().some((c) => c.family === 'Walsh'), 'still in the catalog');
  assert.equal(excluded[0].family, 'Walsh');
  assert.match(excluded[0].why, /name one to use it/);
  // The claim the exclusion rests on: row i of Walsh-32 repeated *is* row i of Walsh-64.
  const w32 = codes.walsh(32)[13], w64 = codes.walsh(64)[13];
  assert.deepEqual(Array.from(w64), [...w32, ...w32]);
});

// ── the three unknowns, in the order they narrow each other ─────────────────

test('the chip rate comes from the transitions and nothing else', () => {
  const g = signal();
  const chip = dsp.estimateChip(g.iq, g.samples, RATE);
  assert.ok(Math.abs(chip.chipRate - CHIPS) < CHIPS * 0.01, `${chip.chipRate.toFixed(0)} c/s`);
  assert.equal(chip.confident, true);
  assert.ok(chip.phase >= 0 && chip.phase < chip.samplesPerChip);
});

test('the carrier offset is measured by squaring, before any correlating', () => {
  const g = signal({ offsetHz: -2300 });
  const off = dsp.estimateBpskOffset(g.iq, g.samples, RATE);
  assert.ok(Math.abs(off.hz - -2300) < 20, `${off.hz.toFixed(0)} Hz`);
  assert.equal(off.confident, true);
});

test('leaving the offset in is enough to lose the code entirely', () => {
  // Not a hypothetical: this is what the first version did. A correlation across a code
  // period is a coherent integration across it, and 900 Hz at 60 kchip/s is two full
  // rotations over 127 chips — the right code then scores like every wrong one.
  const g = signal();
  const chip = dsp.estimateChip(g.iq, g.samples, RATE);
  const raw = dsp.chipStream(g.iq, g.samples, chip.samplesPerChip, chip.phase);
  const uncorrected = dsp.searchCodes(raw, codes.sweep().candidates);
  assert.notEqual(uncorrected.best.code.id, 'm127/0x48');
  assert.ok(uncorrected.margin < 1.5, `margin ${uncorrected.margin.toFixed(2)} without correction`);

  const { st } = chipsOf(g.iq, g.samples);
  const corrected = dsp.searchCodes(st, codes.sweep().candidates);
  assert.equal(corrected.best.code.id, 'm127/0x48');
  assert.ok(corrected.margin > 2, `margin ${corrected.margin.toFixed(2)} with it`);
});

test('the code is found by name, polynomial and all', () => {
  const g = signal();
  const { st } = chipsOf(g.iq, g.samples);
  const found = dsp.searchCodes(st, codes.sweep().candidates);
  assert.equal(found.best.code.id, 'm127/0x48');
  assert.equal(found.best.code.detail, 'x^7 + x^4 + 1');
  assert.ok(found.best.psr > 8, `peak-to-sidelobe ${found.best.psr.toFixed(1)}`);
  assert.ok(found.tried > 500, `${found.tried} codes tried`);
});

test('a code too long to repeat in the span is not tried, and is named', () => {
  // The best of two thousand noisy numbers is always a big one. A length-2047 code
  // measured over two periods scored 6 against a capture of something else and beat the
  // code that was there — so a candidate has to fit several times over or it is skipped.
  const g = signal();
  const { st } = chipsOf(g.iq, g.samples);
  const short = { re: st.re.subarray(0, 4000), im: st.im.subarray(0, 4000), n: 4000 };
  const found = dsp.searchCodes(short, codes.sweep().candidates);
  const skippedLengths = found.skipped.map((s) => s.length);
  assert.ok(skippedLengths.includes(2047), `skipped ${skippedLengths.join(', ')}`);
  assert.ok(found.skipped.every((s) => s.have < s.need));
  assert.equal(found.best.code.id, 'm127/0x48', 'and the right code still wins');
});

test('a signal that is not spread produces no code', () => {
  const frames = [mod.ax25('N0CALL', 'APRS', 'hello')];
  const audio = mod.afsk1200(frames);
  const iq = new Float32Array(audio.length * 2);
  for (let i = 0; i < audio.length; i++) iq[i * 2] = audio[i];
  const chip = dsp.estimateChip(iq, audio.length, 44_100);
  // Either it finds no chip timing at all, or whatever it finds does not correlate.
  if (chip.samplesPerChip >= 2) {
    const { st } = chipsOf(iq, audio.length, 44_100);
    const found = dsp.searchCodes(st, codes.sweep().candidates);
    assert.ok(found.margin < 2 || found.best.psr < 6,
              `psr ${found.best.psr.toFixed(1)} margin ${found.margin.toFixed(1)} on AFSK`);
  }
});

test('noise is not a spread signal', () => {
  const rand = mod.rng(0x4242);
  const n = 200_000;
  const iq = new Float32Array(n * 2);
  for (let i = 0; i < iq.length; i++) iq[i] = (rand() - 0.5) * 0.5;
  const { st } = chipsOf(iq, n);
  const found = dsp.searchCodes(st, codes.sweep().candidates);
  assert.ok(found.best.psr < 6, `peak-to-sidelobe ${found.best.psr.toFixed(1)} on noise`);
  assert.ok(found.margin < 2, `margin ${found.margin.toFixed(1)} on noise`);
});

// ── and then the bits ───────────────────────────────────────────────────────

test('the bits come back, and so does their inverse', () => {
  const g = signal();
  const { st } = chipsOf(g.iq, g.samples);
  const found = dsp.searchCodes(st, codes.sweep().candidates);
  const normal = dsp.despread(st, found.best.code.chips, found.best.offset);
  assert.equal(normal.bits.length, g.bits.length);
  for (let i = 0; i < g.bits.length; i++) assert.equal(normal.bits[i], g.bits[i], `bit ${i}`);
  assert.ok(normal.eye > 0.9, `eye ${normal.eye.toFixed(3)}`);

  // BPSK does not say which polarity is a one. Both are produced; nothing here decides.
  const flipped = dsp.despread(st, found.best.code.chips, found.best.offset, { invert: true });
  for (let i = 0; i < g.bits.length; i++) assert.equal(flipped.bits[i], 1 - g.bits[i]);
});

test('a chip phase that lands just before zero does not eat the first bit', () => {
  // `atan2` returns the offset nearest zero, and rotating it up into [0, chip) — the
  // obvious way to make a phase positive — starts the stream one chip in. The bits after
  // it still decode perfectly, so the symptom is a clean-looking decode of a message
  // shifted by one bit, with nothing reporting an error.
  const g = signal({ noise: 0.35, seed: 0x9a13 });
  const chip = dsp.estimateChip(g.iq, g.samples, RATE);
  assert.ok(chip.phase < chip.samplesPerChip / 2 + 1e-9,
            `phase ${chip.phase.toFixed(3)} of ${chip.samplesPerChip}`);
  const { st } = chipsOf(g.iq, g.samples);
  const found = dsp.searchCodes(st, codes.sweep().candidates);
  const out = dsp.despread(st, found.best.code.chips, found.best.offset);
  assert.equal(out.bits[0], g.bits[0]);
  assert.equal(out.bits[1], g.bits[1]);
});

test('a Walsh code works when it is named, which is why it stays in the catalog', () => {
  const w = codes.byId('walsh32/13');
  const payload = [...[...'WALSH'].map((c) => c.charCodeAt(0))];
  const g = mod.dsss(payload, { rate: RATE, chipRate: 30_000, code: w.chips, offsetHz: 900 });
  const { st } = chipsOf(g.iq, g.samples);
  const one = dsp.searchCodes(st, [w], { minPeriods: 1 });
  const out = dsp.despread(st, w.chips, one.best.offset);
  const bytes = new Uint8Array(Math.floor(out.bits.length / 8));
  for (let b = 0; b < bytes.length; b++) {
    let v = 0;
    for (let k = 0; k < 8; k++) v = (v << 1) | out.bits[b * 8 + k];
    bytes[b] = v;
  }
  assert.equal(ascii(bytes), 'WALSH');
});

test('how much noise the whole chain survives, stated rather than assumed', () => {
  // Not a pass/fail so much as a recorded limit. The processing gain is 21 dB, which
  // sounds like it should read a signal well under the noise — and it does not, because
  // the *chip timing* is estimated before any despreading and has no gain behind it.
  // Below about 0 dB per chip the timing goes first and everything follows.
  const at = (noise) => {
    const g = signal({ noise });
    const chip = dsp.estimateChip(g.iq, g.samples, RATE);
    if (!(chip.samplesPerChip >= 2)) return false;
    const { st } = chipsOf(g.iq, g.samples);
    const found = dsp.searchCodes(st, codes.sweep().candidates);
    if (found.best.code.id !== 'm127/0x48') return false;
    const out = dsp.despread(st, found.best.code.chips, found.best.offset);
    for (let i = 0; i < g.bits.length; i++) if (out.bits[i] !== g.bits[i]) return false;
    return true;
  };
  assert.equal(at(0.6), true, 'about +6 dB per chip');
  assert.equal(at(1.0), true, 'about +2 dB per chip');
  assert.equal(at(2.0), false, 'about -4 dB per chip: the chip timing goes first');
});

// ── the node ────────────────────────────────────────────────────────────────

test('the node derives all three and shows the evidence for each', async () => {
  const e = await opened();
  const n = await e.addNode({ parent: e.root.id, op: 'core.despread', at: 0.05 });
  const out = await e.sliceBytes(n.id, null, e.duration());
  assert.equal(out.error, undefined, out.error);
  assert.equal(ascii(out.bytes), `\xaa\xaa\x2d\xd4${TEXT}`);

  const live = e.node(n.id);
  assert.ok(Math.abs(live.params.chipRate.value - CHIPS) < 600, `${live.params.chipRate.value} c/s`);
  assert.equal(live.params.chipRate.auto.confident, true);
  assert.match(live.params.chipRate.auto.from, /multiple of 4\.\d+ samples/);

  assert.equal(live.params.code.value, 'm127/0x48');
  assert.equal(live.params.code.auto.confident, true);
  assert.match(live.params.code.auto.from, /x\^7 \+ x\^4 \+ 1/);
  assert.match(live.params.code.auto.from, /codes tried/);

  assert.ok(Math.abs(live.params.offsetHz.value - 900) < 20, `${live.params.offsetHz.value} Hz`);
  assert.equal(live.params.invert.value, 'normal');
  assert.match(live.params.invert.auto.from, /printable/);
});

test('the node says what it did not try', async () => {
  const e = await opened();
  const n = await e.addNode({ parent: e.root.id, op: 'core.despread', at: 0.05 });
  await e.sliceBytes(n.id, null, e.duration());
  const notTried = e.node(n.id).params.code.auto.notTried;
  assert.ok(notTried.some((t) => t.startsWith('Walsh:')), notTried.join(' | '));
});

test('a named code is used rather than searched for', async () => {
  const e = await opened();
  const n = await e.addNode({ parent: e.root.id, op: 'core.despread', at: 0.05 });
  await e.setParam(n.id, 'code', 'm127/0x48');
  const out = await e.sliceBytes(n.id, null, e.duration());
  assert.equal(ascii(out.bytes), `\xaa\xaa\x2d\xd4${TEXT}`);
  assert.match(e.node(n.id).params.code.auto.from, /given rather than searched for/);
});

test('a sync word cuts the preamble off, as it does for every other slicer', async () => {
  const e = await opened();
  const n = await e.addNode({ parent: e.root.id, op: 'core.despread', at: 0.05 });
  await e.setParam(n.id, 'syncHex', '2d d4');
  const out = await e.sliceBytes(n.id, null, e.duration());
  assert.equal(ascii(out.bytes), TEXT);
  assert.equal(out.syncAt, 2);
});

test('the wrong code is a failure that says so, not bytes', async () => {
  const e = await opened();
  const n = await e.addNode({ parent: e.root.id, op: 'core.despread', at: 0.05 });
  await e.setParam(n.id, 'code', 'm127/0x41');
  const out = await e.sliceBytes(n.id, null, e.duration());
  assert.notEqual(ascii(out.bytes), `\xaa\xaa\x2d\xd4${TEXT}`);
  // It still hands back bytes — a correlator always produces *something* — but the
  // evidence for them is the peak, and the peak is flat.
  assert.ok(e.node(n.id).params.code.auto.confident === false,
            'a code that does not correlate is not reported as confident');
});

test('the despread stream feeds the ordinary chain', async () => {
  // The point of ending in bytes rather than in a pane of its own: what comes out is a
  // byte stream like any other, and the framer that reads a slicer's output reads this.
  const e = await opened();
  const n = await e.addNode({ parent: e.root.id, op: 'core.despread', at: 0.05 });
  await e.setParam(n.id, 'syncHex', 'aa aa 2d d4');
  const f = await e.addNode({ parent: n.id, op: 'core.framer', at: 0.05 });
  const out = await e.runRecords(f.id, e.duration());
  assert.equal(out.error, undefined, out.error);
  assert.ok(out.records.length > 0, 'the framer sees a frame');
  // `text` is the hex the frame *is*; `reads` is what it says, and the framer fills it
  // in when a frame is mostly printable. That the despread bytes get there at all is
  // the assertion — the framer needed no knowledge of where they came from.
  assert.ok(out.records.some((r) => (r.reads || '').includes('SPREAD PAYLOAD')),
            out.records.map((r) => r.reads || r.text).join(' | '));
});
