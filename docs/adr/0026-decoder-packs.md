# ADR-0026: A decoder ships as a pack — a manifest and its fixtures in a directory

**Status:** Accepted — the deferral condition was met at six adapters, and the format is
smaller than this ADR expected

## Decision

A decoder is distributed as a **pack**: a directory holding its manifest, its golden
capture and expected records (ADR-0025), the version range of the external program it
drives, and its own semantic version. Packs are discovered from a search path, can be
installed without touching the codebase, and declare what they need rather than assuming
it.

## What it turned out to be

Smaller than the sketch, because the six adapters that came before it answered the
questions rather than leaving them open. A pack is a directory holding a manifest and,
optionally, a flowgraph and its golden capture. `SDRFLEX_ADAPTERS` names where the
directories live. No registry, no install step, no state that can disagree with the disk
— the same shape as the capture library and the plugin directory.

The mechanisms the format needs were each forced by a real adapter rather than guessed:

| mechanism | the adapter that demanded it |
|---|---|
| several candidate binary names | `dump1090`, which ships as `dump1090-mutability` and `dump1090-fa` |
| a module inside an interpreter, not a name on PATH | a GNU Radio flowgraph ([ADR-0032](0032-a-flowgraph-is-a-program.md)) |
| a container in front of the samples | `minimodem`, which refuses headerless bytes on a pipe |
| a config file written per run | `direwolf`, which will not start without one |
| a rate that follows a parameter | LoRa, sampled at a multiple of its bandwidth |
| a flag omitted along with its value | `rtl_433 -R`, where "no protocol" is not "all protocols" |
| four different ways of reading output | all of them |

One question this ADR expected to have to answer **did not come up**: how a socket
transport differs from stdout in the manifest. `direwolf` was the reason to expect it, and
`direwolf` turned out to read stdin and write stdout like everything else once it was
given a config file. There is no transport field, and there will not be one until a
decoder needs it.

The **version pin** also did not survive. Pinning a program's version means checking it,
which means parsing `--version` output for six programs that each format it differently,
to produce a warning nobody can act on — the user has the version their distribution
gave them. What replaced it is the conformance fixture: a golden capture in the pack says
whether *this* version of *this* program still produces the expected records, which is
the question a version pin was a proxy for.

## The trust line

An adapter is a command line. Anything that can write to `SDRFLEX_ADAPTERS` can run
programs on the box — so the directory's permissions are the control, and the loader
refuses a world-writable one.

That is why a pack is a directory on the box and **not** a drop target in the browser.
The rule that dropped code runs in the tab and never on the server
([ADR-0029](0029-the-client-owns-the-clock.md)) has not moved: a plugin is something
anybody can hand you, an adapter is something you put on your own machine on purpose, and
the capture and plugin directories already sit at exactly this trust level.

A local adapter cannot take an id that ships with the tool. Silently shadowing `rtl_433`
with something else called `rtl_433` would be a very confusing afternoon, and the menu
badges a decoder you added as **yours** rather than **ext** for the same reason.

## Why this was deferred

The plugin manifest schema exists on paper ([plugins](../04-plugins.md)) and has never
been through the experience of a second and third real adapter. The questions a pack
format has to answer — how a program's version is pinned and checked, what happens when
it is missing, whether fixtures ship with the pack or with the app, how a socket
transport differs from stdout in the manifest, how a pack declares a rate constraint the
engine must honor upstream rather than resample into — are all questions the first three
adapters will answer by forcing the issue.

Writing the format first means writing it from imagination. `rtl_433` (stdout, JSON),
`direwolf` (KISS over TCP) and `dump1090` (a rate the source must supply, not a rate we
can resample to) between them exercise every mechanism the format needs, which is why
they are ordered that way in the
[demod and decoder plan](../09-demods-and-decoders.md#wave-3--the-adapter-layer-m45-then-m5).

## What is already settled and will not change

- The **manifest declares what the program wants**; the engine derives the conversion
  and resampling chain (ADR-0013). A pack author never wires a converter.
- Fixtures are **part of the unit**, not a separate repository (ADR-0025).
- External nodes are **opaque and marked so**; a pack cannot opt out of that.

## What happened to "would change our mind"

It said: if the first three adapters need no mechanism the manifest sketch lacks, there
is no pack format to design — a manifest file and a fixtures directory beside it is the
whole thing. That is very nearly what happened. The format is a manifest file and a
fixtures directory beside it; it gained six small fields, all of which a real adapter
demanded, and lost the two the sketch was proudest of. Documented in
[adding a decoder](../10-adding-a-decoder.md).
