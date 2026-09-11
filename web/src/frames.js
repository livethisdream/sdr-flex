// Frames, and the check that says you got them right.
//
// A byte stream out of a slicer is a guess: a symbol rate, a phase, a polarity and a
// sync word, any of which can be wrong in a way that still produces plausible bytes.
// A CRC is the one thing in the whole chain that answers "is this actually the packet"
// with a yes or a no, which makes it worth rather more here than as a field to display.
//
// So the CRC is *derived* rather than configured. There are a few dozen in common use,
// they are all the same algorithm with different constants, and trying all of them
// against several frames costs microseconds. "Every one of these six frames checks out
// under CRC-16/CCITT-FALSE" is the strongest evidence a decode chain can produce, and
// it is exactly the evidence ADR-0017 asks every derived value to show.

/**
 * The Rocksoft model: every CRC in the catalog below is this function with different
 * constants. Bit by bit rather than table-driven, because frames are tens of bytes and
 * a table per variant per call would cost more than it saves.
 */
export function crc(bytes, { width, poly, init, refIn, refOut, xorOut }) {
  const top = 1 << (width - 1);
  const mask = width === 32 ? 0xffffffff : (1 << width) - 1;
  let reg = init;
  for (let i = 0; i < bytes.length; i++) {
    let b = bytes[i];
    if (refIn) b = REVERSE8[b];
    reg ^= width >= 8 ? (b << (width - 8)) : (b >> (8 - width));
    for (let k = 0; k < 8; k++) {
      reg = (reg & top) ? ((reg << 1) ^ poly) : (reg << 1);
      reg &= mask;
    }
    reg >>>= 0;
  }
  if (refOut) reg = reflect(reg, width);
  return ((reg ^ xorOut) & mask) >>> 0;
}

const REVERSE8 = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let v = i, r = 0;
  for (let k = 0; k < 8; k++) { r = (r << 1) | (v & 1); v >>= 1; }
  REVERSE8[i] = r;
}

function reflect(v, width) {
  let r = 0;
  for (let i = 0; i < width; i++) { r = (r << 1) | ((v >>> i) & 1); }
  return r >>> 0;
}

/**
 * The ones worth trying, which is not all of them.
 *
 * Weighted towards what turns up on the air rather than what is in the standard: the
 * 1-Wire CRC-8 because half the cheap sensors use it, CCITT in both its common
 * flavors, and CRC-32 because anything that came off a computer has one. `check` is
 * the catalog's value for the string "123456789", which is how each of these is
 * verified rather than trusted.
 */
export const CRCS = [
  { id: 'crc8', name: 'CRC-8', width: 8, poly: 0x07, init: 0x00, refIn: false, refOut: false, xorOut: 0x00, check: 0xf4 },
  { id: 'crc8-maxim', name: 'CRC-8/MAXIM (1-Wire)', width: 8, poly: 0x31, init: 0x00, refIn: true, refOut: true, xorOut: 0x00, check: 0xa1 },
  { id: 'crc8-rohc', name: 'CRC-8/ROHC', width: 8, poly: 0x07, init: 0xff, refIn: true, refOut: true, xorOut: 0x00, check: 0xd0 },
  { id: 'crc16-ccitt-false', name: 'CRC-16/CCITT-FALSE', width: 16, poly: 0x1021, init: 0xffff, refIn: false, refOut: false, xorOut: 0x0000, check: 0x29b1 },
  { id: 'crc16-xmodem', name: 'CRC-16/XMODEM', width: 16, poly: 0x1021, init: 0x0000, refIn: false, refOut: false, xorOut: 0x0000, check: 0x31c3 },
  { id: 'crc16-kermit', name: 'CRC-16/KERMIT', width: 16, poly: 0x1021, init: 0x0000, refIn: true, refOut: true, xorOut: 0x0000, check: 0x2189 },
  { id: 'crc16-arc', name: 'CRC-16/ARC', width: 16, poly: 0x8005, init: 0x0000, refIn: true, refOut: true, xorOut: 0x0000, check: 0xbb3d },
  { id: 'crc16-modbus', name: 'CRC-16/MODBUS', width: 16, poly: 0x8005, init: 0xffff, refIn: true, refOut: true, xorOut: 0x0000, check: 0x4b37 },
  { id: 'crc32', name: 'CRC-32', width: 32, poly: 0x04c11db7, init: 0xffffffff, refIn: true, refOut: true, xorOut: 0xffffffff, check: 0xcbf43926 },
];

