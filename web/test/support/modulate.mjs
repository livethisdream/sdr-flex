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
