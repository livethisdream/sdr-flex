# ADR-0007: Stream context and provenance travel with every stream

**Status:** Accepted

## Decision

Every stream carries, alongside its samples:

- `center_hz` — absolute RF center, propagated through every tuner
- `sample_rate`, and `t0` as an absolute timestamp of sample zero
- `provenance` — the node path back to the source, with the rate and offset
  transformation at each hop

This is enough to map any sample at any depth back to a `(source_id, sample_index)`.

## Why

Two capabilities depend on it, and both are things the existing tools do badly:

1. **Absolute frequency at any depth.** A spectrum four tuners deep still labels its
   axis in real RF frequency, because the offsets composed along the way are known.
   Every tool that shows you "baseband" and makes you do the arithmetic is failing here.
2. **Annotations propagate up.** Select bits in a decoder view at depth 4, label them
   "preamble," and the highlight appears on the top-level waterfall on every matching
   burst (UC-1.6). That inversion — from a decoded artifact back to the raw samples
   that produced it — is the feature that makes analysis feel joined-up instead of a
   series of disconnected windows.

It has to be designed in from the start. Retrofitting provenance means touching every
block interface and every view.

## Cost

- The tap protocol must carry context across fragment boundaries; GR stream tags
  don't cross `top_block`s for free (see ADR-0004).
- Blocks with non-invertible time mapping (arbitrary resamplers, variable-rate
  decoders) can only report an approximate mapping.
- Every plugin must declare its rate/time transformation, or accept `approximate`.

## Consequence

Annotations anchor in **source** coordinates, never node coordinates. A node can be
deleted without orphaning findings made through it.
