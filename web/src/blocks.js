// How much of the capture a decoder that is not streamed reads at a time.
//
// Most read fixed blocks: 5 s, disjoint, so nothing is ever read twice. A decoder that
// reads a word by the words around it (Speech) asks for a longer block and an overlap,
// and is read differently: each window starts where the last record it kept ended, and
// runs a block plus the overlap. What ends inside the overlap is not kept, since the
// window's edge may have cut it; the next window starts before it and reads it whole.
// So a window never starts in the middle of a sentence, and never ends in one that is
// kept.

/** How many fixed blocks are wholly behind the playhead. */
export function blocksDone(now, d, seconds) {
  if (isFinite(d) && now >= d - 0.05) return Math.ceil(d / seconds);
  return Math.max(0, Math.floor(now / seconds));
}

/** The window to read from `from`, or null while the playhead has not passed its end. */
export function nextWindow(from, now, d, seconds, overlap) {
  if (isFinite(d) && from >= d - 0.05) return null;
  const w1 = isFinite(d) ? Math.min(from + seconds + overlap, d) : from + seconds + overlap;
  const atEnd = isFinite(d) && w1 >= d - 0.05;
  if (now < w1 - (atEnd ? 0.05 : 0)) return null;
  return { w0: from, w1, atEnd };
}

/**
 * Which of a window's records to keep, timed in seconds from the window's start, and
 * where the next window starts. Records carry `fromS` and `toS`, seconds into the window.
 * Those that end in the overlap are left for the next window, unless that would leave
 * this one with nothing, in which case it moves on by a block regardless: a segment
 * longer than a block, or a window with no speech in it, must not stop the reading.
 */
export function commitWindow(records, win, seconds, overlap) {
  const { w0, w1, atEnd } = win;
  const len = w1 - w0;
  const all = records || [];
  if (atEnd) return { keep: all, next: w1 };
  const timed = all.filter((r) => r.toS != null);
  const keep = all.filter((r) => r.toS == null || r.toS <= len - overlap + 1e-6);
  const kept = keep.filter((r) => r.toS != null);
  if (kept.length) return { keep, next: w0 + Math.max(...kept.map((r) => r.toS)) };
  // Nothing finished in time. Keep what starts in the first block, and move on by it.
  const early = timed.filter((r) => r.fromS < seconds);
  return { keep: all.filter((r) => r.toS == null).concat(early),
           next: w0 + Math.max(seconds, ...early.map((r) => r.toS)) };
}
