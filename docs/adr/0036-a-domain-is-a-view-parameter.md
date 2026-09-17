# ADR-0036: Which axis a stream is read on is a view parameter

**Status:** Accepted — refines [ADR-0020](0020-views-that-share-an-axis.md)

## Decision

**A `real` stream can be drawn as a waveform or as a spectrum, and which one is a
parameter of the view** — a `domain` pill in the view group, next to the FFT size and
the trigger — **not a second node and not a second tab.**

The frequency reading reuses the spectrum pane exactly as it stands: trace over
waterfall, one shared axis (ADR-0020). It is one-sided, DC to `fs/2`, and the numbers
on the axis are baseband offsets in kilohertz rather than RF in megahertz.

## Why this came up

`FM demod` went straight to the time domain, and for narrowband FM that is right: an
APRS burst is a waveform and the waveform is what you slice. For wideband FM it hides
the answer. A broadcast discriminator's output is the whole composite — mono audio at
the bottom, a 19 kHz pilot, L-R on a 38 kHz subcarrier, RDS at 57 kHz — and whether a
station is stereo, or carries RDS at all, is a question about *which of those exist*.
A scope cannot answer it. Nothing in the tool could, and the samples were there the
whole time: the discriminator has no de-emphasis, no post-detection filter and no
decimation, so it hands on the parent's rate untouched.

It is also the prerequisite for `redsea`, which takes demodulated MPX in
([reuse](../07-reuse.md)). An adapter you cannot aim is an adapter you cannot trust.

## The three ways not to do it

**A `WBFM demod` node.** This is what every other tool ships, and it is the SDRangel
shape ADR-0006 and [09-demods](../09-demods-and-decoders.md) argue against: a block
that bundles a channelizer, a stereo decoder, de-emphasis and an audio chain, with
twenty parameters and no way to see between them. The existing discriminator is not
missing anything — it already produces the composite. Only the picture was missing.

**A `Spectrum of` node.** A node that consumed `real` and produced something a
spectrum view could render would put a box in the graph whose only effect is how a
result is drawn. The graph is the record of what was done to the signal
([ADR-0032](0032-a-flowgraph-is-a-program.md)); a node that does nothing to the signal
does not belong in it, and deleting it would be deleting a view.

**A second tab on the same block.** Blocks are tabs (ADR-0018) — one block, one tab.
Two tabs for one node would need their own zoom, their own dB range and their own
colormap, and a person switching between them would be switching contexts rather than
axes.

What is left is a view parameter, which is what it always was: the same node, the same
samples, drawn against a different independent variable.

## Consequences

- `frame()` reads `opts.domain` on a `real` node. Anything that caches a frame has to
  key on it — the remote engine's cache did not at first, and served the waveform to
  the spectrum view forever, which does not look broken. It looks like a signal.
- `bins` means columns on screen in both domains, so a one-sided spectrum of `bins`
  values comes from `bins * 2` samples. The waterfall and the auto-range follower did
  not have to learn anything.
- The mirrored half is folded back in rather than shown, so a full-scale sine reads
  0 dBFS here and in the IQ view alike. Half a screen spent on a reflection would be
  half a screen, and 6 dB of disagreement between two panes that claim the same unit
  is worse than either.
- **No box on a baseband spectrum.** A selection is a request to tune, and there is
  nothing left to tune inside a stream that has already been demodulated. Zoom, pan
  and the axis all work; the drag does not start.
- `real` keeps its `centerHz`, which now names where the samples came from rather than
  the middle of the picture. That is provenance ([ADR-0007](0007-stream-context-and-provenance.md)),
  and it is what a decoder downstream still needs.

## Would change our mind

If a third domain shows up for the same stream — a cepstrum, say, or a spectrogram of
the demodulated audio that wants its own time axis — then `domain` is an enumeration
pretending to be a boolean, and the views probably do want to be tabs after all.

## What this does not do

It does not decode stereo or RDS. It shows you that they are there, which is the step
that was missing; `redsea` is the one that reads them, and a stereo decoder is a node
nobody has written yet. It also does not label the subcarriers — 19, 38 and 57 kHz are
facts about broadcast FM, not about `real`, and baking them into a generic view would
be the same mistake as the bundled demod, one altitude down.
