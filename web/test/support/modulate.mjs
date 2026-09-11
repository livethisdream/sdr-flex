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
export function hdlcBits(frames, { flags = 32, tail = 8 } = {}) {
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
    for (let i = 0; i < 8; i++) flag();
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
export function afsk1200(frames, { rate = 44_100, seed = 0xa9c5 } = {}) {
  return fsk(hdlcBits(frames), { rate, baud: 1200, mark: 1200, space: 2200, seed });
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
