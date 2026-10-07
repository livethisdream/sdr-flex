// A channel's band, dragged on its parent's spectrum (app.js `wireBand`).
//
// `edge` is what was grabbed: 'move' for the middle, 'l' or 'r' for an edge. `d` is how far
// the pointer has gone, in hertz. Moving keeps the width; dragging an edge keeps the other
// edge where it was. The width stays within [minW, maxW], and the band stays inside the
// parent's [lo, hi].
export function dragBand({ edge, c0, w0, d, lo, hi, minW, maxW }) {
  let c, w;
  if (edge === 'move') {
    w = w0;
    c = c0 + d;
  } else {
    const fixed = edge === 'l' ? c0 + w0 / 2 : c0 - w0 / 2;
    const free = (edge === 'l' ? c0 - w0 / 2 : c0 + w0 / 2) + d;
    // Dragged past the other edge, it stops at its narrowest rather than turning inside out.
    w = Math.max(minW, Math.min(maxW, edge === 'l' ? fixed - free : free - fixed));
    c = edge === 'l' ? fixed - w / 2 : fixed + w / 2;
  }
  w = Math.min(w, hi - lo);
  c = Math.max(lo + w / 2, Math.min(hi - w / 2, c));
  return { c: Math.round(c), w: Math.round(w) };
}
