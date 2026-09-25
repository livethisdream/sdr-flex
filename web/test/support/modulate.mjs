// Signals to feed somebody else's decoder.
//
// An adapter is a command line, a format negotiation and a parser, and every one of
// those three can be wrong in a way that looks exactly like "the signal was no good".
// The only way to tell them apart is to hand the program a signal that is known to be
// right and see whether it says the known answer back.
//
// These modulators are that known signal. They are the inverse of the decoders they
// feed — AX.25 framing and NRZI for direwolf and multimon-ng, Bell 202 async serial for
// minimodem, Mode S PPM for dump1090 — which makes the check two-sided: if the
// modulator drifts, the real decoder stops agreeing, and it says so. Nothing here is
// recorded and nothing here is a protocol implementation for the tool to use; it exists
// so the adapters can be tested rather than assumed (ADR-0025).
//
// Deterministic: noise comes from a seeded generator, so a failure is a failure and not
// a bad draw.

import { fft } from '../../src/dsp.js';

/** The same small PRNG the fixtures use, so "with noise" is reproducible. */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// ── AX.25, which is what direwolf and multimon-ng are looking for ───────────

/** CRC-16/X.25: reflected 0x1021, init and final 0xffff. AX.25 calls it the FCS. */
export function fcs(bytes) {
  let reg = 0xffff;
  for (const b of bytes) {
    reg ^= b;
    for (let i = 0; i < 8; i++) reg = (reg & 1) ? (reg >>> 1) ^ 0x8408 : reg >>> 1;
  }
  return (~reg) & 0xffff;
}

function address(call, ssid, last) {
  const out = [];
  const padded = call.toUpperCase().padEnd(6, ' ').slice(0, 6);
  for (const c of padded) out.push((c.charCodeAt(0) << 1) & 0xfe);
  // 0b011SSSS0, with bit 0 set on the final octet of the address field
  out.push(0x60 | ((ssid & 0x0f) << 1) | (last ? 1 : 0));
  return out;
}

/** A UI frame: no connection, no sequence numbers, which is what APRS uses. */
export function ax25(source, dest, info) {
  const body = [
    ...address(dest, 0, false),
    ...address(source, 0, true),
    0x03,                                     // UI
    0xf0,                                     // no layer 3
    ...[...info].map((c) => c.charCodeAt(0) & 0xff),
  ];
  const v = fcs(body);
  return [...body, v & 0xff, (v >> 8) & 0xff];   // FCS goes out low byte first
}

/**
 * HDLC on the wire: flags, bit stuffing, NRZI, least significant bit first.
 *
 * The stuffing and the NRZI are where a hand-rolled AX.25 usually goes wrong, and they
 * are also the part a decoder will silently refuse rather than complain about — a frame
 * with a missed stuffed zero simply never appears.
 */
export function hdlcBits(frames, { flags = 32, tail = 8, between = 8 } = {}) {
  const raw = [];
  const flag = () => { for (const b of [0, 1, 1, 1, 1, 1, 1, 0]) raw.push(b); };
  for (let i = 0; i < flags; i++) flag();
  for (const f of frames) {
    let ones = 0;
    for (const byte of f) {
      for (let k = 0; k < 8; k++) {            // LSB first
        const bit = (byte >> k) & 1;
        raw.push(bit);
        if (bit) { ones++; if (ones === 5) { raw.push(0); ones = 0; } }
        else ones = 0;
      }
    }
    for (let i = 0; i < between; i++) flag();
  }
  for (let i = 0; i < tail; i++) flag();

  // NRZI: a zero is a transition and a one is not. Flags are not stuffed, which is what
  // makes 0x7e findable in a stream that can otherwise contain anything.
  const out = new Uint8Array(raw.length);
  let level = 1;
  raw.forEach((bit, i) => { if (!bit) level ^= 1; out[i] = level; });
  return out;
}

/**
 * Continuous-phase FSK. One tone per bit, and the phase carries across the boundary —
 * a modulator that restarts the phase each symbol produces clicks that a real
 * demodulator reads as noise, which is a confusing way to fail a test.
 */
export function fsk(levels, { rate, baud, mark, space, amplitude = 0.5, seed = 0x1234, noise = 0.003 }) {
  const sps = rate / baud;
  const n = Math.ceil(levels.length * sps) + Math.round(rate * 0.05);
  const out = new Float32Array(n);
  const rand = rng(seed);
  const lead = Math.round(rate * 0.025);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const k = Math.floor((i - lead) / sps);
    const hz = k < 0 || k >= levels.length ? mark : (levels[k] ? mark : space);
    phase += (2 * Math.PI * hz) / rate;
    if (phase > Math.PI * 2) phase -= Math.PI * 2;
    const on = k >= 0 && k < levels.length;
    out[i] = (on ? amplitude : 0) * Math.sin(phase) + (rand() - 0.5) * noise;
  }
  return out;
}

/** AFSK1200: AX.25 over Bell 202 tones, the most common packet signal there is. */
export function afsk1200(frames, { rate = 44_100, seed = 0xa9c5, between = 64 } = {}) {
  // Sixty-four flags between frames rather than the minimum eight. Two AX.25 packets
  // eight flags apart is legal and is nothing like the air, where a busy channel puts
  // seconds between them — and direwolf is a real-time audio program that drops the
  // second frame about a fifth of the time when the machine is loaded and they are back
  // to back. Spacing them is both more realistic and the difference between a test that
  // passes and one that mostly passes.
  return fsk(hdlcBits(frames, { between }), { rate, baud: 1200, mark: 1200, space: 2200, seed });
}

