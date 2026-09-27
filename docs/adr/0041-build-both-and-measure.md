# ADR-0041: Where two methods each win on real signals, build both and keep the better one

**Status:** Accepted — the run-time form of the house rule about measuring

## Decision

**When a step has two defensible implementations and which one is right depends on the
signal rather than on anything knowable in advance, the node does both and keeps whichever
measures better.** It does not pick by rule, it does not expose the choice as a knob, and
it does not average the two. It says which one it used, the way every auto-derived
parameter says where its value came from ([ADR-0017](0017-auto-manual-parameters.md)).

This applies only where three things hold:

1. **Both methods are already justified.** This is not a licence to try things at random
   and keep the winner. Each branch exists because a measurement on a real signal showed
   it was needed.
2. **There is an honest measure.** Something computed from the output that says which is
   better, in the terms the user cares about — not a proxy for whether the code ran.
3. **The doubled cost is affordable.** These are jobs, not frame redraws.

## Why this came up

`core.raster` folds a leaking screen back into a picture and averages the frames, which is
the whole reason for finding the frame period: a still screen sends the same frame over and
over, so adding them up is free signal.

It is not free of conditions. On a 0.667 s capture of a real leak at 20 MS/s, the forty
frames in it walked nine samples apart from first to last, because the monitor's clock is
not the receiver's. Stacked where the frame period predicted they would be, those forty
came out **ninety times** less sharp than the same forty aligned against each other first —
and worse than seven frames stacked on their own. More averaging making a worse picture,
which is the trap, because it looks like more signal.

So: align each frame before adding it. That was measured, it was large, and it was right.

Then the synthetic fixture built to pin the fix down showed the opposite. What leaks is a
harmonic of the pixel clock folded back into the passband, and where it folds to near two
samples a cycle — as it does in `fixtures/tempest-leak` — the column correlation that
measures the alignment has a peak every two samples. Picking the wrong one is worse than
not having looked, and stacking the frames blind gives a picture half again as sharp.

Both results are real. Both were measured on signals the tool is meant to handle. Nothing
available before the stack is built distinguishes them, because what distinguishes them is
how the stack came out.

## What was rejected

**Ship the alignment and call the fixture unrepresentative.** It is not unrepresentative;
it is the case where the folded harmonic lands close to Nyquist, which is a matter of what
frequency the receiver was tuned to. Calling a measurement inconvenient is how a tool
acquires a failure nobody can reproduce on demand.

**Ship the blind stack and call the real capture a one-off.** Same objection, pointed the
other way, and it throws away the larger of the two measured wins.

**Expose it as a parameter.** A knob is the right answer when the user knows something the
tool does not — the de-emphasis region in [ADR-0037](0037-channels-are-a-parameter-of-real.md),
say, because nothing in the signal says which country it came from. Here the tool is the
one with the information: it has both pictures in memory and a number that says which is
sharper. A knob would be asking the user to guess at something already measured, and the
person opening a raster does not know where the pixel clock folded to.

**Pick by a rule derived from the folded harmonic's frequency.** This was the tempting one,
and it was tried. It means finding the interferer, predicting the ambiguity spacing,
comparing it against a walk that has not been measured yet, and picking a threshold. Every
one of those steps is a new thing to get wrong, to serve a decision that one subtraction
answers outright.

## Consequences

- **`stackFrames` builds two stacks and returns one**, with `aligned` saying which, and
  `walked` saying how far the frames had to move when it aligned them. The grid caption
  shows the walk, because a screen whose clock is wandering is a different situation from
  one holding still and the user should be able to tell.
- **The measure is horizontal detail** — the summed squared difference between neighboring
  columns — because that is the first thing a misaligned stack loses. It is stated here
  rather than left in the code, because the choice of measure *is* the decision: a measure
  that rewarded smoothness would pick the wrong branch every time, and on this signal an
  agreement-between-halves measure did exactly that before it was replaced.
- **The fixture tests the branch the real capture cannot.** A recorded TEMPEST leak is a
  picture of somebody's screen and does not go in the repository
  ([ADR-0025](0025-golden-capture-conformance.md)), so the case where aligning wins lives only in the
  house rule that it was measured. `fixtures/tempest-leak` pins the other half, and the
  fixture's README says which half it is.

## Would change our mind

If this pattern spread — three or four nodes each carrying two implementations and a
tie-breaker — that would stop being a decision and start being an absence of one. The
honest reading then is that the step is underspecified and wants a better method, not a
better referee. Two branches in one node, for a reason written down, is the whole of it.
