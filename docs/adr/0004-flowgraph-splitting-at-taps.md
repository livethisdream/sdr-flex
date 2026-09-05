# ADR-0004: Split flowgraphs at taps, not per block

**Status:** Accepted

## Decision

The analysis tree compiles to multiple GNU Radio `top_block`s ("fragments"), split at
**structural boundaries**: the source, and each tuner. Fragments are joined by
shared-memory ring buffers ("taps"). Blocks between two taps live in one fragment.

## Why

The tension: one flowgraph for everything is the fastest at steady state but every
structural edit requires `lock()`/`unlock()` on the whole graph — glitching every
unrelated branch, which UC-3 (multi-channel monitoring) cannot tolerate. A fragment
per block avoids that entirely but pays a copy and a thread hop per block.

Tuners are the natural boundary because:

1. They are where **rates change**, and rate changes are what force rebuilds.
2. They **decimate heavily**, so the copy cost at the tap is small — usually
   10–100× less data than at the source.
3. They are where users actually branch, so the boundary matches the edit pattern.

Result: editing a demodulator rebuilds one small fragment. Sibling branches never
stall. The high-rate path from the source to the first tuner stays in one fragment
and never gets copied more than once.

## Cost

- One extra copy and a buffer's worth of latency per tap.
- Ring buffer plumbing, discontinuity markers, and rate reconciliation across taps
  are code we have to write and get right.
- Cross-fragment tags (GR stream tags) don't propagate for free; the tap protocol
  must carry stream context explicitly (ADR-0007).

## Would change our mind

If `lock()`/`unlock()` on a small fragment still glitches audibly, escalate to
fragment-per-node below the first tuner. If tap overhead dominates, merge fragments
that share a rate. Both are local changes to the compiler, which is why the compiler
is a separate component.
