# ADR-0037: Channel count is a parameter of `real`, not a stream type of its own

**Status:** Accepted — extends [ADR-0006](0006-semantic-stream-types.md)

## Decision

**A `real` stream carries a channel count**, and stereo is `real(sample_rate, channels: 2)`
rather than a new `stereo` type. The samples are interleaved, the way `iq` already
interleaves its two components.

**An operation that does not ask for more than one channel is fed the mono sum.** That is
structural rather than a courtesy: every existing consumer of `real` keeps working and
keeps getting the right thing, because in FM stereo the sum *is* the mono signal — the
whole encoding was designed so a mono receiver could ignore the subcarrier and be correct.

## Why this came up

`FM demod` hands back the composite, the baseband spectrum
([ADR-0036](0036-a-domain-is-a-view-parameter.md)) shows you whether there is a 38 kHz
subcarrier in it, and `redsea` reads the data at 57 kHz. The one thing left in the
composite that nothing touches is the audio it is mostly made of: L−R on that 38 kHz
subcarrier, which is what turns one channel into two. A tool that can tell you a station
is transmitting in stereo and cannot play it in stereo is pointing at a gap it dug.

## The three ways not to do it

**A `stereo` stream type.** This is the obvious move and it is wrong, because it forks the
palette. Every slicer, every `in: 'real'` adapter and both sinks would have to declare
whether they also take `stereo`, and the answer for all of them is the same — "the mono
sum, please". [ADR-0034](0034-a-grid-is-a-stream-type.md) set the test for a new type:
it exists when it changes *what can legally connect to what*. `grid` passed that test
because nothing consumes a grid. Stereo fails it: everything that consumed `real`
consumes this too, unchanged.

**A node with two outputs.** L and R as separate ports is how a flowgraph would draw it,
and the graph here is a tree — every node has one parent
([ADR-0004](0004-flowgraph-splitting-at-taps.md)) — so two outputs means a DAG, a merge
node, and a rewrite of everything that walks the graph. For a pair of signals that are
never separated, never filtered differently, and never go anywhere but the same sink.

**Two channels in the ADR-0023 sense.** They are not. A channel in this tool is a piece of
spectrum somebody drew a box around; L and R are not at different frequencies and were
never two channels. Lettering them `A` and `B` in the breadcrumb would be the tool
describing its own data structure instead of the signal.

## Why a parameter is the faithful answer

ADR-0006's types are already parameterized — it says `iq(sample_rate, center_hz, t0)` and
`symbols(rate, alphabet)`, not `complex float32`. A channel count is a parameter of a
real-valued stream in exactly that sense: the same kind of thing, said more precisely.
The type system was built to carry this and had not yet been asked to.

## The rule that makes it safe

**Downmix at the boundary, not at the source.** A node declaring `channels: 1` — which is
every node that exists today, by omission — receives `(L + R) / 2`, computed where the
streams meet. Three consequences worth stating:

- **Nothing that works now stops working.** A PWM slicer, `multimon-ng` and `redsea` on a
  stereo node all read the mono signal, which is what each of them wants.
- **The downmix is not a loss anybody has to reason about**, because it is the signal the
  transmitter built the sum to be. This is the one place in the codebase where "just
  average the channels" is the correct answer rather than the lazy one, and it is worth
  writing down that the reason is the encoding rather than convenience.
- **A view has to say which channel it is showing.** The waveform and the baseband
  spectrum get a `channel` control — left, right, or sum — next to `domain`, for the same
  reason `domain` exists: one node, one set of samples, and a choice about what is
  plotted that the pane must not make silently.

## De-emphasis belongs to the stereo decoder, not to the discriminator

A broadcast transmitter boosts treble by `1 + j2πfτ` before transmitting and the receiver
is supposed to undo it. This tool has never undone it, which is recorded as a known gap
and pinned by a test: the synthetic scene's WBFM signal is pre-emphasized and
`web/test/detectors.test.mjs` asserts 4 kHz comes back **6.25 dB hot**.

That test stays green, because de-emphasis goes in `core.stereo` rather than in
`core.fm_discriminator`. The reasoning is not convenience:

- **A discriminator is a detector, not a receiver** ([09-demods](../09-demods-and-decoders.md)).
  De-emphasis is a broadcast-FM convention, and NBFM, APRS, POCSAG and M17 all go through
  the same node and want none of it. Putting it there would corrupt every one of them to
  serve one.
- **It has to happen after the matrix, not before.** L and R are each `(sum ± diff)`, and
  the time constant applies to each recovered channel — so the only place it can go is
  inside the node that does the matrixing.
- **The composite must not be de-emphasized at all**, or the 57 kHz subcarrier gets
  attenuated by about 27 dB on the way to `redsea`. A discriminator that de-emphasized
  would have silently broken the adapter shipped one commit earlier.

So the station's own τ is a parameter of the stereo decoder: 75 µs in the Americas, 50 µs
most other places, and off — with the value shown as a choice rather than derived, because
nothing in the signal says which region it came from. That is the same honesty `redsea`'s
`region` knob applies to the same ambiguity.

## What `auto` derives, and from what

The pilot is the evidence, and it is unusually good evidence: a 19 kHz tone at about 10%
injection, present when and only when the station is transmitting stereo, and specified
tightly enough that finding it is a real measurement rather than a threshold somebody
picked. So `core.stereo` reports the pilot's level over the noise floor and declines to
claim stereo when it is not there, the way every other estimator here declines
([ADR-0017](0017-auto-manual-parameters.md), [ADR-0031](0031-identify-says-what-it-will-not-claim.md)).

**The subcarrier is regenerated from the pilot, not searched for.** 38 kHz is the pilot
doubled and 57 kHz is the pilot tripled — that is why they are where they are — so
squaring the recovered pilot gives a 38 kHz reference already phase-locked to the
transmitter. A free-running oscillator at a nominally correct 38 kHz would drift in and
out of phase with L−R and the separation would breathe, which sounds like a problem with
the recording rather than with the receiver.

## Consequences

- `out` for a `real` node grows `channels`, defaulting to 1. Everything that reads a real
  stream — `readSpan`, `readAudio`, `frame`, the export path — has to multiply by it, and
  a place that forgets reads every other sample and produces something that sounds like a
  tape at double speed rather than an error.
- The audio sink builds a two-channel buffer when it is handed two channels. It was
  `createBuffer(1, …)` with a single gain node, which is why two Listen blocks were a
  mixer and never a stereo pair.
- **Separation is measurable and therefore has to be measured.** A stereo decoder with an
  inverted matrix, a half-turn of pilot phase or a swapped pair still produces two
  plausible channels, and every one of those is silent to a test that only asks whether
  audio came out. The fixture puts a different tone in each channel and asserts the
  crosstalk, which is the only assertion here that could have caught any of them.

## Would change our mind

If something arrives that genuinely needs more than two channels and needs them kept
apart — a multichannel recording where each channel is a separate antenna, say — then
`channels` is doing two jobs, because those are not a downmixable set. That would want a
type whose channels are independent, and the sum rule above would be exactly wrong for it.
