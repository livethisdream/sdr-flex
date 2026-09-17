# ADR-0038: A node may have two inputs, and one of them is the primary

**Status:** Accepted and built. `core.math` is the first node with two inputs; the
mechanism is in `web/src/graph.js`, `web/src/delay.js` and the merge read in
`web/src/engine.js`. What building it changed is recorded in the two *what was built*
sections below.

**Extends:** [ADR-0004](0004-flowgraph-splitting-at-taps.md),
[ADR-0007](0007-stream-context-and-provenance.md)

## Decision

**A node may take a second input as a real edge**, making the analysis graph a DAG rather
than a tree. Three rules keep everything that walks it working:

1. **One input is the primary.** Navigation follows it and only it — the breadcrumb, which
   tab bar a block appears in, which pinned ancestor owns its clock. The second input is
   an edge for data and for export, not for finding your way around.
2. **Streams carry `t0`, and a merge refuses inputs it cannot align.** This is the part
   [ADR-0007](0007-stream-context-and-provenance.md) already specified and nothing has
   needed until now.
3. **A second input that is downstream of the node is refused when it is chosen**, not
   discovered as a stack overflow at the next frame.

The first node to use it is `core.math`: two streams of the same kind in, one out, with an
operation — sum, difference, product, conjugate product, ratio.

## Why this is wanted

Because it is the transparent half of a decode, and this project keeps arguing for that
half and then shipping the opaque one. [ADR-0024](0024-composable-decode-chain.md) says
the chain is the product; [09-demods](../09-demods-and-decoders.md) says we own everything
up to a named protocol precisely so a person can open it. `core.stereo` is a node you
cannot open. It is a good node — one key, one click, and a broadcast plays in stereo — but
it is the `rtl_433` of FM stereo, and the tool is supposed to have both.

Drawn out, FM stereo is:

```
FM demod ──▶ Analytic ──┬─▶ Tune  0 kHz ─────────────────▶ L+R ──┬─▶ Math  A+B ─▶ Left
  (composite)           │                                        │
                        ├─▶ Tune 19 kHz ─▶ Math  A×A ──┐         └─▶ Math  A−B ─▶ Right
                        │      (pilot)     (doubled)   │
                        └─▶ Tune 38 kHz ─▶ Math  A×B̄ ──┘
                               (L−R)       (coherent)
```

Every box in that picture is something a person can point at, measure and argue with,
which is the difference between knowing a station is in stereo and knowing *why* the
tool says so.

**And the math node is worth far more than stereo.** Difference two antennas. Take the
ratio of two channels for direction finding. Subtract a reference from a signal to see
what is left. Multiply by a conjugate to remove a carrier you tuned separately. Stereo is
just the first thing it happens to spell.

## The one that is not obvious: a magnitude is not a difference

A tuner on the 38 kHz band followed by a detector gives you **|L−R|**, not L−R. The
difference signal is negative half the time and an envelope has thrown the sign away, so
the result is a fuzzy mono rather than a stereo image — and it *looks* like it worked,
because there is audio and it is not silence.

Keeping the sign needs a coherent reference, and the only place to get one is the pilot,
doubled (see [ADR-0037](0037-channels-are-a-parameter-of-real.md) for why doubling the
*phase* rather than the frequency is the whole trick). That is why the sketch above has
three branches rather than two, and why the math node has to be complex-aware: `A × B̄` on
two `iq` streams is the operation that does it.

So the graph version is not a simplification of `core.stereo`. It is the same work, with
the intermediate results visible.

## Two ways to do it, both costed

### Option A — a real second edge

`node.inputs` is an array; `node.parent` becomes `inputs[0]`.

> **Built differently in one respect.** `parent` kept its name and kept meaning the
> primary. It *is* the edge navigation follows, so "parent" is exactly what it is, and
> renaming thirty-two call sites to `inputs[0]` would have said the same thing while
> touching every read in the engine. `inputsOf(n)` is the whole list.

What has to change, measured rather than estimated — 32 reads of `.parent` across six
files, of which most are `const p = this.node(n.parent)` inside an operation that will
keep using the primary and need only the rename:

| Place | What breaks | Fix |
|---|---|---|
| `graph.path` | two ways up, so two breadcrumbs | follow the primary |
| `graph.children` | asks two different questions with one answer — "what did I make from this" (tabs, navigation) and "what reads this" (removal, invalidation) | split: `children` is primary-only, `consumers` is any input |
| `app.blocksOf`, `app.descendants` | a merge is reached down both branches and appears twice | visit set, and `blocksOf` follows the primary |
| `graph.isPinned`, `graph.effectiveTime` | two ancestors that can disagree — one branch pinned to a clip, the other live | primary decides; a genuine conflict is an error the node reports, not a coin flip |
| `app.removeNode` | removes descendants, which no longer means what it meant | remove transitive *consumers* |
| ADR-0004 fragments | a merge joins two fragments, and taps were designed one-to-one | the tap protocol grows a join; this is M1 work either way |

The wire needs nothing: a snapshot replaces the graph wholesale
([graph.js](../../web/src/graph.js)), so an extra field rides along free.

### Option B — a sidechain named by parameter

Keep the tree. The math node's second input is a parameter holding a node id, and the flow
view draws a dashed line to it.

This looks much cheaper and **it is not**, which is the finding that decided this ADR. It
saves the table above — traversal edits, a day of work in files that are already being
read carefully. It saves **none** of the following, which are the same under both options
and are where the actual difficulty is:

- time alignment and `t0` (below);
- the pinned-ancestor conflict;
- cycle detection;
- the tap join at M1;
- and the `.grc` export, which has to materialize a real edge anyway
  ([ADR-0032](0032-a-flowgraph-is-a-program.md)).

