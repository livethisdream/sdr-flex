# ADR-0022: Language is a peer client, not a replacement for the GUI

**Status:** Accepted (design); build deferred to M6

## Decision

Add a conversational interface as **another client emitting the same commands into
the same log** ([ADR-0009](0009-command-log.md)) through the same API
([ADR-0001](0001-client-server-split.md)). It gets no privileged path, no private
capabilities, and no separate mode.

It does **not** replace direct manipulation. The two split by a rule that falls out of
the latency budget:

| | Belongs to |
|---|---|
| Continuous, spatial, tuned by feel — drag a filter edge, scrub a threshold, set a dB range | **Direct manipulation** |
| Nameable, multi-step, repeated, or *interrogative* — "tune 433.80 AM", "why is this decode failing?", "do that to the other three bursts" | **Language** |

## Why this is worth doing

Three things language does that no menu can:

1. **It collapses a chain into one utterance.** "Tune 433.80 and demodulate AM" is
   four interactions reduced to one.
2. **It solves the unknown-unknowns problem** — the exact discoverability gap the
   contextual menu has ([ADR-0018](0018-contextual-menus-and-view-tabs.md)). You can
   ask for something whose name you do not know. A menu can only show you things you
   can already recognise.
3. **It answers questions, which is the genuinely new part.** *"Is that AM?"* is not a
   command. An analyst's real work is full of questions a GUI structurally cannot
   answer: what modulation is this, is this the same emitter as that one, why did my
   decode stop working. A tool that can run analyzers over the actual samples and
   answer is doing something menus cannot do at any level of polish.

And the third one is where repetition lives too: **"do the same thing to the other
three bursts"** is trivial to say and miserable to express by pointing.

## Why it cannot be the whole interface

- **Latency.** The product is built around a 50 ms drag-to-pixel budget
  ([UI principles](../08-ui-principles.md#latency-budget)). A model round trip is
  seconds. Anything you tune *by feel* — filter width, slice threshold, dB range — is
  not expressible in chat at any acceptable latency. Dragging a box will always beat
  describing one.
- **Precision.** "That signal" is ambiguous; a box is not. Direct manipulation is
  exact and instantly reversible; language needs confirmation loops, which put the
  friction back.
- **A blank chat box is as intimidating as a blank flowgraph.** If capability lives
  only behind free text, we have rebuilt "powerful only if you already know the
  answer" — the GRC failure — in a new costume.
- **Assertions are not evidence.** If it says "that's AM", an analyst needs to know
  on what basis. Same standard [ADR-0017](0017-auto-manual-parameters.md) already sets
  for auto: **show your work**, or the answer is worthless.

## What the architecture already gives us

This is close to free, and that is not a coincidence — it falls out of two decisions
already made:

- **Every action is a command in the log.** So the assistant cannot do anything the
  GUI cannot, everything it does appears as ordinary nodes in the tree, and
  **Cmd-Z undoes it**. An assistant whose mistakes are one keystroke from gone is a
  very different proposition from one that mutates hidden state.
- **The palette is already typed and machine-readable** ([ADR-0006](0006-semantic-stream-types.md)).
  The set of valid operations at any node — with parameters, ranges and units — is
  exactly the tool schema a model needs. We do not have to write one.
- **Answers reuse the evidence views.** "Is that AM?" runs the real classifier and
  opens the same evidence view the `⟲ auto` marker opens. The reply cites the view;
  it does not replace it.

## Consequences

- The assistant is a **client**, so it works against the mock engine too, and a
  headless script can drive the same commands.
- Every assistant turn ends with visible nodes and a normal undo point. No "applying
  changes…" that cannot be inspected.
- It must be able to say **"I don't know"** and hand back a narrowed selection rather
  than guess. A confident wrong answer about a modulation is worse than no answer.
- Free text is never the only route to a capability: anything it can do is reachable
  from the menu, and anything it *did* is visible as nodes.

## The cheap way to test it early

A **command bar with no model at all** — typed, parsed, deterministic:
`tune 433.895 50k`, `demod am`, `slice pwm`. It proves the whole architecture (language
in → commands into the log → nodes out) with no inference latency, no API key, and
nothing to host — which means it can ship inside the static M0 toy. If that feels
good, the model is an upgrade to the parser, not a redesign. If it does not, we learned
it for a day's work instead of a milestone's.

## Would change our mind

If the command bar turns out to be where people live rather than an accelerator,
direct manipulation is failing somewhere and the fix is there, not in more language.