export function crcById(id) { return CRCS.find((c) => c.id === id) || null; }

/** Read a big- or little-endian integer of `width` bits off the end of a frame. */
function trailing(frame, width, littleEndian) {
  const n = width / 8;
  if (frame.length < n) return null;
  let v = 0;
  for (let i = 0; i < n; i++) {
    const byte = frame[frame.length - n + (littleEndian ? n - 1 - i : i)];
    v = ((v << 8) | byte) >>> 0;
  }
  return v >>> 0;
}

/**
 * Which CRC, if any, validates these frames.
 *
 * Every variant, both byte orders, checked against every frame — and the answer only
 * counts if it validates *all* of them. One frame agreeing with a CRC-8 is a one in
 * 256 coincidence and will happen constantly; six frames agreeing is not a
 * coincidence, which is why the count is reported alongside.
 */
export function detectCrc(frames, { searchLength = true, maxTrim = 64 } = {}) {
  const usable = frames.filter((f) => f.length >= 3);
  if (usable.length === 0) return null;

  // First the straightforward reading: the CRC is the last bytes of the frame exactly
  // as it was cut. True whenever frames are back to back.
  for (const spec of CRCS) {
    for (const littleEndian of [false, true]) {
      const n = spec.width / 8;
      let all = true;
      for (const f of usable) {
        if (f.length <= n) { all = false; break; }
        if (crc(f.subarray(0, f.length - n), spec) !== trailing(f, spec.width, littleEndian)) { all = false; break; }
      }
      if (all) {
        return {
          ...spec, littleEndian, frames: usable.length, lengths: usable.map((f) => f.length),
          from: `all ${usable.length} frame${usable.length === 1 ? '' : 's'} check out under ` +
                `${spec.name}${spec.width > 8 ? (littleEndian ? ', little-endian' : ', big-endian') : ''}`,
          confident: usable.length > 1,
        };
      }
    }
  }
  if (!searchLength) return null;

  // Then the reading that is true of real captures: a frame ends where it ends, and
  // what follows it is dead air until the next one. So the CRC is at *some* length,
  // and finding that length is most of what framing a new protocol consists of.
  //
  // Only for sixteen bits and wider. Trying forty lengths against an eight-bit CRC is
  // forty chances in 256 of a coincidence per frame, which finds a CRC in noise most
  // of the time — the search is only worth having where a false positive is a one in
  // a few thousand event rather than a one in six one.
  for (const spec of CRCS) {
    if (spec.width < 16) continue;
    for (const littleEndian of [false, true]) {
      const n = spec.width / 8;
      const lengths = [];
      let all = true;
      for (const f of usable) {
        let found = -1;
        // Shortest first, not longest.
        //
        // Most of these CRCs have the property that appending the correct remainder
        // makes the whole thing check out as zero — so a frame followed by two null
        // bytes of dead air validates at its real length *and* two bytes longer, and
        // longer still for every pair of nulls after that. Every one of those is a
        // true validation and only the shortest is the frame.
        const floor = Math.max(n + 1, f.length - maxTrim);
        for (let len = floor; len <= f.length; len++) {
          const body = f.subarray(0, len - n);
          if (crc(body, spec) === trailing(f.subarray(0, len), spec.width, littleEndian)) { found = len; break; }
        }
        if (found < 0) { all = false; break; }
        lengths.push(found);
      }
      if (all) {
        return {
          ...spec, littleEndian, frames: usable.length, lengths, trimmed: true,
          from: `every one of ${usable.length} frames ends in a valid ` +
                `${spec.name}${littleEndian ? ', little-endian' : ', big-endian'} — ` +
                `at ${lengths.join(', ')} byte${lengths.length === 1 ? '' : 's'}, ` +
                'with dead air after it',
          confident: usable.length > 1,
        };
      }
    }
  }
  return null;
}

