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

## The second thing that folds: a raster

`Raster` takes a screen leaking and gives the screen back. Two periods and a fold — the
line period from an autocorrelation, the frame as the best *whole number of lines*, and
the frames averaged on top of each other because a still picture repeated is free
signal-to-noise on a weak signal.

Three decisions in it are worth the space:

- **It takes IQ, not a demodulated stream.** The AM detector's post-detection filter is
  forty microseconds, which is right for speech and about eight pixels wide here. Run a
  screen through it and the letters come out as bars. The raster takes the envelope itself
  and leaves the bandwidth alone. (The AM node's fixed filter is arguably wrong for
  anything wider than audio; that is a separate thing to fix and is written down.)
- **The period is fractional.** A raster line is rarely a whole number of samples, and a
  period rounded to the nearest one shears the picture a little more with every line until
  it is unreadable halfway down. The correlation peak is refined by a parabola through its
  neighbors.
- **Only whole numbers of lines are scored for the frame.** Searching the autocorrelation
  again would happily land on a lag that is not a multiple of the line, which produces a
  frame that slides.

**The honest limit.** This proves the mechanism, not that it will read a real leak. A
genuine TEMPEST capture has an unknown pixel clock, a harmonic rather than a baseband
carrier, interlace, and a receiver synchronized to none of it — which is exactly why
`gr-tempest` exposes five live knobs a person turns until the picture locks
([ADR-0032](0032-a-flowgraph-is-a-program.md) records what trying it cost). The fixture is
the case where all of that is already right, and the node says "not confident" rather than
drawing a picture of noise when it is not.

## Consequences

- `core.ofdm` takes `iq` and produces `grid`. Its FFT size can be pinned, and pinning it
  is a different question rather than an override of the same one — the cache is keyed on
  whether a size was pinned, not on the value the node itself derived and wrote back.
- The wire carries a grid as a typed-array payload, not as JSON: a 512 × 64 grid is
  thirty-two thousand numbers, which is 128 kB of floats and about a megabyte of text.
- The same view serves both: a resource grid is symbol against subcarrier and a raster is
  line against frame, and the drawing code does not care which. The axis labels do — a
  raster is measured in pixels and lines, and labeling it in hertz would be labeling it
  with the wrong thing entirely.
