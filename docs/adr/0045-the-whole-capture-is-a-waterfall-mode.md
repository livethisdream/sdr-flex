# ADR-0045: The whole capture is a mode of the waterfall, and a row of it is a peak hold

**Status:** Accepted 2026-11-01 — refines [ADR-0020](0020-views-that-share-an-axis.md) and
[ADR-0012](0012-server-side-display-rendering.md); one stated exception to
[ADR-0044](0044-gnu-radio-is-the-engine.md)

## Decision

**An IQ channel's waterfall has two modes: `follow`, which scrolls past the playhead as it
always has, and `whole`, which holds the whole capture still as a map.** The switch is a
`whole` button on the stage, the `w` key, and a `waterfall` cell in the view group.

- **Same axes, same orientation.** Frequency across, shared with the spectrum trace above it
  (ADR-0020); time down the screen, newest at the top as on the scrolling waterfall, so a
  burst does not turn over when you switch. Inspectrum puts time across. That would need a
  second frequency axis drawn sideways, and a box gesture rotated to match.
- **A box on the map is the same selection as a box on the waterfall** (ADR-0002): frequency
  and time, the same menu, the same Tuner pinned to that window. Only the mapping from a
  pixel row to a moment differs.
- **The playhead is a line on the map.** A click puts it there; moving it does not redraw the
  map, because the map is of the capture, not of the moment.
- **The wheel moves through time on the map; ctrl+wheel and a trackpad pinch zoom it.** The
  spectrum trace and the axis keep the wheel for frequency. On touch, a two-finger pinch
  zooms both axes at once, like a map. The rows already drawn are stretched to where the new
  window puts them at once, and recomputed when the gesture settles.

**"Whole" is** a file's two ends, a clip's box, a radio's history, or the first minute of the
synthetic scene, which is what the server records of it.

## A row is a peak hold

A row of a ten-minute file stands for a couple of seconds. One FFT taken at the row's moment
shows whatever was on the air at that instant, and a 20 ms burst falls between rows and is
not there. So a row is the **strongest each bin got across FFTs spread evenly through its
slice**, at most 64 of them (`HOLD_FFTS`), so a long file costs what a short one does per row.

That cap means a long row is not read in full. **The fraction that was read is shown** — on
the badge when it is under 100%, and with the FFT count in the button's title — because it is
the evidence for how far an empty row can be trusted (ADR-0017). Zooming in shortens the rows
and raises it. Below one FFT per row the map stops narrowing: past that point it is a
waterfall.

The rows are computed on demand for the window on screen and kept in the client's cache.
Nothing is written to disk yet: ADR-0012's pyramid waits for a file that proves it is needed.
Measured, a full map of a minute at 480 kS/s takes about 1.6 s in the tab and 1.9 s for a
tuner on it.

## The exception to ADR-0044

On the server, a map row of a tuner is computed by the JS tuner, not by GNU Radio. A row reads
64 short windows spread over its slice; fetched from the GNU Radio worker, each would cost a
whole 0.25 s block, so a map of a minute would compute that minute several times over. The JS
tuner reads only the windows, and `grtuner.test.mjs` shows it gives GNU Radio's samples.

This is display, not the signal path: no decoder, slicer or export reads these rows. It is
still new work done by the JS DSP on the server's thread, which ADR-0044 says should stop. The
way out is a worker call that runs the tuner's flowgraph over a list of short windows; when it
exists, `GrEngine._overviewRead` uses it and this section goes.

The synthetic scene is read from its recording for map rows on the server, at a file read per
window. In the tab, with no server, it is computed sample by sample, so a row reads 8 windows
rather than 64 and a tuner on the scene fills in about 13 s.

## Would change our mind

If people zoom to see bursts the cap made them miss, the cap is wrong for them: raise it, or
read every sample once in the background and keep the result, which is the pyramid.
