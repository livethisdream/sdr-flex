// Regenerate every golden capture.
//
// The captures are synthesized rather than recorded, on purpose. ADR-0025 asks every
// fixture for a license and a note saying where the signal came from, and a signal this
// repository drew itself has an unambiguous answer to both — no question about who
// transmitted it, whether it identifies anybody, or whether it can be redistributed.
// The cost is that a synthetic signal is cleaner than the air; that is what the noise
// is for, and it is why real captures are still worth adding later.
//
//   node fixtures/make.mjs
//
// Deterministic: the same seed every time, so a regenerated capture is byte-identical
// and a diff in a fixture means a change in this file rather than a change in luck.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The modulators live with the tests because that is what they are for — they are the
// inverse of somebody else's decoder, written so an adapter can be checked rather than
// assumed. Importing them here rather than copying them means a fixture and the test
// that generated its signal cannot drift apart.
import * as mod from '../web/test/support/modulate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A small deterministic PRNG, so "with noise" does not mean "differently each time". */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/**
 * Written as cu8, which is four times smaller than float and is what a dongle actually
 * produces — a fixture in a format no radio emits is testing a path nobody walks.
 * ADR-0025 caps these at a few hundred kilobytes; float would put both over it.
 */
function writeSigmf(dir, name, samples, { sampleRate, centerHz, note }) {
  fs.mkdirSync(dir, { recursive: true });
  const buf = Buffer.allocUnsafe(samples.length);
  for (let i = 0; i < samples.length; i++) {
    buf[i] = Math.max(0, Math.min(255, Math.round(samples[i] * 127.5 + 127.5)));
  }
  const format = 'cu8';
  fs.writeFileSync(path.join(dir, `${name}.sigmf-data`), buf);
  fs.writeFileSync(path.join(dir, `${name}.sigmf-meta`), JSON.stringify({
    global: {
      'core:datatype': format,
      'core:sample_rate': sampleRate,
      'core:description': note,
      'core:license': 'CC0-1.0',
      'core:recorder': 'sdr-flex fixtures/make.mjs (synthesized, not recorded)',
    },
    captures: [{ 'core:sample_start': 0, 'core:frequency': centerHz }],
    annotations: [],
  }, null, 2) + '\n');
  return buf.length;
}

// ── 1. OOK PWM, for rtl_433 ──────────────────────────────────────────────
// Short pulse is a zero, long pulse is a one, fixed gap between them, a long gap
// between packets. The shape half the ISM band uses, and the shape rtl_433's flex
// decoder describes directly — so the fixture tests the adapter rather than testing
// whether one particular sensor's protocol is implemented.
function ookPwm() {
  const rate = 250_000, centerHz = 433_920_000;
  const rand = rng(0x5eed1);
  const us = (t) => Math.round(t * 1e-6 * rate);
  const SHORT = us(250), LONG = us(500), GAP = us(250), RESET = us(6000);
  const words = [0b101100110011010101100110, 0b110010101010011001011001];

  const out = [];
  const noise = () => (rand() - 0.5) * 0.008;
  const push = (n, amp) => { for (let i = 0; i < n; i++) out.push(amp + noise(), noise()); };
  push(us(10_000), 0);
  for (let rep = 0; rep < 4; rep++) {
    for (const w of words) {
      for (let k = 23; k >= 0; k--) { push((w >> k) & 1 ? LONG : SHORT, 0.45); push(GAP, 0); }
      push(RESET, 0);
    }
  }
  const samples = Float32Array.from(out);
  const dir = path.join(HERE, 'rtl433-ook-pwm');
  const bytes = writeSigmf(dir, 'capture', samples, {
    sampleRate: rate, centerHz,
    note: 'Synthetic OOK PWM: 250 µs pulse = 0, 500 µs = 1, 250 µs gap, 6 ms between ' +
          'packets. Two 24-bit words repeated four times.',
  });
  return { dir, bytes, samples: samples.length / 2, rate };
}

