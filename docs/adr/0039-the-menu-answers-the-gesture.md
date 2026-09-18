# ADR-0039: The menu answers the gesture, and folds everything else

**Status:** Accepted — not yet built. This records the decision and the measurements
behind it.

**Revises:** [ADR-0018](0018-contextual-menus-and-view-tabs.md), which said the contextual
menu is flat, grouped and searchable. It is no longer flat, the grouping has stopped
earning its space, and this says what replaces both.

## What it looks like now, measured

| | entries | groups | rendered |
|---|---|---|---|
| on `iq` | 18 | 6 | 15 rows, 6 headings, **500 px** |
| on `real` | 15 | 7 | — |
| on `iq`, with the eight adapters installed | 19 | 6 | **582 px** |
| on `bits` | 2 | 2 | — |

500 px is **69% of the height of a 720 px laptop viewport**, at the cursor, over the
waterfall. And below about 590 px of viewport height the menu is silently clipped: `.ctx`
is `overflow: hidden` with no scrolling, so at 900 × 540 two of nineteen rows cannot be
reached at all and nothing says so.

Two more things the numbers say:

- **Six headings over fifteen items is two items a heading.** `menu.js` already carries
  the rule — "a heading above two items is a label on a label" — written when the list was
  too *short* for headings. It has grown past that threshold and out the other side.
- **The groups are named after what an operation is, not after what you are doing.**
  Narrow, Demodulate, Decode, Listen, Export, Analyze, Convert. At the moment a drag is
  released you are asking one of about four questions, and Convert, Analyze and Math are
  almost never the answer to a fresh selection.

## Decision

**Two tiers, and what is in the first one depends on the gesture that opened the menu.**

1. **The menu already knows which gesture opened it.** `openMenu(x, y, selection)` takes a
   selection or null, and has since it was written — it uses it to filter `fromSelection`
   operations. That is the discriminator, and it is free:
   - **Released from a selection drag** — you have just drawn a box on a spectrum, and the
     answer is very nearly always to narrow to it. Operations that consume a selection
     lead.
   - **Opened from `+` or `/` on a node** — you are asking what comes next, and the answer
     is the next step along the chain for this stream type.
2. **At most six rows, then `more…`.** The rest expands **in place**, in the same menu, at
   the same position. Not a submenu: no hover target, no travel, no second level.
   ADR-0018's "menu depth stays at 1" survives intact, which is the part of it worth
   keeping.
3. **Rank is a property of the operation**, a small integer in the catalog next to `in` and
   `out`, so the whole ordering is readable in one place rather than emerging from code.
4. **Headings appear only inside the expanded part.** Above the fold there are at most six
   self-describing items and a heading over two of them is noise; below it the runs are
   long enough to be worth labelling.
5. **Search still searches everything**, folded or not. A fold that hides things from the
   search box is a fold that makes the long tail unreachable, which is the problem this is
   supposed to be solving.
6. **The menu scrolls.** A `max-height` and `overflow-y: auto`, because the current
   failure is silent — the rows are simply not there and nothing indicates it.

## The rule for assigning a rank

Not taste, and not usage counts. **Does this operation move the signal toward a result, or
does it answer a question beside it?**

- **First tier — it advances the chain.** Narrowing, demodulating, slicing, framing,
  decoding, and listening. These are the steps [09-demods](../09-demods-and-decoders.md)
  lays out as the pipeline, plus the sink, because hearing it *is* a result.
- **Second tier — everything else.** An analyzer that draws a picture instead of producing
  a stream (hop map, OFDM grid, raster, burst detector); the arithmetic
  ([ADR-0038](0038-a-node-may-have-two-inputs.md)'s math, gain and conversion, which are
  deliberate and rarely the answer to a fresh box); export; and anything whose program is
  not installed.

The last one is worth stating plainly because it looks like a reversal and is not.
[ADR-0013](0013-external-decoders-as-subprocesses.md) says a decoder whose program is
missing stays listed, greyed, naming what to install — and that stays true. It says
nothing about *altitude*. A row you cannot click is information about the box you are on;
it is not an answer to "what do you want to do with this", and it should not be taking a
line above one that is.

## Why the order is not derived from the signal

This tool's instinct is [ADR-0017](0017-auto-manual-parameters.md): never ask what can be
derived. The estimators exist, `Identify` exists, and ranking the menu by what the signal
appears to be is the obvious next thought. It is wrong here, for two reasons and the
second is the real one.

**A menu whose order moves cannot be learned.** ADR-0018's claim is that the gesture
completes itself — drag, release, click. That only holds if the thing you are about to
click is where it was last time. An order that reshuffles with the signal turns every
release into a read.

**ADR-0017 derives values, not intentions.** A deviation, a symbol rate, a threshold, a
tap count: each has a correct answer sitting in the samples, and refusing to go and get it
is the failure that ADR was written against. "What do you want to do with this signal" has
no such answer. It depends on why you opened the tool, and a guess at intent dressed up
with an evidence line would be the first dishonest number in the product.

`Identify` remains the answer to "I do not know what this is" — a deliberate, slow,
reported pass that says what it tried and what it will not claim
([ADR-0031](0031-identify-says-what-it-will-not-claim.md)). It is one click away on the tab
bar, which is the right place for something that takes seconds and produces a report.

## What was rejected

**Two columns.** Purely visual — 196 × 500 becomes about 400 × 260, nothing else changes,
and it is a quarter of the work. Rejected on width: 400 px does not fit inside a 390 px
phone, and ADR-0018 moved the palette to the cursor partly so the waterfall keeps the
screen. A menu twice as wide at the cursor covers the signal it is about.

**Scroll and nothing else.** Fixes the clipping and leaves a 500 px wall. Worth doing
immediately as a bug fix, which is not the same as being a design.

**Keeping every heading and shortening the names.** The names are already the names of the
things; the problem is fifteen of them, not their length.

## Consequences

- **Six is a number in this ADR and it should be checked, not trusted.** It is the count
  that fits the common cases — `Tune here` plus four detectors on IQ, three slicers plus
  `Listen` on a demodulated stream — and if a stream type routinely folds something that
  turns out to be the answer, six is wrong rather than the ranking.
- **The hotkeys already carry the common cases** (`t a f s c l e`), so the menu's job has
  shifted toward discovery and the long tail since they landed. That is an argument for
  this shape and also a reason not to over-invest: the fastest path through the menu is
  increasingly not through the menu.
- **A plugin or a local adapter has no rank**, because it is not in our catalog. It goes in
  the second tier — the same place an uninstalled decoder goes — with the same reasoning:
  it may well be what you want, and it is not what you want *by default*.
- **The fold does not persist.** An expansion that remembers is a preference nobody set,
  and it would put the menu in a different state depending on what you did five minutes
  ago, which is the muscle-memory problem again in a smaller form.

## Would change our mind

If the second tier turns out to be where people spend their time — if `more…` is opened on
most releases — then the ranking rule is wrong, and the honest reading would be that
"advances the chain" is not what a person is doing with this tool most of the time. That
is worth knowing, and it is measurable: the command log ([ADR-0009](0009-command-log.md))
already records every operation applied, so the question of whether the fold is in the
right place has an answer rather than an opinion.