// ── Bell 202 as an async serial line, which is what minimodem reads ─────────

/** 8-N-1: idle mark, a space start bit, eight data bits LSB first, a mark stop bit. */
export function uartLevels(text, { idle = 40, startbits = 1, stopbits = 1 } = {}) {
  const out = [];
  for (let i = 0; i < idle; i++) out.push(1);
  for (const ch of text) {
    for (let i = 0; i < startbits; i++) out.push(0);
    const b = ch.charCodeAt(0) & 0xff;
    for (let k = 0; k < 8; k++) out.push((b >> k) & 1);
    for (let i = 0; i < stopbits; i++) out.push(1);
  }
  for (let i = 0; i < idle; i++) out.push(1);
  return out;
}

export function bell202(text, { rate = 48_000, baud = 1200, mark = 1200, space = 2200, seed = 0x77d2 } = {}) {
  return fsk(uartLevels(text), { rate, baud, mark, space, amplitude: 0.6, seed });
}

// ── Mode S, which is not audio at all ───────────────────────────────────────

const MODES_POLY = 0xfff409;

/** The 24-bit parity dump1090 checks before it will believe a frame. */
export function modesCrc(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 16;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x800000) ? ((crc << 1) ^ MODES_POLY) & 0xffffff : (crc << 1) & 0xffffff;
    }
  }
  return crc;
}

/** DF17 aircraft identification: the extended squitter that carries a callsign. */
export function adsbIdent(icao, callsign) {
  const CHARS = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ#####_###############0123456789######';
  const six = [...callsign.toUpperCase().padEnd(8, ' ').slice(0, 8)]
    .map((c) => { const i = CHARS.indexOf(c === ' ' ? '_' : c); return i < 0 ? 32 : i; });
  const me = [0x20];                          // TC=4 (identification), category 0
  let acc = 0n;
  for (const v of six) acc = (acc << 6n) | BigInt(v);
  for (let i = 5; i >= 0; i--) me.push(Number((acc >> BigInt(i * 8)) & 0xffn));

  const msg = [0x8d, (icao >> 16) & 0xff, (icao >> 8) & 0xff, icao & 0xff, ...me];
  const crc = modesCrc(msg);
  return [...msg, (crc >> 16) & 0xff, (crc >> 8) & 0xff, crc & 0xff];
}

/**
 * Mode S on the air: a four-pulse preamble and then 112 bits of pulse-position, one
 * microsecond each, the pulse in the first half for a one and the second for a zero.
 * Amplitude only — Mode S is on-off keyed, so the signal lives entirely on one axis.
 */
export function modeS(frames, { rate = 2_400_000, gapUs = 150, leadUs = 80, seed = 0x3a71, noise = 0.02 } = {}) {
  const spu = rate / 1e6;
  const totalUs = leadUs * 2 + frames.length * (8 + 112 + gapUs);
  const n = Math.ceil(totalUs * spu);
  const env = new Float32Array(n);
  const rand = rng(seed);
  let t = leadUs;
  for (const f of frames) {
    const pulse = (atUs, widthUs = 0.5) => {
      const a = Math.round((t + atUs) * spu), b = Math.round((t + atUs + widthUs) * spu);
      for (let i = a; i < b && i < n; i++) env[i] = 1;
    };
    for (const p of [0, 1.0, 3.5, 4.5]) pulse(p);
    const bits = [];
    for (const byte of f) for (let k = 7; k >= 0; k--) bits.push((byte >> k) & 1);
    bits.forEach((bit, i) => pulse(8 + i + (bit ? 0 : 0.5)));
    t += 8 + 112 + gapUs;
  }
  const iq = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    iq[i * 2] = env[i] * 0.85 + (rand() - 0.5) * noise;
    iq[i * 2 + 1] = (rand() - 0.5) * noise;
  }
  return iq;
}

// ── two encodings a person hides things in ──────────────────────────────────
//
// Neither of these is a radio protocol; both are audio, and multimon-ng will read
// either. They are here because they are what a signal turns out to be surprisingly
// often once it has been demodulated — a tone pair sequence and a keyed carrier.

const DTMF_TONES = {
  1: [697, 1209], 2: [697, 1336], 3: [697, 1477], A: [697, 1633],
  4: [770, 1209], 5: [770, 1336], 6: [770, 1477], B: [770, 1633],
  7: [852, 1209], 8: [852, 1336], 9: [852, 1477], C: [852, 1633],
  '*': [941, 1209], 0: [941, 1336], '#': [941, 1477], D: [941, 1633],
};

/** Touch tones: two sine waves per digit, silence between. */
export function dtmf(digits, { rate = 22_050, onS = 0.12, offS = 0.06, leadS = 0.1 } = {}) {
  const out = [];
  const silence = (secs) => { for (let i = 0; i < Math.round(secs * rate); i++) out.push(0); };
  silence(leadS);
  for (const ch of String(digits).toUpperCase()) {
    const pair = DTMF_TONES[ch];
    if (!pair) continue;
    for (let i = 0; i < Math.round(onS * rate); i++) {
      out.push(0.4 * (Math.sin((2 * Math.PI * pair[0] * i) / rate) +
                      Math.sin((2 * Math.PI * pair[1] * i) / rate)));
    }
    silence(offS);
  }
  silence(leadS);
  return Float32Array.from(out);
}

const MORSE = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....',
  I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.',
  Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-',
  Y: '-.--', Z: '--..', 0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-',
  5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.', '/': '-..-.', '?': '..--..',
};

