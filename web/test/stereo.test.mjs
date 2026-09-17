// FM stereo: two channels out of one demodulated stream.
//
//   node --test web/test/stereo.test.mjs
//
// The assertion that carries this file is **separation**, not "audio came out". A stereo
// decoder with an inverted matrix, a half-turn of pilot phase or a swapped pair still
// produces two plausible channels of audio, and every one of those passes a test that
// only asks whether the speaker got something. So the modulator puts a different tone in
// each channel and the tests measure how much of each ended up in the other one.
//
// The modulator is in web/test/support/modulate.mjs and is written from the encoding
// rather than from this decoder: 45% of the deviation to the sum, 45% to the difference
// on a subcarrier at twice the pilot's phase, 10% to the pilot.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MockEngine } from '../src/engine.js';
import { Capture } from '../src/capture.js';
import * as dsp from '../src/dsp.js';
import * as mod from './support/modulate.mjs';

const FS = 160_000, L_HZ = 400, R_HZ = 3_000;

/** Amplitude of one known frequency, by direct correlation, ignoring the filter run-up. */
function amplitudeAt(x, fs, hz, stride = 1, offset = 0, pad = 4000) {
  let re = 0, im = 0, n = 0;
  for (let i = pad; i < x.length / stride - pad; i++) {
    const a = (2 * Math.PI * hz * i) / fs;
    const v = x[i * stride + offset];
    re += v * Math.cos(a); im += v * Math.sin(a); n++;
  }
  return (2 * Math.hypot(re, im)) / (n || 1);
}

const db = (a, b) => 20 * Math.log10((a || 1e-20) / (b || 1e-20));

/** How well the two channels are kept apart, in dB, worst of the two directions. */
function separation(lr, fs) {
  const leftWanted = amplitudeAt(lr, fs, L_HZ, 2, 0);
  const leftLeak = amplitudeAt(lr, fs, R_HZ, 2, 0);
  const rightWanted = amplitudeAt(lr, fs, R_HZ, 2, 1);
  const rightLeak = amplitudeAt(lr, fs, L_HZ, 2, 1);
  return Math.min(db(leftWanted, leftLeak), db(rightWanted, rightLeak));
}

// ── the pilot, which is the evidence ────────────────────────────────────────

test('a stereo composite has a pilot and a mono one does not', () => {
  const stereo = mod.fmStereoMpx({ rate: FS });
  const yes = dsp.estimatePilot(stereo, stereo.length, FS);
  assert.ok(yes.confident, `found: ${yes.snrDb.toFixed(1)} dB`);
  assert.ok(Math.abs(yes.value - 19_000) < 400, `at ${yes.value.toFixed(0)} Hz`);

  // The same station with the subcarrier and the pilot switched off, which is exactly
  // what a mono broadcast is.
  const mono = mod.fmStereoMpx({ rate: FS, pilot: 0, right: (t) => Math.sin(2 * Math.PI * L_HZ * t) });
  const no = dsp.estimatePilot(mono, mono.length, FS);
  assert.ok(!no.confident, `declined: ${no.snrDb.toFixed(1)} dB`);
});

test('a clean tone at some other frequency is not a pilot', () => {
  // The case that made the first version of this estimator wrong. With nothing else
  // transmitting, the median of the whole spectrum is the FFT's own leakage skirt, and
  // any bin at all clears it — so it reported a confident pilot on a mono station
  // carrying one tone. The floor is measured in the 15–23 kHz guard band now.
  const n = Math.round(FS * 0.4);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 800 * i) / FS);
  assert.ok(!dsp.estimatePilot(x, n, FS).confident);
});

// ── the decode ──────────────────────────────────────────────────────────────

test('the channels come apart, and stay apart wherever the phase origin is', () => {
  // theta is where t = 0 falls in the pilot's cycle. A transmitter does not publish it
  // and a receiver cannot measure it, so a decoder that works at one value and not
  // another has locked onto how the test was written rather than onto the signal.
  for (const theta of [0, 0.7, 1.9, -2.6, Math.PI / 2]) {
    const mpx = mod.fmStereoMpx({ rate: FS, theta });
    const { data } = dsp.stereoDecode(mpx, mpx.length, FS, { deemphasisUs: 0 });
    const sep = separation(data, FS);
    assert.ok(sep > 40, `theta ${theta.toFixed(2)}: separation ${sep.toFixed(1)} dB`);
  }
});

test('the quadrature is empty, which is what says the reference is locked', () => {
  const mpx = mod.fmStereoMpx({ rate: FS });
  const { quadRejectionDb } = dsp.stereoDecode(mpx, mpx.length, FS, { deemphasisUs: 0 });
  assert.ok(quadRejectionDb > 25, `${quadRejectionDb.toFixed(1)} dB into the wrong quadrature`);
});

