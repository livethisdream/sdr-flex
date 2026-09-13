// Spreading codes, generated rather than tabulated.
//
// A direct-sequence signal is unreadable until you have its code, so "which code" is
// the question a spread-spectrum challenge is actually asking. The answer is nearly
// always a *standard* code — an m-sequence, a Gold code, a Walsh row, a Barker word —
// because the interesting part was never the code and everyone involved needs both
// ends to agree on one.
//
// So they are generated here from their definitions rather than pasted in as tables of
// numbers. Three reasons, in the order they matter:
//
//   1. A table can be wrong in a way nobody notices. A generator that produces a
//      sequence of period 2^n-1 is either primitive or it is not, and the test is
//      three lines.
//   2. The generator knows *why* a code is what it is, so a match can report the
//      polynomial rather than a row number — and the polynomial is the answer somebody
//      is writing down.
//   3. There are a lot of them. Every primitive polynomial of degree 11 is 176 codes;
//      nobody is typing those in.
//
// Chips are ±1 in an Int8Array throughout. Nothing here is about a particular radio
// standard: IS-95 happens to use Walsh-64 over a length-32767 m-sequence and GPS
// happens to use Gold-1023, but those are choices made from this menu, not the menu.

/** Parity of the low bits of an integer — the XOR of an LFSR's taps. */
function parity(x) {
  x ^= x >>> 16; x ^= x >>> 8; x ^= x >>> 4; x ^= x >>> 2; x ^= x >>> 1;
  return x & 1;
}

/**
 * How long the LFSR with these taps runs before it repeats.
 *
 * `poly` is a bitmask over delays 1..n: bit `t-1` set means x^t is a term. The x^0 term
 * is implicit (a polynomial without it factors, so it is never primitive) and bit n-1
 * must be set or the degree is not n.
 *
 * A degree-n LFSR has 2^n-1 reachable nonzero states, so a full period means the taps
 * are a primitive polynomial. That is the whole primitivity test, and it is exact.
 */
export function lfsrPeriod(n, poly) {
  const mask = (1 << n) - 1;
  let s = 1;
  for (let i = 0; i < mask; i++) {
    s = ((s << 1) & mask) | parity(s & poly);
    if (s === 1) return i + 1;
  }
  return 0;
}

/**
 * Every primitive polynomial of degree n, as tap masks.
 *
 * Brute force over the 2^(n-1) candidates, each tested by running it. Degree 11 is 1024
 * candidates of up to 2047 steps — a couple of million operations, once, and the result
 * is cached because the answer does not change.
 */
const PRIMITIVE = new Map();
export function primitivePolys(n) {
  if (PRIMITIVE.has(n)) return PRIMITIVE.get(n);
  const full = (1 << n) - 1;
  const out = [];
  const top = 1 << (n - 1);
  for (let m = 0; m < top; m++) {
    const poly = m | top;
    if (lfsrPeriod(n, poly) === full) out.push(poly);
  }
  PRIMITIVE.set(n, out);
  return out;
}

/** The maximal-length sequence those taps generate, as ±1. */
export function mSequence(n, poly) {
  const mask = (1 << n) - 1;
  const len = mask;
  const out = new Int8Array(len);
  let s = 1;
  for (let i = 0; i < len; i++) {
    out[i] = (s >>> (n - 1)) & 1 ? 1 : -1;
    s = ((s << 1) & mask) | parity(s & poly);
  }
  return out;
}

/** Elementwise product — which for ±1 is XOR, written the way correlation reads it. */
function times(a, b) {
  const out = new Int8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] * b[i];
  return out;
}

function rotate(a, k) {
  const n = a.length;
  const out = new Int8Array(n);
  for (let i = 0; i < n; i++) out[i] = a[(i + k) % n];
  return out;
}