/**
 * Check one frame against a chosen CRC, for display.
 *
 * `length` is where the frame actually ends, if that was worked out — everything past
 * it is dead air and is reported as such rather than silently included in the body.
 */
export function checkFrame(frame, spec, length = 0) {
  if (!spec) return { checked: false };
  const n = spec.width / 8;
  const end = length > 0 ? Math.min(length, frame.length) : frame.length;
  if (end <= n) return { checked: false };
  const want = trailing(frame.subarray(0, end), spec.width, spec.littleEndian);
  const got = crc(frame.subarray(0, end - n), spec);
  return { checked: true, ok: got === want, want, got, width: spec.width,
           bodyEnd: end - n, tail: frame.length - end };
}

/**
 * Split a byte stream into frames on a sync word.
 *
 * Everything about framing that can be derived is derived from the sync word alone:
 * where the frames start, and therefore how long they are. A fixed length is offered
 * because plenty of protocols have one, but the default is "to the next sync", which
 * needs nothing told to it and is right surprisingly often.
 */
export function findFrames(bytes, { syncBytes, frameBytes = 0, maxFrames = 512, msbFirst = true } = {}) {
  if (!syncBytes || !syncBytes.length) {
    // No sync word: the whole thing is one frame. Still worth checking a CRC against.
    return bytes.length ? [{ at: 0, bit: 0, bytes }] : [];
  }

  // Searched bit by bit, not byte by byte.
  //
  // A byte-aligned search only finds the frames that happen to start on a byte
  // boundary, and nothing makes them. A packet repeating every few hundred
  // milliseconds lands wherever the gap between them lands, so the second frame is
  // almost never a whole number of bytes after the first — and the symptom is a framer
  // that finds exactly one frame in a capture full of them and gives no hint why.
  //
  // Each frame is then re-packed from its own bit offset, which is the only way the
  // bytes after the sync word are the bytes the transmitter sent.
  const bits = bitsOf(bytes, msbFirst);
  const sync = bitsOf(syncBytes, msbFirst);

  const starts = [];
  outer: for (let i = 0; i + sync.length <= bits.length; i++) {
    for (let j = 0; j < sync.length; j++) if (bits[i + j] !== sync[j]) continue outer;
    starts.push(i);
    i += sync.length - 1;
    if (starts.length >= maxFrames) break;
  }

  const out = [];
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k] + sync.length;
    const limit = k + 1 < starts.length ? starts[k + 1] : bits.length;
    const to = frameBytes > 0 ? Math.min(limit, from + frameBytes * 8) : limit;
    const n = Math.floor((to - from) / 8);
    if (n <= 0) continue;
    const frame = new Uint8Array(n);
    for (let b = 0; b < n; b++) {
      let v = 0;
      for (let q = 0; q < 8; q++) {
        const bit = bits[from + b * 8 + q];
        v |= msbFirst ? (bit << (7 - q)) : (bit << q);
      }
      frame[b] = v;
    }
    out.push({ at: starts[k] >> 3, bit: starts[k], bytes: frame });
  }
  return out;
}

function bitsOf(bytes, msbFirst) {
  const out = new Uint8Array(bytes.length * 8);
  for (let i = 0; i < bytes.length; i++) {
    for (let k = 0; k < 8; k++) out[i * 8 + k] = msbFirst ? (bytes[i] >> (7 - k)) & 1 : (bytes[i] >> k) & 1;
  }
  return out;
}

/** "a1 b2" / "0xA1B2" / "a1-b2" → bytes. What someone pastes out of a datasheet. */
export function bytesOfHex(hex) {
  const clean = String(hex || '').replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '');
  const n = Math.floor(clean.length / 2);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}
