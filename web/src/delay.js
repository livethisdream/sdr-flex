// How late a node's samples are, and whether two of them can be lined up.
//
// Every read in this engine is "give me `count` samples ending at `t`", and until now
// that has been close enough to true. It is not exactly true: a channel filter has a
// group delay, so the samples a tuner hands back for a moment are actually from slightly
// before it. In a tree nobody could notice — every read walks one path from one source,
// so everything on screen is shifted by the same amount and the shift is invisible.
//
// A merge is what makes it matter ([ADR-0038](../../docs/adr/0038-a-node-may-have-two-inputs.md)).
// Two branches out of one source go through different filters: the tuner derives its own
// tap count from what folds into the channel (ADR-0017), so a wide branch gets 65 taps
// and a narrow one 255, and at 480 kS/s that is 200 microseconds of difference between
// them. For an incoherent operation that is nothing. For the conjugate product that
// recovers L-R against a doubled pilot, 200 µs at 38 kHz is seven and a half cycles —
// the decode does not degrade, it stops working.
//
// [ADR-0007](../../docs/adr/0007-stream-context-and-provenance.md) called this `t0` and
// specified it in 2023. This is that, computed on the way up rather than stored on the
// way down: a stored field goes stale the moment a tap count changes, and `setParam`
// already propagates one level deep. Walking costs a few map lookups and cannot be wrong.

/**
 * What one node adds, in samples **at its own output rate**. `null` means unknown, which
 * is a real answer and not a failure — ADR-0007 anticipated blocks whose time mapping is
 * not invertible, and refusing to align is better than aligning against a guess.
 *
 * The numbers are measured rather than derived from the code, and `web/test/delay.test.mjs`
 * re-measures them: it puts a smooth pulse through each node and finds where it lands.
 * Reading a filter's length out of the source and halving it is how you get this wrong —
 * the tuner's own delay turns out not to depend on its decimation at all, which is not
 * what the arithmetic looks like it should say.
 */
export function ownDelaySamples(node, parentOut) {
  switch (node.op) {
    case 'core.source':
      return 0;

    // The channel filter, and nothing else. `xlateFilterDecimate` reads
    // `count * decim + taps` input samples for `count` outputs, so output `o` is centred
    // half a filter into a window that is a whole filter longer than it needs to be —
    // and the two cancel down to (taps + 1) / 2 **input** samples, whatever the
    // decimation. Divided by `decim` to express it at this node's own rate.
    case 'core.tuner': {
      const taps = node.params.taps.value;
      const decim = node.params.decim.value;
      return (taps + 1) / 2 / decim;
    }

    // It restitches time out of dwells that were never contiguous, so "the moment these
    // samples are from" has no single answer (ADR-0033). Saying so is the point.
    case 'core.dehop':
      return null;

    // A magnitude is pointwise; the post-detection smoother undoes its own group delay,
    // but it can only undo a whole number of samples. On an even window it overshoots by
    // half of one — three microseconds at 160 kS/s, and forty degrees at 38 kHz.
    case 'core.am_envelope': {
      const w = Math.max(2, Math.round((parentOut.sampleRate) * 40e-6));
      return (w - 1) / 2 - ((w / 2) | 0);
    }

    // The instantaneous frequency is the phase between two samples, so it belongs to the
    // moment between them.
    case 'core.fm_discriminator':
      return 0.5;

    // The Hilbert transformer is 65 taps and the in-phase path is delayed to match it.
    case 'core.ssb':
      return (65 - 1) / 2;

    // A pointwise mix with a rotating phasor.
    case 'core.cw':
      return 0;

    // Every filter in it is centred, on purpose — two of its signals get multiplied
    // together and half a filter of skew between them is a phase error (ADR-0037).
    case 'core.stereo':
      return 0;

    // A merge lines its second input onto its first, so what comes out is on the first
    // one's clock and carries the first one's delay. That is why `delayOf` walking the
    // primary is right for it and not a simplification: after the shift, the second
    // input's delay is gone.
    case 'core.math':
      return 0;

    default:
      // A node that does not carry a stream has no delay worth the word: a slicer emits
      // bits, a decoder emits records, and neither is something anything else lines up
      // against. One that *does* carry a stream and is not in this table is unknown, so
      // that a plugin or an adapter growing a stream output does not get a silent zero.
      return node.out && (node.out.kind === 'iq' || node.out.kind === 'real') ? null : 0;
  }
}

/**
 * How far behind the moment it was asked for this node's samples actually are.
 *
 * `lookup` is `(id) => node`, so this works against either engine's graph — the mock's
 * own, or the client's mirror of the server's.
 */
export function delayOf(node, lookup) {
  let seconds = 0;
  let n = node;
  while (n) {
    const p = n.parent ? lookup(n.parent) : null;
    const own = ownDelaySamples(n, p ? p.out : n.out);
    if (own == null) return { seconds: null, known: false, at: n.id, op: n.op };
    seconds += own / n.out.sampleRate;
    n = p;
  }
  return { seconds, known: true };
}

/**
 * Can these two streams be lined up, and by how much?
 *
 * `shiftSamples` is how far the second has to move to sit on top of the first, at the
 * common rate, positive meaning "later". It is deliberately fractional: half a sample at
 * 160 kS/s is forty degrees at 38 kHz, so rounding it away here would quietly undo the
 * reason this module exists.
 */
export function alignment(a, b, lookup) {
  if (a.out.kind !== b.out.kind) {
    return { ok: false, why: `one is ${a.out.kind} and the other is ${b.out.kind}` };
  }
  const da = delayOf(a, lookup), db = delayOf(b, lookup);
  for (const [d, which] of [[da, a], [db, b]]) {
    if (!d.known) {
      return { ok: false, why: `${d.op} does not report when its samples are from, so ${which.label || which.op} cannot be lined up` };
    }
  }
  const rate = Math.max(a.out.sampleRate, b.out.sampleRate);
  return {
    ok: true,
    rate,
    shiftSamples: (da.seconds - db.seconds) * rate,
    aDelayS: da.seconds,
    bDelayS: db.seconds,
  };
}