/**
 * A keyed tone. The dit length is the standard 1.2/wpm, and the phase runs continuously
 * through the gaps rather than restarting — a keyed carrier that restarts its phase
 * clicks, and a decoder hears the clicks.
 */
export function morse(text, { rate = 22_050, wpm = 15, toneHz = 800, tailS = 0.5 } = {}) {
  const dit = 1.2 / wpm;
  const out = [];
  let phase = 0;
  const key = (secs, on) => {
    for (let i = 0; i < Math.round(secs * rate); i++) {
      phase += (2 * Math.PI * toneHz) / rate;
      out.push(on ? 0.5 * Math.sin(phase) : 0);
    }
  };
  key(0.2, false);
  for (const ch of String(text).toUpperCase()) {
    if (ch === ' ') { key(dit * 7, false); continue; }
    const code = MORSE[ch];
    if (!code) continue;
    for (const el of code) { key(el === '.' ? dit : dit * 3, true); key(dit, false); }
    key(dit * 2, false);                        // three dits between letters, one spent
  }
  key(tailS, false);                            // multimon needs the silence to commit
  return Float32Array.from(out);
}

// ── Baudot, which is what RTTY actually carries ─────────────────────────────

// ITA2 letter case, written the way the bits go out: bit 1 first. So `0b10100` for H
// means the transmitted run is 0,0,1,0,1 — the integer is read least significant bit
// first, which is the order a start bit is followed by.
const ITA2 = {
  A: 0b00011, B: 0b11001, C: 0b01110, D: 0b01001, E: 0b00001, F: 0b01101, G: 0b11010,
  H: 0b10100, I: 0b00110, J: 0b01011, K: 0b01111, L: 0b10010, M: 0b11100, N: 0b01100,
  O: 0b11000, P: 0b10110, Q: 0b10111, R: 0b01010, S: 0b00101, T: 0b10000, U: 0b00111,
  V: 0b11110, W: 0b10011, X: 0b11101, Y: 0b10101, Z: 0b10001, ' ': 0b00100,
};

/**
 * Five-bit Baudot over FSK, 45.45 baud with a 170 Hz shift — the RTTY everybody means.
 *
 * One and a half stop bits is the standard, and a modulator that cannot send half a bit
 * sends two: minimodem's `rtty` mode allows the slack, and rounding the other way puts
 * the next start bit early enough to lose the character after it.
 */
export function baudot(text, { rate = 48_000, baud = 45.45, mark = 2125, space = 2295,
                               idle = 40, seed = 0x8a17 } = {}) {
  const levels = [];
  const push = (v, n = 1) => { for (let i = 0; i < n; i++) levels.push(v); };
  push(1, idle);
  for (const ch of String(text).toUpperCase()) {
    const c = ITA2[ch];
    if (c == null) continue;
    push(0);                                   // start
    for (let k = 0; k < 5; k++) push((c >> k) & 1);
    push(1, 2);                                // stop
  }
  push(1, idle);
  return fsk(levels, { rate, baud, mark, space, amplitude: 0.6, seed });
}

// ── frequency hopping ───────────────────────────────────────────────────────

/**
 * A hop sequence from a maximal-length shift register.
 *
 * Real frequency hoppers do not pick channels at random each time; they walk a sequence
 * both ends already know. An LFSR is the cheapest thing that looks like one — every
 * channel gets visited, the order is not obvious, and it repeats after a known number of
 * hops, which is exactly the structure somebody analyzing the signal is trying to find.
 */
export function hopSequence(n, channels, { seed = 0x1f, taps = 0b100101 } = {}) {
  const out = [];
  let reg = seed & 0x3f || 1;
  for (let i = 0; i < n; i++) {
    out.push(reg % channels);
    const bit = popcount(reg & taps) & 1;
    reg = ((reg >> 1) | (bit << 5)) & 0x3f;
    if (!reg) reg = 1;
  }
  return out;
}

const popcount = (v) => { let c = 0; while (v) { c += v & 1; v >>= 1; } return c; };

/**
 * 2-FSK carried across a set of channels, one dwell at a time.
 *
 * The payload runs straight through the hops rather than restarting on each one, which is
 * what makes de-hopping worth anything: follow the sequence, stitch the dwells together
 * and the original bit stream is back, whole. A modulator that started a fresh packet per
 * dwell would make de-hopping unnecessary and the fixture pointless.
 */
export function fhss(bits, {
  rate = 200_000, channels = 6, spacingHz = 25_000, dwellSymbols = 16,
  baud = 2400, deviationHz = 2400, sequence = null, seed = 0x71c5, noise = 0.01,
} = {}) {
  const sps = rate / baud;
  // A dwell is a whole number of symbols, which is how a real hopper is built: the
  // frequency changes between symbols, not part-way through one. A modulator that hops
  // mid-symbol makes a capture nobody can de-hop and decode, including the person who
  // designed the radio.
  const perDwell = Math.round(dwellSymbols * sps);
  const total = Math.ceil(bits.length * sps);
  const hops = sequence || hopSequence(Math.max(1, Math.ceil(total / perDwell)), channels);
  const n = hops.length * perDwell;
  const iq = new Float32Array(n * 2);
  const rand = rng(seed);

  // Channels centered on zero: index 0 is the lowest, so the middle of the set is the
  // middle of the span, which is where a tuner would sit.
  const offsetOf = (ch) => (ch - (channels - 1) / 2) * spacingHz;

  let phase = 0;                       // the modulation's own phase, continuous throughout
  let mixPhase = 0;
  for (let i = 0; i < n; i++) {
    const k = Math.floor(i / sps);
    const bit = k < bits.length ? bits[k] : 1;
    phase += (2 * Math.PI * (bit ? deviationHz / 2 : -deviationHz / 2)) / rate;
    mixPhase += (2 * Math.PI * offsetOf(hops[Math.floor(i / perDwell)])) / rate;
    if (mixPhase > Math.PI * 2) mixPhase -= Math.PI * 2;
    if (phase > Math.PI * 2) phase -= Math.PI * 2;
    const a = phase + mixPhase;
    iq[i * 2] = 0.6 * Math.cos(a) + (rand() - 0.5) * noise;
    iq[i * 2 + 1] = 0.6 * Math.sin(a) + (rand() - 0.5) * noise;
  }
  return { iq, hops, channels, spacingHz, dwellSymbols, baud,
           dwellS: perDwell / rate, offsetOf, samples: n };
}

