# A threshold is a line on the waveform

Serve the repository root and open `docs/mockups/threshold/`. It imports
`../../../web/src/dsp.js` and `../../../web/style.css`, so it has to be served from
somewhere that can see `web/`.

The last unbuilt piece of the layout study. Everything else in the parameter strip found
a home — see [the census](../surfaces/parameter-census.md) — and what was left was the
~20 numeric node parameters and the claim that they belong *on the object*. That claim
had been described four times and never built, and it was the only thing keeping the
bottom bar alive.

**It runs the real slicer.** `web/src/dsp.js` has no imports, so the page imports
`otsuThreshold`, `estimateSymbolPeriod` and `pwmSlice` from it directly. Dragging the
line re-slices with the code the app ships, and the bits are the bits the app would
produce.

The fixture is verified rather than assumed: at the auto threshold the production slicer
returns three bursts of sixteen bits matching exactly what the generator encoded, the
symbol estimate reads 421 µs against a true 417, and the correct-decode window is
0.139–0.343 with auto sitting inside it. Drag outside that window and it breaks, which is
the point.

## What it settles

The census's hard case — Bits, Bytes and Events have nothing to draw a threshold on, and
those are the views whose nodes carry these knobs — has an answer that is a rule rather
than a workaround: **the parameter goes on the plot of its input, never its output.** A
slice threshold over bytes is meaningless; over the envelope that produced them it is the
only place it has ever made sense, and that plot is drawn already.

## What it does not settle

One parameter of one node, and the easiest one: a scalar with a natural axis to sit on.
A de-emphasis time constant, a BFO offset, a volume are numeric too and have no such
axis. The honest scope is that *threshold and symbol period* work on the object — two of
twenty. The rest is still a claim.

## Two things building it taught

- **A fixture has to be checked against the real algorithm.** The first envelope drifted
  0.44–1.0, which put the quiet end of the capture below the Otsu value and shattered
  those marks; and a preamble mark made `pwmSlice` count a seventeenth bit. Both were the
  fixture being wrong while the slicer was right.
- **A symbol period is too small to drag directly.** One symbol is 42 samples in 6804 —
  six pixels. The handle measures a span of sixteen symbols and divides, for the same
  reason you time twenty swings of a pendulum rather than one.

This is an exploration, not a decision. Nothing here has an ADR behind it, and nothing in
`web/` changed.
