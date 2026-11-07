# ADR-0046: Symbol timing is measured, and can be set by hand on the waveform

**Status:** Accepted 2026-11-07. Builds on [ADR-0017](0017-auto-manual-parameters.md) and
[ADR-0045](0045-the-whole-capture-is-a-waterfall-mode.md)

## Decision

**A channel gets a Time tab, and any Time pane can carry a symbol grid.** The grid is lines
one symbol period apart, laid over the waveform. It measures itself first. If the
measurement is not what you see, you take it over by hand. Both paths give the slicer a
number, and each says where that number came from.

- **The Time tab is a view of the channel, not a block.** It plots the channel's IQ as
  amplitude or as instantaneous frequency (`plot` in the view group), with the same span
  and trigger as a demodulator's Time view. Frequency is left out (NaN) wherever either
  sample of the phase step is 20 dB under the window's peak, because the phase step of
  noise is anything at all.
- **`g`, or the `grid` button, puts the grid out.** You drag a box across a few symbols.
  The waveform holds still while the grid is out, because the lines are placed on those
  samples.
- **Auto.** The period comes from the estimator the downstream slicer uses: pulse lengths
  for PWM, runs for NRZ, half-symbol runs for Manchester. The estimate is then refined from
  where the edges fall (`dsp.refineSymbol`). A run is cut where the threshold crosses a
  sloped edge, so a smoothed envelope's pulses read short: 389 µs for the scene's 417 µs
  PWM symbol. The edges still fall whole periods apart, so the period kept is the one,
  within a quarter of the estimate, that the edges agree on best. The lines go at the
  circular mean of the edges' phase. The readout gives the evidence, for example "36 edges
  in the box agree on 417.0 µs (100%), within ±5.69 µs of the lines."
- **By hand.** Drag the first line or the body to slide the grid. Drag the last line to
  stretch it. `−` and `+` in the readout (held, they repeat) or the wheel give more or
  fewer symbols over the same width. Arrows nudge it by a pixel, and shift with an arrow
  stretches it; zoomed in, a pixel is a finer step. Any of these makes it
  a hand grid. `fit` measures the box again. The readout keeps showing how far the edges
  sit from the lines, which is the measure of a good hand alignment.
- **Zoom, to judge the alignment.** Two fingers, or ctrl+wheel (a trackpad pinch), zoom the
  Time pane in time around the fingers or the cursor; a sideways scroll, or one finger with
  no grid out, pans; a double tap or `0` shows the whole frame again. It zooms into the
  frame already held, so what you see up close are its real samples, drawn as dots once
  they are far enough apart. The vertical scale stays the whole frame's. The pinch first
  set the symbol count; it moved to `−`/`+` because zoom is what a pinch means everywhere
  else in the app (ADR-0045), and zoomed in, the grid's box fills the pane, so a pinch
  inside it could never zoom back out.
- **"Use for …"** names each slicer below the view.
  - **A hand grid pins the slicer's `symbolUs`.** The value is manual, and the note reads
    "set by hand: 24 symbols over 9.98 ms". Typing a new value clears the note.
  - **An auto grid leaves the slicer auto but points it at the box** (`symbolUs.span`). An
    NRZ or Manchester slicer measures there with its own estimator and the same refinement,
    so the two give the same number. Setting the slicer back to auto in its strip drops
    the box.
- **No grid, no change.** A slicer nobody gridded measures the whole capture as before.

## Why both

The person asked for hand alignment by name: "The best part of Inspectrum was doing the
symbol alignment by hand." They also asked for it not to be the only way: "I don't always
want it set by hand. I want both options." A measured grid is the fast path, and it is
right on clean signals. A hand grid is how you get a decode when the measurement is fooled.
Both carry their evidence, so neither is a number with nothing behind it.

## Not here

- Reading bits off the grid (Inspectrum's threshold export). It would build on the grid.
- A grid on the whole-capture map. A map row is milliseconds, and symbols are microseconds.
