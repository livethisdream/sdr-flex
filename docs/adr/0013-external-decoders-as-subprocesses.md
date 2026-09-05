# ADR-0013: External decoders are first-class subprocess plugins

**Status:** Accepted

## Decision

`process` is a first-class plugin implementation kind, a peer of `gr_hier` — not an
escape hatch. A manifest declares a command line, the sample format and rate the
program wants on stdin, and how to parse its stdout. The engine derives the
conversion and resampling chain automatically.

Nodes backed by an external process are marked **opaque**: no drill-down, approximate
provenance, visibly distinct in the UI.

## Why

The largest body of proven decoding in this field ships as standalone Unix programs
that already agreed on an interface — samples in, records out. `rtl_433` alone is
250+ ISM protocols. `multimon-ng` is ~15. `dump1090` is ADS-B. `direwolf` is APRS.
`dsd` is four digital voice modes. Each is roughly 20 lines of manifest.

Writing those natively is years of work and would be worse, because these
implementations have absorbed a decade of real-world signal weirdness.

The subprocess boundary also buys two things we would otherwise pay for separately:

- **Isolation** — a segfaulting decoder kills a pipe, not a session (ADR-0003 one
  level down).
- **License separation** — arms-length aggregation rather than derivative linking
  (ADR-0015).

Three benefits, one mechanism, one pipe copy. Every external decoder sits after heavy
decimation (audio rate to a few hundred kS/s), so the copy is single-digit MB/s.

## Cost

- **Opacity.** You cannot see inside `rtl_433`, adjust its slicer, or annotate an
  intermediate stage. This is the exact opposite of URH's value proposition.
- Provenance can only be approximate — `t0` plus an estimated pipeline latency
  (ADR-0007 already admits `approximate`).
- Process supervision, restart policy, zombie reaping, and surfacing a non-zero exit
  code as a legible node error are all now our problem.
- Version drift: a user's `rtl_433` may not match the manifest's assumptions.
  Manifests declare a version constraint and the Plugins panel reports mismatches.

## The resolution, not a compromise

We ship **both paths and label the difference**:

- **External processes for breadth.** Get to a decoded result in one click, across
  enormous protocol coverage.
- **Native/GR chains for depth.** Every stage a node, every parameter adjustable,
  exact provenance — for when you need to *understand* the decode, or when nothing
  exists yet.

"Try `rtl_433` first; build the chain yourself if it doesn't recognize the signal" is
the workflow an analyst actually wants. Offering only the transparent path is URH's
narrowness; offering only the opaque path is a launcher, not an analysis tool.

## Would change our mind

If opaque nodes turn out to confuse users about what the tool can do, the answer is
better UI marking, not removing the capability.
