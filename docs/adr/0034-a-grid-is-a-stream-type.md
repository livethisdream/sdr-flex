# ADR-0034: A fold into two dimensions is a stream type of its own

**Status:** Accepted — extends [ADR-0006](0006-semantic-stream-types.md)

## Decision

**`grid` joins `iq`, `real`, `bits`, `bytes`, `events` and `audio` as a semantic stream
type**, and gets a view of its own: a canvas, time down the page, frequency across.

The first thing to produce one is `OFDM grid`. The message in an OFDM transmission can be
*which* cells carry anything, in time and in frequency — a picture rather than a bit
stream — so a node that reports it as a list of records has thrown the answer away in the
act of reporting it.

## Why not the events pane

Because a resource grid is hundreds of symbols by tens or hundreds of subcarriers, and a
person reading one is looking for a *shape*. A table of thirty thousand rows saying which
subcarriers were occupied in which symbol contains the same information and conveys none
of it. The existing bit raster was the near miss: it renders eight bursts as a table, which
is right for eight packets and useless for six hundred symbols.

ADR-0006's rule is that a stream type exists when it changes what can legally connect to
what, and what a person needs to see. `grid` does both: nothing consumes a grid — it is
terminal, like `audio` and `file` — and it needs a canvas, not a list.

## What is derived, and from what

Nothing about the structure is supplied. Every OFDM symbol carries a cyclic prefix: a copy
of its own tail pasted in front of it, there to absorb multipath. That has a side effect
which gives the whole scheme away — a stretch of samples identical to another stretch
exactly one FFT length later, recurring once per symbol. Nothing else in a signal does
that.

So the analyzer correlates the signal against itself at each plausible lag. The lag that
works is the FFT size; how long the correlation stays coherent is the prefix; the spacing
between peaks is the symbol period. Subcarrier spacing and symbol rate follow. Each
parameter arrives with the evidence for it (ADR-0017) — "the prefix correlates at a lag of
64 samples, 0.66 against 0.09 elsewhere".

**Contrast, not just correlation.** A steady tone correlates with itself at *every* lag, so
a metric that only asked "is the correlation high" would call a carrier OFDM. What
separates them is whether the correlation is high *in a pattern*: peaks once per symbol
against a low background. The test suite asserts that a tone and noise both come back not
confident.

## The fixture spells something

`fixtures/ofdm-grid` lights the subcarriers that spell `SDR` across the grid, and that is
not a flourish. A grid recovered with the symbol boundaries even slightly wrong smears the
letters — so the fixture fails in a way you can see, rather than as a percentage that has
quietly moved. It is also the honest demonstration of what OFDM's occupancy pattern *is*.

Both axes have to be scaled together to be legible. A cell is one subcarrier by one
symbol and has no natural aspect ratio; the first version drew glyphs three subcarriers
wide and fifteen symbols tall, which is fine in a terminal and unreadable on a screen.

## Consequences

- `core.ofdm` takes `iq` and produces `grid`. Its FFT size can be pinned, and pinning it
  is a different question rather than an override of the same one — the cache is keyed on
  whether a size was pinned, not on the value the node itself derived and wrote back.
- The wire carries a grid as a typed-array payload, not as JSON: a 512 × 64 grid is
  thirty-two thousand numbers, which is 128 kB of floats and about a megabyte of text.
- The same view will serve anything else that folds into two dimensions — a TEMPEST
  raster is line against frame, and the drawing code does not care which.
