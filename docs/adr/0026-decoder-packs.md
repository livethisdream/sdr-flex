# ADR-0026: A decoder ships as a pack — manifest, fixtures and version pin together

**Status:** Proposed — deliberately deferred until three adapters exist to generalize from

## Decision (proposed)

A decoder is distributed as a **pack**: a directory holding its manifest, its golden
capture and expected records (ADR-0025), the version range of the external program it
drives, and its own semantic version. Packs are discovered from a search path, can be
installed without touching the codebase, and declare what they need rather than assuming
it.

## Why this is deferred

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

## Would change our mind

If the first three adapters need no mechanism the current manifest sketch lacks, there is
no pack format to design — a manifest file and a fixtures directory beside it is the
whole thing, and this ADR closes as superseded by ADR-0013.
