// Frames side by side, and which of their bits change.
//
// A protocol nobody documented gives itself away when you line up a few dozen of its
// packets: the preamble and the sync word are the same every time, a device ID is the same
// within one transmitter, a counter climbs, a reading wanders, and the CRC changes whenever
// anything else does. None of that needs the protocol to be known — only the frames, aligned
// at their first bit. This is the part of URH that earns its reputation, and it is a few
// loops over strings of ones and zeros.
//
// Frames are compared within a group of the same length. A nine-byte status message and a
// twelve-byte command are two message types, and diffing one against the other marks every
// bit of both as varying, which says nothing.

export const FIXED = 0, VARIES = 1, MISSING = 2;

/**
 * Frames grouped by length in bits, the largest group first.
 *
 * `frames` are `{ bits }` with `bits` a string of '0' and '1'. Returns
 * `[{ length, members }]`, `members` being indices into `frames` in their original order.
 */
export function groupByLength(frames) {
  const by = new Map();
  frames.forEach((f, i) => {
    const L = f.bits.length;
    if (!by.has(L)) by.set(L, []);
    by.get(L).push(i);
  });
  return [...by.entries()]
    .map(([length, members]) => ({ length, members }))
    .sort((a, b) => b.members.length - a.members.length || b.length - a.length);
}

/**
 * The state of each column across `rows` (strings of '0' and '1'), aligned at bit 0.
 *
 * `unit` is 1 for bits and 8 for bytes. A byte column varies if any bit in it does, and is
 * missing if any row stops before the byte is whole — a trailing part-byte is not a byte.
 */
export function columns(rows, unit = 1) {
  const longest = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const n = unit === 1 ? longest : Math.ceil(longest / unit);
  const out = new Uint8Array(n);
  for (let c = 0; c < n; c++) {
    const from = c * unit, to = from + unit;
    let state = FIXED;
    for (const r of rows) if (r.length < to) { state = MISSING; break; }
    if (state === FIXED && rows.length > 1) {
      outer: for (let b = from; b < to; b++) {
        const first = rows[0][b];
        for (let k = 1; k < rows.length; k++) if (rows[k][b] !== first) { state = VARIES; break outer; }
      }
    }
    out[c] = state;
  }
  return out;
}

/** Runs of one state: `[{ from, to, state }]`, `to` exclusive, in column units. */
export function runs(states) {
  const out = [];
  for (let c = 0; c < states.length; c++) {
    const last = out[out.length - 1];
    if (last && last.state === states[c]) last.to = c + 1;
    else out.push({ from: c, to: c + 1, state: states[c] });
  }
  return out;
}

/**
 * One field — bits `from` to `to`, exclusive — read out of every row, MSB first.
 *
 * `values` holds a BigInt per row, or null where the row is too short to have the field.
 * `step` is the difference between consecutive rows when it is the same nonzero amount
 * every time, which is what a counter looks like; otherwise null. It is worked out
 * modulo the field's width, so a counter that wraps still counts.
 */
export function field(rows, from, to) {
  const width = to - from;
  const values = rows.map((r) => (r.length >= to && width > 0 ? BigInt('0b' + r.slice(from, to)) : null));
  const mod = 1n << BigInt(Math.max(1, width));
  let step = null;
  const have = values.filter((v) => v != null);
  if (have.length >= 3) {
    const d = (have[1] - have[0] + mod) % mod;
    if (d !== 0n && have.every((v, i) => i === 0 || (v - have[i - 1] + mod) % mod === d)) step = d;
  }
  return { width, values, step };
}

/** A field value as hex, padded to the field's width. */
export function hexOf(v, width) {
  return v == null ? '' : v.toString(16).padStart(Math.ceil(width / 4), '0');
}

/** Bytes to a string of '0' and '1', MSB first. */
export function bitsOfBytes(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(2).padStart(8, '0');
  return s;
}