// ── OFDM ────────────────────────────────────────────────────────────────────

/**
 * Inverse FFT, from the forward one: conjugate, transform, conjugate, scale.
 *
 * Worth having rather than importing a second transform. The tool ships one FFT and a
 * modulator that needed its own would be a second implementation to keep in step with it.
 */
function ifft(buf, n) {
  for (let i = 0; i < n; i++) buf[i * 2 + 1] = -buf[i * 2 + 1];
  fft(buf);
  for (let i = 0; i < n; i++) { buf[i * 2] /= n; buf[i * 2 + 1] = -buf[i * 2 + 1] / n; }
  return buf;
}

/**
 * OFDM, with a chosen set of subcarriers lit in each symbol.
 *
 * `grid` is one row per symbol and one entry per subcarrier, truthy where that
 * subcarrier carries anything. Which makes the occupancy pattern the message — a
 * time-frequency picture rather than a bit stream — and that is exactly what somebody
 * looking at an OFDM resource grid is trying to read back.
 *
 * QPSK on the lit subcarriers, from a seeded generator, because the *content* is not the
 * point and a fixture whose content changes run to run is not a fixture.
 */
export function ofdm(grid, { rate = 200_000, fftN = 64, cpN = 16, seed = 0x0fd0, noise = 0.004 } = {}) {
  const rand = rng(seed);
  const symbols = grid.length;
  const out = new Float32Array(symbols * (fftN + cpN) * 2);
  const spec = new Float32Array(fftN * 2);
  let w = 0;
  for (const row of grid) {
    spec.fill(0);
    for (let k = 0; k < fftN; k++) {
      if (!row[k]) continue;
      // The grid is in frequency order — index 0 is the most negative subcarrier — which
      // is how a person reads a resource grid and how the analyzer reports one. The FFT
      // wants it wrapped, so this is the shift.
      const bin = (k + fftN / 2) % fftN;
      // QPSK: equal power, one of four phases
      const q = Math.floor(rand() * 4);
      spec[bin * 2] = q < 2 ? Math.SQRT1_2 : -Math.SQRT1_2;
      spec[bin * 2 + 1] = (q % 2) ? Math.SQRT1_2 : -Math.SQRT1_2;
    }
    const time = ifft(Float32Array.from(spec), fftN);
    // The cyclic prefix is the tail of the symbol pasted in front of it. It exists to
    // absorb multipath, and it is also what makes the symbol boundaries findable at all:
    // a copy of the end sitting a symbol-length earlier is a correlation nothing else has.
    for (let i = 0; i < cpN; i++) {
      out[w * 2] = time[(fftN - cpN + i) * 2];
      out[w * 2 + 1] = time[(fftN - cpN + i) * 2 + 1];
      w++;
    }
    for (let i = 0; i < fftN; i++) {
      out[w * 2] = time[i * 2];
      out[w * 2 + 1] = time[i * 2 + 1];
      w++;
    }
  }
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  const g = peak > 0 ? 0.6 / peak : 1;
  for (let i = 0; i < out.length; i++) out[i] = out[i] * g + (rand() - 0.5) * noise;
  return { iq: out, symbols, fftN, cpN, rate,
           symbolS: (fftN + cpN) / rate, spacingHz: rate / fftN };
}

/**
 * A grid with something written on it, in a 5-row font.
 *
 * The battleship board, in other words: the message is which cells are lit, so a fixture
 * whose occupancy spells something is a fixture you can check by looking at it.
 */
export function gridText(text, { fftN = 64, rowsPerLine = 5, blank = 6, pad = 3, wide = 3 } = {}) {
  const FONT = {
    S: ['111', '100', '111', '001', '111'], D: ['110', '101', '101', '101', '110'],
    R: ['111', '101', '111', '110', '101'], F: ['111', '100', '111', '100', '100'],
    L: ['100', '100', '100', '100', '111'], E: ['111', '100', '110', '100', '111'],
    X: ['101', '101', '010', '101', '101'], O: ['111', '101', '101', '101', '111'],
    ' ': ['000', '000', '000', '000', '000'],
  };
  const letters = [...text.toUpperCase()].filter((c) => FONT[c]);
  // Columns run along the subcarriers; rows run in time, one OFDM symbol each — and the
  // two axes have to be scaled together or the letters come out unreadable. A cell is a
  // subcarrier by a symbol and has no natural aspect ratio, so a glyph three subcarriers
  // wide and fifteen symbols tall is legible in a terminal and a smear on a screen.
  const glyph = 3 * wide;
  const step = glyph + wide;
  const width = letters.length * step;
  const left = Math.max(1, Math.floor((fftN - width) / 2));
  const rows = [];
  for (let i = 0; i < blank; i++) rows.push(new Uint8Array(fftN));
  for (let r = 0; r < rowsPerLine; r++) {
    for (let rep = 0; rep < pad; rep++) {
      const row = new Uint8Array(fftN);
      letters.forEach((ch, li) => {
        const bits = FONT[ch][r];
        for (let c = 0; c < 3; c++) {
          if (bits[c] !== '1') continue;
          for (let w = 0; w < wide; w++) {
            const k = left + li * step + c * wide + w;
            if (k < fftN) row[k] = 1;
          }
        }
      });
      rows.push(row);
    }
  }
  for (let i = 0; i < blank; i++) rows.push(new Uint8Array(fftN));
  return rows;
}

