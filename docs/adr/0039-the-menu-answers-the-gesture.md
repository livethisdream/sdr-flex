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
| on `iq`, with none installed, once they are hidden | 14 | 6 | — |
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
  deliberate and rarely the answer to a fresh box); and export.

## A decoder whose program is not installed is not in the menu at all

Not greyed in the second tier — absent. The menu answers "what do you want to do with
this", and a decoder that cannot run is not an available answer at any altitude.

**This overturns a convention, not a decision, and the distinction matters.** An earlier
draft of this ADR said [ADR-0013](0013-external-decoders-as-subprocesses.md) requires a
missing program to stay listed. It does not — ADR-0013 is about the subprocess mechanism,
opacity, isolation and licensing, and says nothing about the menu. The greyed-row rule
lives in `docs/10-adding-a-decoder.md`, `server/README.md` and `docs/04-plugins.md`: three
pieces of documentation describing a behaviour nobody ever argued for. It is being changed
here rather than quietly, and those three pages change with it.

**The obligation it was protecting is real and is met elsewhere.** You cannot install what
you do not know exists, and this tool's coverage story is "250 protocols, through
`rtl_433`" — a box without `rtl_433` must not silently be a worse tool with no way to find
out. Two surfaces already carry that, and both are better than a dead menu row:

- **`Identify` names every decoder it could not try**, with the reason, and has since it
  was written ([ADR-0031](0031-identify-says-what-it-will-not-claim.md)) — "nothing
  decoded this" and "nothing that could decode this was tried" are different answers, and
  the report keeps them apart. `identify.js` pushes `<command> is not installed on this
  machine` onto `skipped`, `identview.js` renders it, and a test pins it. That is the right
  place: you asked what this signal is, and the honest answer includes what was missing.
- **The server says so at startup**, as a count of how many of the table it found.

So the discovery path is not being removed. It is being moved off the surface that answers
a different question.

**The radio picker keeps the old behaviour, and the reason is written down there.**
`server/README.md` makes the argument for it: a driver whose capture program is missing
stays listed, greyed, saying what it wants, because "that is a five-second problem, and a
menu that hides the option instead is a twenty-minute one." That is right, and it is right
*because of the surface*. Choosing a radio is a short explicit list of eight things you
are deliberately browsing; "rtl-sdr — needs rtl_sdr" is the sentence you needed. The
operation menu is eighteen rows over the signal, opened by a gesture, answering a
different question. The same behaviour is correct in one and clutter in the other, and
this ADR changes only the second.

**One case is not the same** and is deliberately left as it is: a decoder *you* added,
through `SDRFLEX_ADAPTERS`, whose program is missing. You wrote that manifest and expected
it to run, so its absence is a mistake to be told about rather than a capability you have
not discovered — and silence is the wrong answer to a mistake. The server already reports
adapter load failures at startup; if a pack that loads but cannot run turns out to be
silent, that is a gap to close there and not a reason to put dead rows back in the menu.

## "Not installed" and "not built yet" are different, and have been sharing a badge

`palette()` sets `stub: !available` on an adapter whose program is missing, and `OPS` sets
`stub: true` on `core.burst_detector`, the one built-in operation that is not written. The
menu renders `<span class="soon">M4</span>` for both — so a machine without `rtl_433` is
told that rtl_433 arrives in a future milestone.

They are not the same state and they do not have the same remedy. One is `apt install
rtl-433`; the other is waiting for us. With uninstalled decoders gone from the menu
entirely, `stub` goes back to meaning only the second, and `M4` becomes true again.

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
  the second tier: it may well be what you want, and it is not what you want *by default*.
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
