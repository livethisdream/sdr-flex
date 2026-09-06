# ADR-0023: Frequency makes a channel; time is a property of one

**Status:** Accepted
**Refines:** [ADR-0002](0002-selection-is-the-primitive.md), [ADR-0018](0018-contextual-menus-and-view-tabs.md)

## Decision

Constraining **frequency** creates a **channel** — a new workspace, a new breadcrumb
entry, its own spectrum and its own chain of blocks.

Constraining **time** does **not**. A time window is a **property of a channel**:
`live` (following the playhead) or `pinned` to `[t0, t1]`. Comparing two bursts means
two channels, not two gates.

## Why

Both constraints come from the same gesture — a box in the time-frequency plane, width
versus height ([ADR-0002](0002-selection-is-the-primitive.md)) — so it is tempting to
make both produce nodes of the same kind. That was the original design and it was
wrong for three reasons:

1. **They are not the same kind of thing.** A tuner produces a *different signal*: new
   centre frequency, new sample rate, new bandwidth. A time window produces the *same
   signal*, looked at over a different interval. One changes what the samples are; the
   other changes which samples you are looking at.
2. **It made them indistinguishable in the UI.** A gate and a tuner appeared as
   identical breadcrumb entries doing completely different things, and the first
   question a user asked on seeing it was "what are gates versus tuners?" — which is
   the design failing out loud.
3. **A gate absorbed the chain.** Because a gate emitted IQ it counted as a channel,
   so a demodulator applied after one hung off the *gate* rather than the tuner. The
   tuner you actually built ended up with an empty workspace.

There is also a deeper reason. With the ring recorder
([ADR-0005](0005-all-sources-are-time-indexed.md)), **time is a coordinate, not a
filter.** You do not need a processing node to look at another moment; you scrub. What
a "gate" was really for was *pinning* an analysis so it stops moving — and pinning is a
mode of a view, in the same family as the trigger on a time display, not a stage of
signal processing.

## Consequences

- The breadcrumb only ever lists channels, and channels are always frequency slices,
  so it reads as a **frequency drill-down** — which is what the product's premise
  claims it is.
- A channel gains `timeMode: live | pinned` with `t0`/`t1`. Dragging a box vertically
  on the waterfall sets the current channel's window rather than creating a node.
- Comparing two bursts on one tuner means duplicating the channel. That is more
  explicit than two gates and reads better in the breadcrumb, at the cost of one
  cloned node.
- The **trigger** on the time view ([`views.js`](../../web/src/views.js)) is the
  transient form of the same idea, and stays.

## Status in M0

The time-window gesture needs vertical dragging over scrollable history, and neither
exists yet — so M0 **offers no time constraint at all** rather than shipping a menu
item that produces an invisible node. `core.gate` has been removed. The window lands
with scrubbing, at M4 where the ring recorder does.

## Would change our mind

If pinned windows turn out to want their own downstream chains often enough that
cloning a channel each time is a real cost. Then a window becomes a channel variant —
shown as `A · Tuner @ 1.80 s` on one breadcrumb entry, not as a second level.