// ── a screen leaking ────────────────────────────────────────────────────────

/**
 * A raster-scanned video signal, which is what a monitor radiates.
 *
 * Pixels left to right, lines top to bottom, and blanking intervals where the beam is
 * flying back and nothing is drawn. The blanking is not decoration: it is the only
 * structure in the signal, and it is what makes the line period findable at all.
 */
export function rasterScan(image, {
  width, height, hBlank = 24, vBlank = 8, seed = 0x7ec3, noise = 0.05, amplitude = 0.5,
}) {
  const lineN = width + hBlank;
  const frameLines = height + vBlank;
  const rand = rng(seed);
  const frames = 3;
  const out = new Float32Array(lineN * frameLines * frames);
  let w = 0;
  for (let f = 0; f < frames; f++) {
    for (let y = 0; y < frameLines; y++) {
      for (let x = 0; x < lineN; x++) {
        const on = y < height && x < width ? image[y * width + x] : 0;
        out[w++] = on * amplitude + (rand() - 0.5) * noise;
      }
    }
  }
  return { signal: out, lineN, frameLines, frames, width, height };
}

/**
 * The same raster, as a receiver actually sees one.
 *
 * `rasterScan` is the clean case: one sample per pixel, a whole number of them per line,
 * every frame identical. A leak off a real monitor is none of those, and each difference
 * breaks something different:
 *
 * - **The pixel clock is in the envelope.** What leaks is a harmonic of it, and at any
 *   sane sample rate that harmonic folds back into the passband — on the capture this was
 *   built to imitate, a 25.175 MHz clock at 20 Msps landed at 5.175 MHz, a quarter of the
 *   sample rate, about four samples a cycle. It correlates with itself far better than
 *   the picture correlates with itself, so a period search that does not deal with it
 *   finds the pixel clock instead of the line.
 * - **A line is not a whole number of samples.** Nothing locks the monitor's clock to the
 *   receiver's, so the ratio is whatever it is.
 * - **The frames walk, and they do not walk straight.** Same reason, one level up: the
 *   frame period is fractional too, so the error accumulates and the tenth frame is not
 *   where the first one was. The steady part of that is absorbed by measuring the line
 *   period across a whole frame — it is the same error, seen from further away. What is
 *   left is the part no period can absorb: a clock that is not disciplined to anything
 *   wanders, and `jitter` is how far a frame lands from where the drift said it would.
 *
 * Keep the defaults and the sample rate never appears: everything is in samples per
 * pixel, which is the only ratio that matters.
 */
export function rasterLeak(image, {
  width, height, hBlank = 16, vBlank = 6, samplesPerPixel = 3.77, frames = 10,
  walkPerFrame = 0.6, jitter = 1.5, harmonic = 14, clockDepth = 1, seed = 0x51ea,
  noise = 0.08, amplitude = 0.5, pedestal = 0.15,
}) {
  const linePixels = width + hBlank;
  const framePixels = linePixels * (height + vBlank);
  const frameSamples = framePixels * samplesPerPixel;
  const n = Math.floor(frameSamples * frames);
  const rand = rng(seed);
  const out = new Float32Array(n);

  // Where each frame actually lands: the drift, plus the part of it that is not a drift.
  const offset = new Float32Array(frames + 1);
  for (let f = 0; f <= frames; f++) offset[f] = f * walkPerFrame + (rand() - 0.5) * 2 * jitter;

  for (let i = 0; i < n; i++) {
    // Where this sample falls in the picture, with the frames walking apart as they go.
    const f = Math.min(frames, Math.floor(i / frameSamples));
    const pos = (i - f * frameSamples + offset[f]) / samplesPerPixel;
    const within = ((pos % framePixels) + framePixels) % framePixels;
    const y = Math.floor(within / linePixels);
    const x = within - y * linePixels;
    const on = y < height && x < width ? image[y * width + Math.floor(x)] : 0;

    // The harmonic, phase-locked to the pixel clock because that is what it is a harmonic
    // of, riding on the video the way an AM envelope does. It is above the sample rate and
    // folds back, and that is where the trouble comes from: a line is a whole number of
    // *pixels*, so the harmonic is in step with it in continuous time — but it is a
    // fractional number of *samples*, so at the integer lags a correlation can look at,
    // the folded harmonic is not in step with it at all.
    const clock = 1 + clockDepth * Math.cos(2 * Math.PI * harmonic * pos);
    out[i] = (pedestal + on * amplitude) * clock + (rand() - 0.5) * noise;
  }
  return { signal: out, linePixels, frameLines: height + vBlank, frames, width, height,
           samplesPerLine: linePixels * samplesPerPixel, samplesPerPixel, offset };
}

