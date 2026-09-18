# ADR-0040: A decoder may read symbols, and then the clock is a node

**Status:** Accepted — `core.symbols` in `web/src/engine.js`, `softSymbols` in
`web/src/dsp.js`, `ext.m17_packet` in `server/adapters.js`, `fixtures/m17-packet`

## Decision

Symbol timing recovery is a **node**, not something an adapter does on the way in.
`core.symbols` reads a `real` stream and produces a `real` stream at the symbol rate —
one soft symbol per sample — and the three numbers that decide whether it worked (the
sampling instant, where zero is, how far out the outer level is) are auto parameters
with their evidence on them, like every other derived parameter here (ADR-0017).

An adapter that reads symbols says so with `wants: { format: 'f32', rate: <symbol rate> }`
and is put behind one.

## Why this came up

`ext.m17` decodes M17 stream mode. It cannot decode M17 packet mode, and the reason is
not a missing flag: **M17's two modes are read by two programs from two different
upstreams.** Stream mode is `m17-demod`, from `mobilinkd/m17-cxx-demod`, which is what
`Dockerfile.full` built. Packet mode is `m17-packet-decode`, from
`M17-Project/M17_Implementations`, which it did not. The blurb said "voice and data" and
the data half had never existed.

The two programs also want different things on stdin, and that is the interesting part.
`m17-demod` takes 48 kS/s samples and finds its own clock. `m17-packet-decode` takes one
float per symbol, already on the symbol grid, because it correlates for a syncword rather
than tracking a clock. Nothing in this tool produced that.

## The three places the clock could have gone

**Inside the adapter.** It is twenty lines of DSP and nobody would have to think about
it. It is also exactly the shape this tool is against: the sampling instant and the level
fit are the two numbers that decide whether a decode happens, and hiding them inside
somebody else's pipe means the failure — nothing decoded — has no visible cause.
ADR-0013 accepts opacity where the work is genuinely in another program. This work is
not; it would be ours, hidden on purpose.

**In the conversion chain**, as a `wants` that resamples to the symbol rate. This is what
happens if nothing is done, and it is worse than not working: `convert()` will cheerfully
resample 48 kS/s down to 4800 and say `resampled 48.0 → 4.8 kS/s` in the node's note. A
resampler low-passes and decimates. It does not pick a sampling instant. The decode then
fails by finding nothing, with a note that reads like everything went fine.

**As a node**, which is what this record chooses. It maps cleanly onto `symbol_sync_ff`,
which is the test this project adopted for whether a new block is a block: if GNU Radio
already has it under that name, it is one thing and not a private convenience.

## What the node is, and what it is not

It finds **one** sampling instant for the whole span and holds it. It does not track a
drifting clock. That is a real limit and it is the right one for what this tool does: a
span is a capture, a packet is over in a fifth of a second, and a Gardner or
Mueller–Müller loop is an answer to a question a burst does not give it time to ask. If
live radio ever needs a tracking loop, that is a second mode on this node and not a
reason to have built one now.

The instant is found by trying all of them — thirty-two candidates across the symbol
period, scored by how tightly the symbols land on the levels once centered and scaled.
There is no closed form for "where is the eye widest", and at this resolution the
exhaustive search costs one pass per candidate.

## Three things the implementation settled

**Percentiles, not the mean.** Both the center and the scale are measured from the data,
because a discriminator's output is in the capture's units and carries the tuning error
as DC. The obvious estimator — subtract the mean — is wrong here and measurably so: on
`m17-packet-encode`'s own baseband the mean of the span is 0.43 where the signal's center
is 0, because the symbol alphabet is not used evenly. Subtracting it turned a symmetric
±9.49 preamble into 2.25 against −3.00 and cost 12% of the eye. The 5th and 95th
percentiles are the outer levels whatever the distribution between them does.

**The fit is gated to the burst.** A span is chosen by dragging on a spectrum, so it is
nearly always wider than the signal in it. Fitted over everything, the outer levels
landed on the silence and the sampling instant went with them. Symbols more than 0.3 of
the loudest deviation from the median are signal; the rest are not fitted to.

**Samples per symbol is not a whole number and does not need to be.** A tuner picks its
decimation from the channel width (ADR-0017), so the fixture's 4800 symbols a second
arrive at 32 kS/s — 6.67 samples each. The matched filter is built for whatever it is
handed, with an odd tap count so its peak lands on a tap, and the sampling instants are
interpolated. Requiring an integer would have meant overriding the tuner's own derivation
to suit a decoder, which is the wrong way round.

## Cost

- One more node in a chain that is already four long, and a user who leaves it out gets a
  decode that fails quietly. The adapter says so in its "nothing decoded" note, naming
  the resample if one happened — which is the best available answer and not a good one.
- The fit runs over the whole span at node creation: at 48 kS/s, ten seconds through a
  matched filter and a thirty-two-way search. Once per node, and capped at ten seconds.
- A stored instant goes stale if the parent's rate changes under it. `setParam`
  propagates one level, which covers the tuner above it; a deeper change does not
  re-derive, and the evidence on the node is then describing an older signal.

## Would change our mind

If a second decoder that reads symbols wants a different symbol rate and a different
constellation — two levels, or eight — `levels` and `symbolRate` become parameters rather
than the constants they are now. That is a widening of this node, not a different
decision. If live radio needs a tracking loop, this node grows a mode.

If it turns out that every decoder that reads symbols also wants the hard decisions, that
is `bits` and a slicer, and this node is the thing in front of *that*.
