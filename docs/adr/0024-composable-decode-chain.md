# ADR-0024: The transparent decode path is composable single-purpose nodes

**Status:** Accepted

## Decision

Everything between a detector's output and a named protocol is built as **small,
single-purpose nodes** that compose: clock recovery, thresholding, slicing, line-code
interpretation (Manchester, differential, invert, reverse), and framing (preamble, sync,
length, CRC).

There is no `core.ook_decoder` that does five of those at once, and no per-protocol
native node. A protocol we own is a *saved chain* of these nodes, not a new node kind.

## Why

A decode fails at exactly one of those steps, and the steps fail for different reasons —
wrong symbol rate, wrong threshold, inverted polarity, wrong Manchester convention, right
bits with the wrong sync word. A monolithic decoder that returns nothing tells you none
of that. Five nodes with a view on each tell you which one, in one glance down the tabs.

This is URH's actual contribution, and it is separable from URH: the encoding chain model
(invert / differential / Manchester / carrier / cut) is self-contained, and worth
reimplementing rather than borrowing, because the value is in the *composition*, not the
code.

It also matches the tool's premise. Every one of these nodes has something derivable —
symbol rate from pulse-length clustering, threshold from Otsu, Manchester convention from
mid-bit transition counts, CRC polynomial from a brute-force search over the standard
catalog. A monolithic decoder has one estimator and one confidence number; a chain has
five, each showing its own evidence (ADR-0017), and the one that is wrong is visible.

The M0 toy model already ran this argument on a small scale: its PWM slicer estimates
threshold and symbol period separately, and when the symbol estimate is unconfident it
says so, which is what tells you the threshold was the problem.

## Cost

- **More nodes on screen** for a chain that a monolith would hide. Mitigated by blocks
  being tabs within one channel (ADR-0018), not breadcrumb levels — a five-node chain is
  five tabs, not five levels of depth.
- **More node kinds to maintain**, though each is small enough to be obviously correct.
- A saved chain needs a name and a way to be re-applied, which is a feature the command
  log (ADR-0009) has to grow rather than one it has already.

## Alternatives

- **Per-protocol native decoders.** Faster to a first result, and then you own a
  decoder per protocol forever — the career problem, in the half of the tool where we
  have no coverage advantage at all.
- **Only external decoders.** Then the tool is a launcher, and the interesting case —
  a signal nothing recognizes — is the case it cannot help with.

## Would change our mind

If real chains turn out to be nearly always the same five nodes in the same order, the
composition is theater and a parameterized single node is more honest. The test is
whether the second and third protocols reuse the chain shape or diverge from it.