/** The same five-row font, rendered into a bitmap rather than a resource grid. */
export function bitmapText(text, { width = 96, height = 64, scale = 4 } = {}) {
  const rows = gridText(text, { fftN: width, blank: 0, pad: scale, wide: scale });
  const img = new Float32Array(width * height);
  const top = Math.max(0, Math.floor((height - rows.length) / 2));
  for (let y = 0; y < rows.length && top + y < height; y++) {
    for (let x = 0; x < width; x++) img[(top + y) * width + x] = rows[y][x] ? 1 : 0;
  }
  return img;
}

/** Amplitude modulation onto IQ, which is how the leak reaches a receiver. */
export function amCarrier(signal, { seed = 0x2b1f, noise = 0.01 } = {}) {
  const n = signal.length;
  const iq = new Float32Array(n * 2);
  const rand = rng(seed);
  for (let i = 0; i < n; i++) {
    // A real leak is a harmonic of the pixel clock with the video on its envelope. At
    // baseband that is the envelope itself, which is what an AM detector recovers.
    const a = Math.max(0, signal[i]);
    iq[i * 2] = a + (rand() - 0.5) * noise;
    iq[i * 2 + 1] = (rand() - 0.5) * noise;
  }
  return iq;
}

// ── Direct-sequence spread spectrum ─────────────────────────────────────────

/**
 * BPSK, spread by a code, with a carrier offset on it.
 *
 * The inverse of the despreader, chip for chip, which is the point: a fixture built by
 * the same person who wrote the receiver and from the same assumptions proves that the
 * two agree with each other and nothing else. This one goes further than most here in
 * one respect — it puts a frequency offset on the signal by default, because a receiver
 * that only works at exactly zero offset passes every test and no capture.
 *
 * One code period carries one bit. That is the short-code arrangement, and it is what a
 * challenge means by "spread with an m-sequence": the code is the symbol, its sign is
 * the data, and the processing gain is the code length.
 */
export function dsss(text, {
  rate = 240_000, chipRate = 60_000, code, offsetHz = 900, amplitude = 0.5,
  seed = 0x5d55, noise = 0.02, leadChips = 0, invert = false,
} = {}) {
  if (!code || !code.length) throw new Error('dsss needs a spreading code');
  const bytes = typeof text === 'string' ? [...text].map((c) => c.charCodeAt(0)) : Array.from(text);
  const bits = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);

  const L = code.length;
  const sps = rate / chipRate;
  const chips = new Int8Array(bits.length * L);
  for (let k = 0; k < bits.length; k++) {
    const sign = (bits[k] ? 1 : -1) * (invert ? -1 : 1);
    for (let i = 0; i < L; i++) chips[k * L + i] = sign * code[i];
  }

  const nChips = leadChips + chips.length;
  const n = Math.floor(nChips * sps);
  const iq = new Float32Array(n * 2);
  const rand = rng(seed);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const c = Math.floor(i / sps) - leadChips;
    const v = c >= 0 && c < chips.length ? chips[c] : 0;
    phase += (2 * Math.PI * offsetHz) / rate;
    if (phase > Math.PI * 2) phase -= Math.PI * 2;
    iq[i * 2] = amplitude * v * Math.cos(phase) + (rand() - 0.5) * noise;
    iq[i * 2 + 1] = amplitude * v * Math.sin(phase) + (rand() - 0.5) * noise;
  }
  return { iq, samples: n, chips, bits, bytes, chipRate, sps, code, offsetHz,
           spreadHz: chipRate * 2 };
}

// ── Multitone ───────────────────────────────────────────────────────────────

/**
 * Several narrowband OOK carriers at once, evenly spaced.
 *
 * The inverse of the *tuner* rather than of a decoder, which is why it is here and not
 * beside a modulation: what it exercises is channel separation. Carriers close together
 * are the case where a channel filter either works or quietly hands you the neighbour's
 * bits, and nothing else in this suite puts two signals near enough for that to happen.
 *
 * Each carrier sends its own text behind the same preamble and sync, so a decode that
 * comes back with the wrong index is leakage rather than noise — a distinction worth
 * being able to make.
 */
export function multitone(texts, {
  rate = 200_000, spacingHz = 4_000, baud = 200, amplitude = 0.085,
  taper = 0, seed = 0x70e5, noise = 0.004, syncHex = [0x2d, 0xd4],
} = {}) {
  const sps = rate / baud;
  const trains = texts.map((t) => {
    const bits = [];
    const push = (b) => { for (let k = 7; k >= 0; k--) bits.push((b >> k) & 1); };
    for (let i = 0; i < 24; i++) bits.push(i % 2);
    for (const b of syncHex) push(b);
    for (const c of t) push(c.charCodeAt(0) & 0xff);
    return bits;
  });

  const longest = Math.max(...trains.map((t) => t.length));
  const lead = Math.round(rate * 0.02);
  const n = lead + Math.ceil(longest * sps) + Math.round(rate * 0.02);
  const iq = new Float32Array(n * 2);
  const half = (texts.length - 1) / 2;
  const plan = [];

  for (let k = 0; k < texts.length; k++) {
    const f = (k - half) * spacingHz;
    const t = half === 0 ? 0 : (k - half) / half;
    const a = amplitude * Math.exp(-taper * t * t);
    plan.push({ offsetHz: f, amplitude: a, text: texts[k] });
    const bits = trains[k];
    const w = (2 * Math.PI * f) / rate;
    let c = 1, s = 0;
    const rc = Math.cos(w), rs = Math.sin(w);
    for (let i = 0; i < n; i++) {
      const at = i - lead;
      if (at >= 0 && bits[Math.floor(at / sps)]) { iq[i * 2] += a * c; iq[i * 2 + 1] += a * s; }
      const nc = c * rc - s * rs;
      s = c * rs + s * rc; c = nc;
      if ((i & 4095) === 4095) { const g = Math.hypot(c, s) || 1; c /= g; s /= g; }
    }
  }
  const rand = rng(seed);
  for (let i = 0; i < n * 2; i++) iq[i] += (rand() - 0.5) * noise;
  return { iq, samples: n, plan, rate, spacingHz, baud, symbolUs: 1e6 / baud };
}