/** Peak absolute cyclic cross-correlation of two ±1 sequences of the same length. */
function maxCross(a, b) {
  const n = a.length;
  let peak = 0;
  for (let k = 0; k < n; k++) {
    let acc = 0;
    for (let i = 0; i < n; i++) acc += a[i] * b[(i + k) % n];
    peak = Math.max(peak, Math.abs(acc));
  }
  return peak;
}

/**
 * A Gold set: two m-sequences whose cross-correlation is bounded, plus every
 * elementwise product of one against a rotation of the other.
 *
 * That is 2^n+1 codes from one pair, all the same length, none of them correlating with
 * another by more than t(n) — which is why a system that needs many codes at once uses
 * these and not m-sequences, whose cross-correlation is unbounded in practice.
 *
 * Preferred pairs exist when n is odd or n ≡ 2 (mod 4); for n ≡ 0 (mod 4) there is no
 * decimation that works and this returns null rather than something that looks like a
 * Gold set and is not.
 */
export function goldSet(n) {
  if (n % 4 === 0) return null;
  const k = n % 2 === 1 ? (n + 1) / 2 : (n + 2) / 2;
  const q = (1 << k) + 1;
  const bound = 1 + (1 << Math.floor((n + 2) / 2));   // t(n)
  const len = (1 << n) - 1;

  for (const poly of primitivePolys(n)) {
    const u = mSequence(n, poly);
    const v = new Int8Array(len);
    for (let i = 0; i < len; i++) v[i] = u[(i * q) % len];
    if (maxCross(u, v) > bound) continue;              // not a preferred pair; try the next
    const codes = [u, v];
    for (let s = 0; s < len; s++) codes.push(times(u, rotate(v, s)));
    return { codes, poly, q, bound, length: len };
  }
  return null;
}

/** Rows of the Hadamard matrix of the given order, which must be a power of two. */
export function walsh(order) {
  let h = [[1]];
  while (h.length < order) {
    const n = h.length;
    const next = [];
    for (let r = 0; r < n; r++) next.push([...h[r], ...h[r]]);
    for (let r = 0; r < n; r++) next.push([...h[r], ...h[r].map((x) => -x)]);
    h = next;
  }
  return h.map((row) => Int8Array.from(row));
}

/**
 * Barker words: the only known sequences whose off-peak autocorrelation never exceeds
 * one. Too short to hide anything and too short to separate users, so they are a sync
 * pattern rather than a spreading code — but they are spread the same way, they turn up
 * in front of things, and they cost nothing to try.
 */
export const BARKER = {
  7: Int8Array.from([1, 1, 1, -1, -1, 1, -1]),
  11: Int8Array.from([1, 1, 1, -1, -1, -1, 1, -1, -1, 1, -1]),
  13: Int8Array.from([1, 1, 1, 1, 1, -1, -1, 1, 1, -1, 1, -1, 1]),
};

/** `x^7 + x^3 + 1`, from the tap mask — so a match can be reported as a polynomial. */
export function polyText(n, poly) {
  const terms = [`x^${n}`];
  for (let t = n - 1; t >= 1; t--) if (poly & (1 << (t - 1))) terms.push(t === 1 ? 'x' : `x^${t}`);
  terms.push('1');
  return terms.join(' + ');
}

/**
 * The codes a search will try, and what to call each one when it hits.
 *
 * Every entry carries its family and enough detail to write down: an m-sequence names
 * its polynomial, a Gold code names its index within the set, a Walsh code names its
 * row. "It was code 47" is not an answer anybody can use.
 *
 * The defaults are bounded by what can be searched in about a second, not by what is
 * interesting — the long Gold sets are a thousand codes each and searching them is a
 * deliberate act, so they are reachable by name and not swept.
 */