// ── 2. Manchester frames with a CRC, for the native chain ────────────────
function manchesterCrc() {
  const rate = 200_000, centerHz = 433_920_000, symbolUs = 500;
  const rand = rng(0xb0a7);
  const sps = symbolUs * 1e-6 * rate, half = sps / 2;

  const crc16 = (data) => {
    let reg = 0xffff;
    for (const b of data) {
      reg ^= b << 8;
      for (let k = 0; k < 8; k++) reg = (reg & 0x8000) ? ((reg << 1) ^ 0x1021) & 0xffff : (reg << 1) & 0xffff;
    }
    return reg;
  };

  const bits = [];
  const byte = (b) => { for (let k = 7; k >= 0; k--) bits.push((b >> k) & 1); };
  const payloads = [[0x54, 0x45, 0x4d, 0x50, 0x32, 0x31], [0x54, 0x45, 0x4d, 0x50, 0x32, 0x33],
                    [0x48, 0x55, 0x4d, 0x34, 0x37]];
  for (let rep = 0; rep < 3; rep++) {
    for (const p of payloads) {
      for (let i = 0; i < 24; i++) bits.push(i % 2);         // preamble
      byte(0x2d); byte(0xd4);                                 // sync
      for (const b of p) byte(b);
      const v = crc16(Uint8Array.from(p));
      byte((v >> 8) & 0xff); byte(v & 0xff);
      for (let i = 0; i < 40; i++) bits.push(-1);             // dead air
    }
  }

  const n = Math.round(bits.length * sps) + 8000;
  const iq = new Float32Array(n * 2);
  const noise = () => (rand() - 0.5) * 0.04;
  bits.forEach((bit, i) => {
    const first = bit < 0 ? null : (bit ? 0 : 1);
    const second = bit < 0 ? null : (bit ? 1 : 0);
    for (let s = 0; s < half; s++) {
      const k = 4000 + Math.round(i * sps) + s;
      if (k < n) iq[k * 2] = (bit < 0 ? 0.02 : (first ? 0.72 : 0.02));
    }
    for (let s = 0; s < half; s++) {
      const k = 4000 + Math.round(i * sps + half) + s;
      if (k < n) iq[k * 2] = (bit < 0 ? 0.02 : (second ? 0.72 : 0.02));
    }
  });
  for (let i = 0; i < n * 2; i++) iq[i] += noise();

  const dir = path.join(HERE, 'manchester-crc');
  const bytes = writeSigmf(dir, 'capture', iq, {
    sampleRate: rate, centerHz,
    note: 'Synthetic OOK-modulated Manchester, 500 µs symbols, 0x2dd4 sync, ' +
          'CRC-16/CCITT-FALSE, three payloads repeated three times, with dead air between.',
  });
  return { dir, bytes, samples: n, rate };
}

// ── 3. AX.25 over FM, for direwolf and multimon-ng ───────────────────────
// The whole external-decoder path as a person actually walks it: a span of spectrum,
// a tuner, an FM demodulator, and then somebody else's packet decoder on the audio.
// Everything before the adapter is this tool's own code, so the fixture fails if the
// tuner, the decimator or the discriminator regress — and it fails by the decoder
// saying nothing, which is exactly how it would fail for a user.
function aprsAfsk() {
  const rate = 96_000, centerHz = 144_390_000;   // the APRS channel in North America
  const audioRate = 48_000, deviation = 3_000;
  const frames = [
    mod.ax25('N0CALL', 'APRS', '=4903.50N/07201.75W-sdrflex fixture'),
    mod.ax25('KC1ABC', 'APRS', 'sdrflex-ax25-over-fm'),
  ];
  const audio = mod.afsk1200(frames, { rate: audioRate, seed: 0xa9c5 });

  // Narrowband FM: the audio is the instantaneous frequency, so the phase is its
  // integral. Upsampled by holding, which is crude and is fine — the deviation is
  // 3 kHz against a 48 kS/s audio rate, so there is nothing up there to alias.
  const ratio = rate / audioRate;
  const n = Math.floor(audio.length * ratio);
  const iq = new Float32Array(n * 2);
  const rand = rng(0x4f19);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const a = audio[Math.floor(i / ratio)] || 0;
    phase += (2 * Math.PI * deviation * a) / rate;
    if (phase > Math.PI) phase -= 2 * Math.PI;
    if (phase < -Math.PI) phase += 2 * Math.PI;
    iq[i * 2] = 0.6 * Math.cos(phase) + (rand() - 0.5) * 0.01;
    iq[i * 2 + 1] = 0.6 * Math.sin(phase) + (rand() - 0.5) * 0.01;
  }

  const dir = path.join(HERE, 'aprs-afsk1200');
  const bytes = writeSigmf(dir, 'capture', iq, {
    sampleRate: rate, centerHz,
    note: 'Synthetic AX.25 UI frames, Bell 202 AFSK at 1200 baud, narrowband FM with ' +
          '3 kHz deviation. Two frames from different callsigns. Nobody transmitted this.',
  });
  return { dir, bytes, samples: n, rate };
}

// ── 4. Mode S, for dump1090 ──────────────────────────────────────────────
// Not audio and not a tuner: dump1090 takes IQ straight off the root at the rate it
// insists on. The fixture is tiny because Mode S is — 112 bits at a megabit is 112 µs,
// so two frames and the air between them is a few thousand samples.
function adsbModeS() {
  const rate = 2_400_000, centerHz = 1_090_000_000;
  const iq = mod.modeS([mod.adsbIdent(0x4840d6, 'SDRFLEX'), mod.adsbIdent(0xabcdef, 'SDRFLX2')],
                       { rate, seed: 0x3a71 });
  const dir = path.join(HERE, 'adsb-modes');
  const bytes = writeSigmf(dir, 'capture', iq, {
    sampleRate: rate, centerHz,
    note: 'Synthetic Mode S extended squitter (DF17, aircraft identification) for two ' +
          'made-up ICAO addresses, pulse-position modulated at 1 Mbit/s with a correct ' +
          '24-bit parity. Nobody transmitted this and no aircraft exists.',
  });
  return { dir, bytes, samples: iq.length / 2, rate };
}

for (const make of [ookPwm, manchesterCrc, aprsAfsk, adsbModeS]) {
  const r = make();
  console.log(`${path.basename(r.dir).padEnd(20)} ${String(r.samples).padStart(8)} samples  ` +
              `${(r.bytes / 1024).toFixed(0).padStart(4)} kB  ${(r.rate / 1e3).toFixed(0)} kS/s`);
}