// ── RDS ─────────────────────────────────────────────────────────────────────
// The inverse of redsea, written against IEC 62106 rather than against redsea, so the
// two agree only if both are right.
//
// RDS is a 1187.5 bps stream carried on a suppressed 57 kHz subcarrier — the third
// harmonic of the 19 kHz pilot, which is why it sits where it does. The data is
// differentially encoded and then biphase-coded, so the receiver can recover it without
// knowing the subcarrier's absolute phase, and every 26-bit block carries a 10-bit
// checkword that has one of five offset words added to it. Those offsets are the sync:
// there is no preamble anywhere in RDS, and a receiver finds block boundaries by trying
// each offset against the running syndrome until one keeps checking out.

const RDS_POLY = 0x5b9;            // x^10 + x^8 + x^7 + x^5 + x^4 + x^3 + 1
const RDS_BPS = 1187.5;
const RDS_SUBCARRIER = 57_000;
const RDS_PILOT = 19_000;

/** The five offset words. C' is for a block C that carries the PI code again. */
const RDS_OFFSET = { A: 0x0fc, B: 0x198, C: 0x168, Cp: 0x350, D: 0x1b4 };

/** The 10-bit checkword for one 16-bit information word, before the offset is added. */
export function rdsCheckword(info) {
  let reg = 0;
  for (let i = 15; i >= 0; i--) {
    reg = (reg << 1) | ((info >> i) & 1);
    if (reg & 0x400) reg ^= RDS_POLY;
  }
  for (let i = 0; i < 10; i++) {          // then ten zeros, which is the x^10 multiply
    reg <<= 1;
    if (reg & 0x400) reg ^= RDS_POLY;
  }
  return reg & 0x3ff;
}

/** One 26-bit block: sixteen information bits, then the offset checkword. MSB first. */
function rdsBlock(info, offset, out) {
  const check = rdsCheckword(info) ^ RDS_OFFSET[offset];
  for (let i = 15; i >= 0; i--) out.push((info >> i) & 1);
  for (let i = 9; i >= 0; i--) out.push((check >> i) & 1);
}

/** Four blocks, 104 bits, which is one group and 87.6 ms of air. */
function rdsGroup(a, b, c, d, cOffset = 'C') {
  const out = [];
  rdsBlock(a, 'A', out);
  rdsBlock(b, 'B', out);
  rdsBlock(c, cOffset, out);
  rdsBlock(d, 'D', out);
  return out;
}

const rdsChar = (s, i) => (s.charCodeAt(i) || 0x20) & 0xff;

/**
 * The bit stream for a station identifying itself: `ps` in type 0A groups and
 * `radiotext` in type 2A, alternating, for `groups` groups.
 *
 * Two 0A groups for every 2A, as a real encoder sends them. Twelve groups is two full
 * passes of the four name segments, and two passes is the minimum that says anything. The first few groups go to finding block boundaries — RDS has
 * no preamble, so a receiver syncs by trying the offset words against the running
 * syndrome until one keeps checking out — and then a name is held back until the same
 * four segments have arrived twice, because until then there is no way to know it is the
 * whole name. A fixture with one pass in it decodes perfectly and asserts nothing.
 *
 * `ps` is eight characters in four two-character segments; `radiotext` is up to 64 in
 * segments of four, terminated by a carriage return when it is shorter than that. Keep
 * it inside four segments — seventeen characters including the return — or the segment
 * carrying the terminator never gets sent and the text never completes.
 */
export function rdsGroups({ pi = 0x2af1, pty = 10, tp = true, music = true,
                            ps = 'SDR FLEX', radiotext = 'SDR FLEX\r', groups = 16 } = {}) {
  const bits = [];
  const head = (type, version) => (type << 12) | (version << 11) | (tp ? 1 << 10 : 0) | ((pty & 0x1f) << 5);
  const rtSegments = Math.ceil(radiotext.length / 4);

  // Two name groups for every text group, and each type advances its own segment
  // counter. That is what a real encoder does and it is not a detail: the standard asks
  // for the name four times a second, a receiver will not commit to one until it has
  // seen all four segments twice, and an even split between the two group types puts
  // that eight groups further out — most of a second of capture, on a fixture with a
  // size cap measured in tenths.
  let psSeg = 0, rtSeg = 0;
  for (let g = 0; g < groups; g++) {
    if (g % 3 !== 2) {
      const seg = psSeg;
      psSeg = (psSeg + 1) & 3;
      // 0A — program service name, two characters per group.
      //
      // Block C is the alternative-frequency pair, and this station has none: 0xE0 is
      // "zero alternative frequencies follow" and 0xCD is the filler code. Block B's low
      // bits are the segment, bit 3 is music-or-speech and bit 2 is one bit of the
      // decoder-identification word — which stays zero here, because it would be
      // claiming stereo and there is no 38 kHz subcarrier in this signal to back it up.
      bits.push(...rdsGroup(pi, head(0, 0) | (music ? 1 << 3 : 0) | seg, 0xe0cd,
                            (rdsChar(ps, seg * 2) << 8) | rdsChar(ps, seg * 2 + 1)));
    } else {
      // 2A — radiotext, four characters per group across blocks C and D.
      const rseg = rtSeg;
      rtSeg = (rtSeg + 1) % rtSegments;
      bits.push(...rdsGroup(pi, head(2, 0) | rseg,
                            (rdsChar(radiotext, rseg * 4) << 8) | rdsChar(radiotext, rseg * 4 + 1),
                            (rdsChar(radiotext, rseg * 4 + 2) << 8) | rdsChar(radiotext, rseg * 4 + 3)));
    }
  }
  return bits;
}