export function catalog({
  mseq = [5, 6, 7, 8, 9, 10, 11],
  gold = [5, 6, 7],
  walshOrders = [8, 16, 32, 64],
  barker = [7, 11, 13],
  maxLength = Infinity,
} = {}) {
  const out = [];

  for (const n of barker) {
    const chips = BARKER[n];
    if (chips && chips.length <= maxLength) {
      out.push({ id: `barker${n}`, family: 'Barker', name: `Barker ${n}`,
                 length: n, chips, detail: `${n} chips` });
    }
  }

  for (const n of mseq) {
    const len = (1 << n) - 1;
    if (len > maxLength) continue;
    for (const poly of primitivePolys(n)) {
      out.push({
        id: `m${len}/0x${poly.toString(16)}`, family: 'm-sequence',
        name: `m-sequence ${len}`, length: len, chips: mSequence(n, poly),
        detail: polyText(n, poly), poly, n,
      });
    }
  }

  for (const n of gold) {
    const len = (1 << n) - 1;
    if (len > maxLength) continue;
    const set = goldSet(n);
    if (!set) continue;
    set.codes.forEach((chips, i) => {
      out.push({
        id: `gold${len}/${i}`, family: 'Gold', name: `Gold ${len}`,
        length: len, chips, detail: `#${i} of ${set.codes.length}, from ${polyText(n, set.poly)} decimated by ${set.q}`,
        n,
      });
    });
  }

  for (const order of walshOrders) {
    if (order > maxLength) continue;
    // Row 0 is all ones: it spreads nothing and correlates with everything, so a search
    // that included it would report a hit on any signal at all.
    walsh(order).slice(1).forEach((chips, i) => {
      out.push({ id: `walsh${order}/${i + 1}`, family: 'Walsh', name: `Walsh ${order}`,
                 length: order, chips, detail: `row ${i + 1}` });
    });
  }

  return dedupe(out);
}

/**
 * One entry per distinct sequence, keeping the first name it had.
 *
 * A Gold set is built from two m-sequences and then contains them, so `gold127/0` and
 * some `m127/0x…` are bit for bit the same code. Searching both wastes a transform,
 * which does not matter — and then reports them as the top two hits with an identical
 * score, which does: the runner-up is how a search says whether it found one answer or
 * several, and "the same code twice" reads as "no clear winner".
 *
 * Families are listed shortest-name-first above, so the survivor is the one whose name
 * says the most: an m-sequence names its polynomial, where a Gold index names a position
 * in a set somebody would have to reconstruct.
 */
function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    let h = 2166136261;
    for (let i = 0; i < c.chips.length; i++) {
      h ^= c.chips[i] + 1;                // ±1 to 0/2, so the hash sees a difference
      h = Math.imul(h, 16777619);
    }
    const key = `${c.length}:${h >>> 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/** One code by the id `catalog` gave it, without building the rest. */
export function byId(id) {
  const all = catalog({ mseq: [5, 6, 7, 8, 9, 10, 11, 12], gold: [5, 6, 7, 9, 10, 11] });
  return all.find((c) => c.id === id) || null;
}

/**
 * What a search tries, and what it deliberately does not.
 *
 * Walsh rows are in the catalog and out of the sweep, and the reason is a property of
 * Walsh codes rather than a limitation here: H(2n) is built from H(n), so row *i* of
 * Walsh-32 repeated twice **is** row *i* of Walsh-64. A correlator handed a Walsh-32
 * signal matches a Walsh-64 row about as well, and no measurement separates them — which
 * one wins depends on the data bits rather than on the code. A sweep that included them
 * would report a confident-looking wrong row about half the time.
 *
 * That is not a reason to drop them from the catalog. Walsh is how IS-95 separates users,
 * and it works there because it sits *on top of* a PN sequence that supplies the timing —
 * which is to say the ambiguity is resolved by already knowing where the code starts, and
 * a search is exactly the case where you do not. So: name one and it is used, sweep and it
 * is not, and the report says which rather than leaving a silent gap (ADR-0031).
 */
export function sweep(opts = {}) {
  return {
    candidates: catalog({ walshOrders: [], ...opts }),
    excluded: [{
      family: 'Walsh',
      why: 'a Walsh row repeated is another Walsh row, so a search cannot tell which — name one to use it',
    }],
  };
}