test('the pair is left then right, not right then left', () => {
  // A swap is invisible to a separation measurement, which is why it gets its own test:
  // both channels are still perfectly clean, they are just the wrong way round.
  const mpx = mod.fmStereoMpx({ rate: FS });
  const { data } = dsp.stereoDecode(mpx, mpx.length, FS, { deemphasisUs: 0 });
  assert.ok(db(amplitudeAt(data, FS, L_HZ, 2, 0), amplitudeAt(data, FS, R_HZ, 2, 0)) > 40,
            'the 400 Hz tone is in the left channel');
  assert.ok(db(amplitudeAt(data, FS, R_HZ, 2, 1), amplitudeAt(data, FS, L_HZ, 2, 1)) > 40,
            'and the 3 kHz one is in the right');
});

test('a mono composite decodes to the same thing twice, not to noise', () => {
  // No pilot means no phase reference, and a difference signal invented out of whatever
  // the band-pass found would be two channels of nonsense. Both channels are the sum.
  const same = (t) => Math.sin(2 * Math.PI * 800 * t);
  const mpx = mod.fmStereoMpx({ rate: FS, pilot: 0, left: same, right: same, noise: 0 });
  const { data } = dsp.stereoDecode(mpx, mpx.length, FS, { deemphasisUs: 0 });
  let worst = 0;
  for (let i = 8000; i < mpx.length - 8000; i++) worst = Math.max(worst, Math.abs(data[i * 2] - data[i * 2 + 1]));
  assert.ok(worst < 0.02, `left and right differ by at most ${worst.toFixed(4)}`);
});

test('a stream too narrow to hold 38 kHz says so rather than half-decoding', () => {
  const narrow = 48_000;
  const x = new Float32Array(Math.round(narrow * 0.2));
  for (let i = 0; i < x.length; i++) x[i] = 0.4 * Math.sin((2 * Math.PI * 700 * i) / narrow);
  const r = dsp.stereoDecode(x, x.length, narrow, { deemphasisUs: 0 });
  assert.match(r.note || '', /no 38 kHz/);
  assert.equal(r.data[10], r.data[11], 'and hands back the mono sum on both channels');
});

// ── de-emphasis ─────────────────────────────────────────────────────────────

test('de-emphasis undoes the transmitter, and only inside the stereo decoder', () => {
  // A transmitter lifts treble by 1 + j2*pi*f*tau and the receiver is supposed to put it
  // back. 4 kHz against 400 Hz through a 75 µs curve is about 6 dB of lift.
  const preemph = { rate: FS, preemphasisUs: 75, left: (t) => Math.sin(2 * Math.PI * 400 * t),
                    right: (t) => Math.sin(2 * Math.PI * 4000 * t) };
  const mpx = mod.fmStereoMpx(preemph);
  const flat = dsp.stereoDecode(mpx, mpx.length, FS, { deemphasisUs: 0 }).data;
  const fixed = dsp.stereoDecode(mpx, mpx.length, FS, { deemphasisUs: 75 }).data;

  const hot = db(amplitudeAt(flat, FS, 4000, 2, 1), amplitudeAt(flat, FS, 400, 2, 0));
  const even = db(amplitudeAt(fixed, FS, 4000, 2, 1), amplitudeAt(fixed, FS, 400, 2, 0));
  assert.ok(hot > 4, `without it, 4 kHz is ${hot.toFixed(1)} dB hot`);
  assert.ok(Math.abs(even) < 1.5, `with it, the two tones are level to ${even.toFixed(1)} dB`);
});

test('the discriminator still does not de-emphasize, because redsea reads its output', () => {
  // The rule from ADR-0037, as a test rather than a sentence: de-emphasis belongs to the
  // stereo decoder. On the composite it would take about 27 dB off the 57 kHz subcarrier
  // and silently break the RDS adapter.
  const fs = FS;
  const n = Math.round(fs * 0.2);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.cos((2 * Math.PI * 57_000 * i) / fs);
  const flat = dsp.deemphasis(x, fs, 0);
  const bent = dsp.deemphasis(x, fs, 75e-6);
  let pf = 0, pb = 0;
  for (let i = 2000; i < n; i++) { pf += flat[i] * flat[i]; pb += bent[i] * bent[i]; }
  const lost = 10 * Math.log10(pf / pb);
  assert.ok(lost > 20, `de-emphasis costs the subcarrier ${lost.toFixed(0)} dB, so it cannot go upstream`);
});

// ── the node ────────────────────────────────────────────────────────────────