/**
 * The FM composite, with those bits on the 57 kHz subcarrier.
 *
 * Three things share the baseband and they are the reason a demodulated FM station has
 * to be looked at on the frequency axis (ADR-0036): mono audio at the bottom, the pilot
 * at 19 kHz, and RDS at 57 kHz. There is no 38 kHz subcarrier here — this station is
 * mono, and its own decoder-identification bit says so.
 *
 * Differential encoding first, then biphase, so a receiver that has locked onto the
 * subcarrier 180° out still reads the same bits. The biphase symbol here is square
 * rather than the spec's cosine-rolloff pulse: it puts more energy outside the mask than
 * a transmitter is allowed to, and a decoder has no trouble with the extra.
 */
export function rdsMpx(bits, { rate = 171_000, rds = 0.35, pilot = 0.08, audio = 0.5,
                               toneHz = 1_000, tailS = 0.01, seed = 0x5d5a, noise = 0.002 } = {}) {
  const differential = new Uint8Array(bits.length);
  let prev = 0;
  for (let i = 0; i < bits.length; i++) { prev ^= bits[i]; differential[i] = prev; }

  const n = Math.ceil((bits.length / RDS_BPS) * rate) + Math.round(rate * tailS);
  const out = new Float32Array(n);
  const rand = rng(seed);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const k = Math.floor(t * RDS_BPS);
    let d = 0;
    if (k < differential.length) {
      // biphase: a one is a rising pair, a zero a falling one, over one bit period
      const first = differential[k] ? 1 : -1;
      d = t * RDS_BPS - k < 0.5 ? first : -first;
    }
    out[i] = audio * Math.sin(2 * Math.PI * toneHz * t)
           + pilot * Math.sin(2 * Math.PI * RDS_PILOT * t)
           + rds * d * Math.cos(2 * Math.PI * RDS_SUBCARRIER * t)
           + (rand() - 0.5) * noise;
  }
  return out;
}

/** What a group of this stream occupies on the air, in seconds. */
export const RDS_GROUP_S = 104 / RDS_BPS;

/**
 * An FM broadcast composite in stereo, optionally carrying RDS as well.
 *
 * The encoding, and the one relationship that matters: the pilot is a tone at 19 kHz and
 * the L-R subcarrier is at **exactly twice its phase**, not merely at twice its
 * frequency. `theta` is where t = 0 falls and a receiver never learns it, so it is a
 * parameter here on purpose — a decoder that only works at theta = 0 has locked onto an
 * accident of how the test was written.
 *
 * Levels are the American ones: 45% of the deviation to each of the sum and the
 * difference, 10% to the pilot. `left` and `right` are functions of time in seconds, so a
 * test can put a different tone in each channel and then measure what leaked.
 */
export function fmStereoMpx({ rate = 160_000, seconds = 0.4, theta = 0.7,
                              left = (t) => Math.sin(2 * Math.PI * 400 * t),
                              right = (t) => Math.sin(2 * Math.PI * 3000 * t),
                              pilot = 0.10, audio = 0.45, preemphasisUs = 0,
                              rdsBits = null, rds = 0.05,
                              seed = 0x3e11, noise = 0.002 } = {}) {
  const n = Math.round(rate * seconds);
  const x = new Float32Array(n);
  const rand = rng(seed);
  const w = 2 * Math.PI * 19_000;
  // Pre-emphasis, when asked for, as the one-pole the receiver's de-emphasis undoes.
  // Applied per channel before the matrix, which is where a transmitter applies it.
  const tau = preemphasisUs * 1e-6;
  const lift = tau > 0 ? (v, prev, dt) => v + tau * ((v - prev) / dt) : null;
  let pl = 0, pr = 0;
  const dt = 1 / rate;
  const differential = rdsBits ? new Uint8Array(rdsBits.length) : null;
  if (rdsBits) { let prev = 0; for (let i = 0; i < rdsBits.length; i++) { prev ^= rdsBits[i]; differential[i] = prev; } }

  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let L = left(t), R = right(t);
    if (lift) { const a = lift(L, pl, dt), b = lift(R, pr, dt); pl = L; pr = R; L = a; R = b; }
    const phase = w * t + theta;
    x[i] = audio * ((L + R) / 2)
         + audio * ((L - R) / 2) * Math.cos(2 * phase)      // twice the pilot's phase
         + pilot * Math.cos(phase)
         + (rand() - 0.5) * noise;
    if (differential) {
      const k = Math.floor(t * RDS_BPS);
      if (k < differential.length) {
        const first = differential[k] ? 1 : -1;
        const d = t * RDS_BPS - k < 0.5 ? first : -first;
        // 57 kHz is the pilot tripled, for the same reason 38 kHz is it doubled.
        x[i] += rds * d * Math.cos(3 * phase);
      }
    }
  }
  return x;
}
