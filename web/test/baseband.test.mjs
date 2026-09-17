// The baseband spectrum: reading a demodulated stream on the frequency axis.
//
// A detector's output is a signal in its own right, and for wideband FM it is the one
// that matters — the composite carries mono audio at the bottom, a 19 kHz pilot, L-R on
// a 38 kHz subcarrier and RDS at 57 kHz, and none of that is visible in a waveform. The
// discriminator was never throwing it away; there was simply nowhere to look at it.
//
//   node --test web/test/baseband.test.mjs
//
// Two things are pinned here. The scale, because a spectrum whose decibels mean
// something different from the IQ view's is a spectrum you cannot compare to anything.
// And the frame contract, because the client asks for one axis or the other by an option
// and gets the wrong picture, silently, if that option stops being read.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MockEngine, demodulate } from '../src/engine.js';
import { Capture } from '../src/capture.js';
import * as dsp from '../src/dsp.js';

const RATE = 240_000, CENTER = 98_500_000;

/** The strongest bin, and what frequency it stands for. */
function peak(sp, fs) {
  let at = 0;
  for (let i = 1; i < sp.length; i++) if (sp[i] > sp[at]) at = i;
  // `bins` outputs cover 0 to fs/2, so a bin is fs / (2 * bins) wide
  return { bin: at, hz: (at * fs) / (2 * sp.length), db: sp[at] };
}

/** How high one frequency stands above the median of everything else. */
function prominenceDb(sp, fs, hz, guardBins = 3) {
  const bin = Math.round((hz * 2 * sp.length) / fs);
  const rest = [];
  for (let i = 0; i < sp.length; i++) if (Math.abs(i - bin) > guardBins) rest.push(sp[i]);
  rest.sort((a, b) => a - b);
  return sp[bin] - rest[Math.floor(rest.length / 2)];
}

// ── the scale ───────────────────────────────────────────────────────────────

test('a full-scale sine reads 0 dBFS, the same as it would in the IQ view', () => {
  const bins = 512, n = bins * 2;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * 40 * i) / n);   // bin 40, exactly
  const sp = dsp.realSpectrum(x, bins, 'Rect');
  const p = peak(sp, RATE);
  assert.equal(p.bin, 40, 'the tone lands in its own bin');
  assert.ok(Math.abs(p.db) < 0.1, `full scale is 0 dBFS, got ${p.db.toFixed(2)}`);
});

test('DC is not doubled along with the bins that come in pairs', () => {
  const bins = 256;
  const x = new Float32Array(bins * 2).fill(1);
  const sp = dsp.realSpectrum(x, bins, 'Rect');
  assert.ok(Math.abs(sp[0]) < 0.1, `a constant of 1.0 is 0 dBFS, got ${sp[0].toFixed(2)}`);
});

test('the mirrored half is folded in rather than shown twice', () => {
  const bins = 512, n = bins * 2;
  const x = new Float32Array(n);
  const iq = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    x[i] = Math.sin((2 * Math.PI * 40 * i) / n);
    iq[i * 2] = x[i];                       // the same signal, with no imaginary part
  }
  const real = dsp.realSpectrum(x, bins, 'Rect');
  const two = dsp.spectrum(iq, n, 'Rect');
  // Two-sided, a real tone splits its energy between +f and -f and each half reads
  // 6 dB down. One-sided, there is one peak and it reads full scale.
  assert.ok(Math.abs(two[n / 2 + 40] + 6.02) < 0.1, `the two-sided half is 6 dB down, got ${two[n / 2 + 40].toFixed(2)}`);
  assert.ok(Math.abs(real[40] - (two[n / 2 + 40] + 6.02)) < 0.1, 'folding the mirror back in accounts for exactly that 6 dB');
});

test('bins is the number of columns on screen, in either domain', () => {
  for (const bins of [256, 1024, 2048]) {
    assert.equal(dsp.realSpectrum(new Float32Array(bins * 2), bins, 'Hann').length, bins);
  }
});

// ── what it is for ──────────────────────────────────────────────────────────

/**
 * Wideband FM carrying a composite: a tone in the mono band, the 19 kHz pilot, and a
 * subcarrier where RDS lives. Modulated for real — integrate the baseband and use it as
 * the phase — so the discriminator has to actually work for the peaks to come back.
 */