It also costs something ADR-0002 and ADR-0032 are explicit about: the flowgraph is derived
from what the user did and *is* the program. A graph whose data flow you cannot read off
its own picture is a graph that lies about the program, and the lie is invisible — a
dashed line is a convention, and a person reading the tree sees two unrelated branches.

Paying full price for the hard half and taking a lie on the easy half is the wrong trade.

## Alignment is the real work, and it was promised in 2023

Two branches out of one source do not arrive at a merge at the same moment. Each carries
its own decimation and its own filters, and a windowed-sinc channel filter has a group
delay of half its length — which the tuner already varies per channel, because
`chooseTaps` derives the tap count from what folds
([ADR-0017](0017-auto-manual-parameters.md)). Two branches of a stereo decode go through
different-length filters by construction.

For an incoherent operation a few samples of skew is nothing. For `A × B̄` — the one the
whole example turns on — skew is a phase error, and a phase error is exactly the thing that
turns a stereo decode into a fuzzy mono.

[ADR-0007](0007-stream-context-and-provenance.md) already says every stream carries "`t0`
as an absolute timestamp of sample zero" and "the rate and offset transformation at each
hop". The implementation never needed it, because in a tree every read walks one path from
one source and the delays cancel. `out` today is `{ kind, sampleRate, centerHz, channels }`
and nothing more. **A merge is what makes ADR-0007 load-bearing**, and that is the honest
first commit here — not the math node.

The rule: a merge resamples the lower-rate input to the higher, aligns on `t0`, and reports
the correction it applied the way every other derived value reports itself. Where it cannot
align — a non-invertible time mapping, which ADR-0007 already anticipated — it says so
rather than producing a plausible wrong answer.

### What was built, and what measuring it changed

`web/src/delay.js` answers "how late are this node's samples" and "can these two be lined
up". Two things came out of building it that the plan above did not anticipate:

**It is computed on the way up, not stored on the way down.** ADR-0007 says streams
*carry* `t0`, and a field on `out` was the obvious reading. It would go stale: `setParam`
propagates a rate change exactly one level, so changing a tap count would leave every
node below the next one lying about its delay. Walking to the source is a handful of map
lookups and cannot be wrong.

**The tuner's delay does not depend on its decimation, and the arithmetic says it should.**
`xlateFilterDecimate` reads `count * decim + taps` input samples for `count` outputs, so
the extra window and the filter's own centre cancel, leaving `(taps + 1) / 2` input
samples whatever the decimation. Deriving it from the code rather than measuring it
produced a spurious `decim` term — harmless at 1, wrong by eight times at 16. So the test
puts a pulse through and finds where it lands, and restating the formula in the test would
have agreed with the bug.

The numbers, measured: a tuner is late by half its filter, which is 69 µs at 65 taps and
267 µs at 255. An SSB demodulator adds 32 samples for its Hilbert transformer. A
discriminator adds half a sample, because the phase between two samples belongs between
them. An AM detector adds *minus* half a sample on an even smoothing window, because the
smoother can only undo a whole number. The last two are the ones worth having: half a
sample at 160 kS/s is forty degrees at 38 kHz, so a merge that rounded the shift to an
integer would line two branches up and still lose a coherent decode.

### What the merge turned up

Two things, and the second is the more serious:

**`children` was answering two questions.** "What did I make from this" drives the
breadcrumb, the tab bar and the flow view's indentation; "what reads this" drives removal
and invalidation. They were the same function because in a tree they are the same
question. They are now `children` and `consumers`, and a merge is a consumer of its second
input without being a child of it — which is what makes deleting a branch take a node
that is nowhere below it.

**A read positioned by a floating-point time jitters by an input sample, and that is a
phase error.** Reading the second input over a window ending at `tEnd + pad / rate` — the
obvious way to get margin for the shift — floors to 120095 where the arithmetic says
120096, because `0.2502 × 480000` is `120095.99999999999`. One input sample at a
decimation of four is a quarter of an output sample. So the read positioning was
injecting, unmeasured, the same kind of error the node exists to remove. Both inputs are
now read to the *same* `tEnd` and the margin comes from asking for more samples, which
floors identically by construction.

That one is worth the space because it was invisible. Every test about alignment passed
with it present — the cancellation test only got to −25 dB instead of −64, and −25 dB
looks like a success.

## Consequences

- **`core.stereo` stays.** Both halves, the same way `rtl_433` and the native bit chain
  both stay: one to get a decode, one to understand it. If the chain turns out to be the
  only one anybody uses, the node is the thing to delete — not the other way round.
- **The palette gets a second question to answer.** Today it asks "what takes this kind of
  stream". A merge also needs "and what else could be the other input" — which is every
  node of the same kind that is not downstream of this one. That is a new menu, and it is
  the first UI in the tool that asks you to point at a node rather than at a signal.
- **A node can now be orphaned by a deletion it is not downstream of.** Removing a branch
  removes every consumer of it transitively, which can reach into a part of the tree the
  user was not looking at. It has to be said before it happens, not after.
- **Manual tuning gets more important.** The chain above is four boxes drawn by hand on a
  baseband spectrum ([ADR-0036](0036-a-domain-is-a-view-parameter.md)), so the numbers on
  that axis stop being a readout and start being a control surface.

## What would change our mind

If `core.math` ships and the only chain anybody builds with it is the stereo one, then the
composition is theater — the same test [ADR-0024](0024-composable-decode-chain.md) sets
for itself — and a parameterized node was the right answer all along. The check is whether
the second and third uses reuse the shape or diverge from it.

And if two inputs turn into three or four within a year, `inputs[0]` as "the one navigation
follows" is a convention holding up more than it should, and the graph wants a proper
notion of a port rather than an ordered list.