/** A capture of a wideband FM station in stereo, opened in an engine. */
async function stereoStation({ pilot = 0.10 } = {}) {
  const mpx = mod.fmStereoMpx({ rate: FS, seconds: 0.5, pilot });
  const count = mpx.length;
  const iq = new Float32Array(count * 2);
  let phase = 0;
  for (let i = 0; i < count; i++) {
    phase += (2 * Math.PI * 12_000 * mpx[i]) / FS;
    iq[i * 2] = Math.cos(phase);
    iq[i * 2 + 1] = Math.sin(phase);
  }
  const buf = Buffer.allocUnsafe(count * 2);
  for (let i = 0; i < count * 2; i++) buf[i] = Math.max(0, Math.min(255, Math.round(iq[i] * 127.5 + 127.5)));
  const e = new MockEngine({ latency: false });
  await e.createSession();
  await e.openCapture(new Capture({
    buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    format: 'cu8', sampleRate: FS, centerHz: 98_500_000, label: 'stereo',
  }));
  const tu = await e.addNode({ parent: e.root.id, op: 'core.tuner',
    selection: { f0: 98_500_000 - FS / 2, f1: 98_500_000 + FS / 2 }, at: 0.2 });
  const fm = await e.addNode({ parent: tu.id, op: 'core.fm_discriminator', at: 0.2 });
  return { e, fm };
}

test('the node reports two channels, and says what told it there were two', async () => {
  const { e, fm } = await stereoStation();
  const st = await e.addNode({ parent: fm.id, op: 'core.stereo', at: 0.25 });
  assert.equal(st.out.kind, 'real', 'still a real stream — channels is a parameter of it');
  assert.equal(st.out.channels, 2);
  assert.equal(st.params.decode.value, 'stereo');
  assert.equal(st.params.decode.mode, 'auto');
  assert.equal(st.params.decode.auto.confident, true);
  assert.match(st.params.decode.auto.from, /guard band/, st.params.decode.auto.from);
});

test('on a mono station it declines rather than inventing a difference', async () => {
  const { e, fm } = await stereoStation({ pilot: 0 });
  const st = await e.addNode({ parent: fm.id, op: 'core.stereo', at: 0.25 });
  assert.equal(st.params.decode.value, 'mono', 'and says so as the value, not only in the evidence');
  assert.equal(st.params.decode.auto.confident, false);
  assert.match(st.params.decode.auto.from, /mono/, st.params.decode.auto.from);
});

test('the speaker is handed both channels and everything else the sum', async () => {
  const { e, fm } = await stereoStation();
  const st = await e.addNode({ parent: fm.id, op: 'core.stereo', at: 0.25 });

  const audio = await e.readAudio(st.id, 0.05, 4096);
  assert.equal(audio.channels, 2);
  assert.equal(audio.data.length, 4096 * 2, 'interleaved, like iq');

  // A span is what an adapter and an export read, and neither wants a pair. The sum is
  // not a compromise here: it is the mono signal the encoding was built to preserve.
  const span = await e.readSpan(st.id, 0.05, 0.3);
  assert.equal(span.kind, 'real');
  assert.equal(span.data.length, span.count, 'one channel per sample, downmixed');
});

test('a view can ask for left or right, and gets different signals', async () => {
  const { e, fm } = await stereoStation();
  const st = await e.addNode({ parent: fm.id, op: 'core.stereo', at: 0.25 });
  const at = 0.3, opts = { bins: 1024, window: 'Hann', domain: 'frequency', at };
  const left = e.frame(st.id, { ...opts, channel: 'left' });
  const right = e.frame(st.id, { ...opts, channel: 'right' });
  assert.equal(left.kind, 'spectrum');

  const binOf = (hz) => Math.round((hz * 2 * left.data.length) / left.sampleRate);
  // The left channel carries 400 Hz and the right 3 kHz, so each spectrum should be
  // taller than the other exactly where its own tone is.
  assert.ok(left.data[binOf(L_HZ)] > right.data[binOf(L_HZ)] + 10, 'left is louder at 400 Hz');
  assert.ok(right.data[binOf(R_HZ)] > left.data[binOf(R_HZ)] + 10, 'right is louder at 3 kHz');
});

test('a stereo node still slices, decodes and exports as one channel', async () => {
  // Nothing downstream of a real stream learned about channels, and that is the point of
  // ADR-0037: everything that consumed `real` still consumes this, unchanged.
  const { e, fm } = await stereoStation();
  const st = await e.addNode({ parent: fm.id, op: 'core.stereo', at: 0.25 });
  const ops = await e.palette(st.id);
  const ids = ops.map((o) => o.id);
  for (const want of ['core.pwm_slicer', 'core.audio', 'core.export']) {
    assert.ok(ids.includes(want), `${want} is still offered on a two-channel stream`);
  }
  const listen = await e.addNode({ parent: st.id, op: 'core.audio', at: 0.25 });
  assert.equal(listen.out.kind, 'audio');
});
