// Baird–Bahn–Collins concurrent codes — a decoder plugin for SDR Flex.
//
// This is a port of the decoder half of gr-bbc, by way of the pure-Python codec in
// the GRCon26 CTF repo, and it exists to prove one thing: a third-party protocol
// decoder can be added to SDR Flex as a file you drop in, with no server, no build,
// and no edit to the tool. Everything below is somebody else's algorithm.
//
// A codeword is a large sparse bit field. Each message bit is fed to a rolling hash
// — the "glowworm" — whose output picks one cell to mark; an n-bit message sets n
// marks. Decoding walks a binary tree: propose a bit, hash the prefix, check whether
// the indicated cell is marked; descend if it is, backtrack if it is not.
//
// Marks are set by any message and cleared by none, so superimposing encoded
// messages is a bitwise OR and every message OR'd in decodes back out. That is the
// "concurrent" part, and it is why `decode` returns a LIST. A caller that reads
// element zero and stops gets one message out of however many were sent.

export const manifest = {
  id: 'ext.bbc',
  name: 'BBC concurrent code',
  group: 'Decode',
  in: 'bytes',
  out: 'events',
  params: [
    // Both are powers of two in every deployment anyone has shipped, so `auto`
    // has a small, honest search space rather than a shrug.
    { id: 'msgBytes', label: 'message', type: 'enum', default: 64,
      values: [16, 32, 64, 128], auto: true },
    { id: 'codBytes', label: 'codeword', type: 'enum', default: 8192,
      values: [1024, 2048, 4096, 8192, 16384, 131072], auto: true },
    { id: 'checkBits', label: 'check bits', type: 'enum', default: 32, values: [0, 16, 32] },
  ],
};

const SEED_ROUNDS = 4096;
const REGISTER_WORDS = 32;

// 64-bit words as high/low 32-bit halves. BigInt would be clearer and is far too
// slow here: the tree walk runs the hash hundreds of thousands of times.
class Glowworm {
  constructor() {
    this.hi = new Int32Array(REGISTER_WORDS);
    this.lo = new Int32Array(REGISTER_WORDS);
    this.n = 0;
    let h = 1;
    for (let i = 0; i < SEED_ROUNDS; i++) h = this.addBit(h & 1);
    this.n = 0;
  }

  /** Upstream's arithmetic exactly, including `b` folding in as a 32-bit mask. */
  addBit(b) {
    const i = ((this.n % REGISTER_WORDS) + REGISTER_WORDS) % REGISTER_WORDS;
    let th = this.hi[i] >>> 0;
    let tl = (this.lo[i] ^ (b ? 0xFFFFFFFF : 0)) >>> 0;

    // t = (t | t>>1) ^ (t<<1)
    const r1h = th >>> 1;
    const r1l = ((tl >>> 1) | (th << 31)) >>> 0;
    const l1h = ((th << 1) | (tl >>> 31)) >>> 0;
    const l1l = (tl << 1) >>> 0;
    th = ((th | r1h) ^ l1h) >>> 0;
    tl = ((tl | r1l) ^ l1l) >>> 0;

    // t ^= t>>4 ^ t>>8 ^ t>>16 ^ t>>32
    const sh = (h, l, k) => (k >= 32 ? [0, h >>> (k - 32)] : [h >>> k, ((l >>> k) | (h << (32 - k))) >>> 0]);
    let ah = th, al = tl;
    for (const k of [4, 8, 16, 32]) {
      const [xh, xl] = sh(th, tl, k);
      ah = (ah ^ xh) >>> 0;
      al = (al ^ xl) >>> 0;
    }

    this.n += 1;
    const j = ((this.n % REGISTER_WORDS) + REGISTER_WORDS) % REGISTER_WORDS;
    this.hi[j] = (this.hi[j] ^ ah) >>> 0;
    this.lo[j] = (this.lo[j] ^ al) >>> 0;
    this._h = this.hi[j] >>> 0;
    this._l = this.lo[j] >>> 0;
    return this._l;                       // callers only ever need it modulo a power of two
  }

  /** XOR is self-inverse, so re-running addBit at the same position undoes it. */
  delBit(b) {
    this.n -= 1;
    this.addBit(b);
    this.n -= 1;
  }
}

/** Mark index for the current hash. Codeword sizes are powers of two in practice. */
function markOf(worm, codBits) {
  if ((codBits & (codBits - 1)) === 0) return worm._l & (codBits - 1);
  // general case: (hi * 2^32 + lo) mod codBits, without BigInt
  return ((((worm._h % codBits) * (4294967296 % codBits)) % codBits) + (worm._l % codBits)) % codBits;
}

/**
 * Walk the tree to exhaustion and return EVERY message in the packet.
 *
 * Returning a list rather than the first hit is the point of the codec and, in the
 * challenge this was written against, the point of the puzzle.
 */
export function decode(bytes, params = {}) {
  const msgBytes = +params.msgBytes || 64;
  const codBytes = +params.codBytes || 8192;
  const checkBits = params.checkBits === undefined ? 32 : +params.checkBits;
  const packet = bytes.length > codBytes ? bytes.subarray(0, codBytes) : bytes;
  if (packet.length < codBytes) {
    throw new Error(`packet is ${packet.length} bytes, this codeword size needs ${codBytes}`);
  }

  const msgBits = msgBytes * 8;
  const codBits = codBytes * 8;
  const totalBits = msgBits + checkBits;
  const worm = new Glowworm();
  const message = new Uint8Array(msgBytes + ((checkBits + 7) >> 3));
  const found = [];
  let n = 0;

  for (;;) {
    if (checkBits && n === msgBits) {
      // The message bits are fixed, so the check bits are too: force them rather
      // than searching a branch that does not exist. A wrong path then fails to
      // find its marks and is pruned instead of multiplying.
      for (let j = 0; j < checkBits; j++) {
        const i = msgBits + j;
        message[i >> 3] &= 0xFF ^ (1 << (i & 7));
      }
    }

    const proposed = (message[n >> 3] >> (n & 7)) & 1;
    worm.addBit(proposed);
    const mark = markOf(worm, codBits);

    if ((packet[mark >> 3] >> (mark & 7)) & 1) {
      if (n < totalBits - 1) {
        n += 1;
        if (n < msgBits) message[n >> 3] &= 0xFF ^ (1 << (n & 7));
        continue;
      }
      found.push(message.slice(0, msgBytes));
      // fall through and keep looking for siblings
    }

    while (n >= msgBits) {
      worm.delBit((message[n >> 3] >> (n & 7)) & 1);
      n -= 1;
    }
    while (n >= 0 && ((message[n >> 3] >> (n & 7)) & 1) === 1) {
      worm.delBit(1);
      message[n >> 3] &= 0xFF ^ (1 << (n & 7));
      n -= 1;
    }
    if (n < 0) break;

    worm.delBit(0);
    message[n >> 3] |= 1 << (n & 7);
  }

  return found.map((m) => {
    let end = m.length;
    while (end > 0 && m[end - 1] === 0) end--;
    let text = '';
    for (let i = 0; i < end; i++) text += String.fromCharCode(m[i]);
    return { text, bytes: end };
  });
}

/** Fraction of cells marked — the thing to look at when nothing decodes. */
export function density(bytes) {
  let marks = 0;
  for (const b of bytes) marks += ((b * 0x08040201) >> 3 & 0x11111111) % 15;
  return marks / (bytes.length * 8);
}
