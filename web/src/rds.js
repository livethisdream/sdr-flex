// RDS, the bit stream: IEC 62106's blocks, checkwords and groups, written against the
// standard rather than against redsea, so the two agree only if both are right.
//
// RDS is a 1187.5 bps stream carried on a suppressed 57 kHz subcarrier — the third
// harmonic of the 19 kHz pilot, which is why it sits where it does. Every 26-bit block
// carries a 10-bit checkword that has one of five offset words added to it. Those offsets
// are the sync: there is no preamble anywhere in RDS, and a receiver finds block
// boundaries by trying each offset against the running syndrome until one keeps checking
// out. Used by the synthetic scene's broadcast and by the test fixtures.

const RDS_POLY = 0x5b9;            // x^10 + x^8 + x^7 + x^5 + x^4 + x^3 + 1
export const RDS_BPS = 1187.5;
export const RDS_SUBCARRIER = 57_000;
export const RDS_PILOT = 19_000;

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