function wbfm(seconds, { deviationHz = 60_000 } = {}) {
  const count = Math.floor(RATE * seconds);
  const iq = new Float32Array(count * 2);
  let phase = 0;
  for (let i = 0; i < count; i++) {
    const t = i / RATE;
    const mpx = 0.55 * Math.sin(2 * Math.PI * 1_000 * t)      // mono audio
              + 0.10 * Math.sin(2 * Math.PI * 19_000 * t)     // the pilot
              + 0.05 * Math.sin(2 * Math.PI * 57_000 * t);    // where RDS rides
    phase += (2 * Math.PI * deviationHz * mpx) / RATE;
    iq[i * 2] = Math.cos(phase);
    iq[i * 2 + 1] = Math.sin(phase);
  }
  return { iq, count };
}

test('the pilot and the RDS subcarrier are there to be found', () => {
  const { iq, count } = wbfm(0.05);
  const audio = demodulate('core.fm_discriminator', iq, count, RATE).data;
  const bins = 2048;
  const sp = dsp.realSpectrum(audio, bins, 'Hann');
  for (const [hz, what] of [[1_000, 'the mono audio'], [19_000, 'the pilot'], [57_000, 'the RDS subcarrier']]) {
    const over = prominenceDb(sp, RATE, hz, 6);
    assert.ok(over > 20, `${what} at ${hz / 1e3} kHz stands ${over.toFixed(1)} dB over the floor`);
  }
  // and the thing the waveform view could never tell you: nothing at 38 kHz, so this
  // station is mono. A stereo one would put L-R there.
  assert.ok(prominenceDb(sp, RATE, 38_000, 6) < 10, 'no stereo subcarrier, because this signal has none');
});

// ── the frame contract ──────────────────────────────────────────────────────

async function fmNode() {
  const { iq, count } = wbfm(0.4);
  const buf = Buffer.allocUnsafe(count * 2);
  for (let i = 0; i < count * 2; i++) {
    buf[i] = Math.max(0, Math.min(255, Math.round(iq[i] * 127.5 + 127.5)));
  }
  const e = new MockEngine({ latency: false });
  await e.createSession();
  await e.openCapture(new Capture({
    buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    format: 'cu8', sampleRate: RATE, centerHz: CENTER, label: 'wbfm',
  }));
  // The whole composite, not just the audio: a box narrow enough to hear is a box that
  // has already filtered the subcarriers away.
  const tu = await e.addNode({ parent: e.root.id, op: 'core.tuner',
    selection: { f0: CENTER - 100_000, f1: CENTER + 100_000 }, at: 0.1 });
  const fm = await e.addNode({ parent: tu.id, op: 'core.fm_discriminator', at: 0.1 });
  return { e, fm };
}

test('a real node answers the waveform unless the frequency axis is asked for', async () => {
  const { e, fm } = await fmNode();
  assert.equal(e.frame(fm.id, { spanS: 0.02 }).kind, 'timeseries');
  assert.equal(e.frame(fm.id, { bins: 512, domain: 'time' }).kind, 'timeseries');
});

test('asked for it, the same node answers a one-sided spectrum', async () => {
  const { e, fm } = await fmNode();
  const f = e.frame(fm.id, { bins: 1024, window: 'Hann', domain: 'frequency', at: 0.2 });
  assert.equal(f.kind, 'spectrum');
  assert.equal(f.baseband, true, 'the client has to know this axis starts at DC');
  assert.equal(f.data.length, 1024);
  assert.equal(f.sampleRate, e.node(fm.id).out.sampleRate);
  assert.equal(f.centerHz, CENTER, 'where the samples came from is carried through (ADR-0007)');
  // Same bins, same shared pane: the pilot has to land where the axis says it does.
  assert.ok(prominenceDb(f.data, f.sampleRate, 19_000, 6) > 15, 'the pilot is where the axis puts it');
});

test('the discriminator does not narrow the stream it hands on', async () => {
  const { e, fm } = await fmNode();
  const n = e.node(fm.id);
  assert.equal(n.out.sampleRate, e.node(n.parent).out.sampleRate,
    'no decimation and no post-detection filter, which is why 57 kHz survives at all');
  assert.ok(n.out.sampleRate / 2 > 57_000, 'a 200 kHz box leaves RDS inside the one-sided span');
});
