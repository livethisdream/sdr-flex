# ADR-0005: All sources are time-indexed media; live sources are recorded

**Status:** Accepted

## Decision

Every source presents the same interface: a **time-indexed, randomly-addressable
medium**. Files are that natively. Live sources become that by being written to a
ring recording as they arrive. All downstream machinery — gates, scrubbing, zoom
queries, re-running a subtree — sees only the medium, never "live" vs. "file."

## Why

This is the single decision that separates this tool from GQRX and URH both.

GQRX is live-only, so you can never go back and look at what just happened. URH is
file-only, so it can't be used at the antenna. The split is not inherent — it's an
artifact of each tool's ingest model. Unifying it means:

- Scrub backwards on a live dongle (UC-1.3)
- Zoom into a burst *that already passed* at full resolution
- Re-run a modified chain over history without recapturing
- One code path for gates, seeks, and pyramid rendering

Every one of the workflow's best moments depends on it.

And one of them is not merely better but *only possible* this way. Constraining time
means drawing a box on a scrolling display, where the rows move under the pointer as
you drag — so time selection needs the display frozen, and a frozen stream is a still
image with no history behind it. A frozen **medium** keeps every past sample
addressable. Without the ring, the time half of the selection primitive
([ADR-0002](0002-selection-is-the-primitive.md)) simply does not function on a live
source ([ADR-0023](0023-frequency-makes-a-channel.md)).

## Cost

- **Disk bandwidth and space.** 2.4 MS/s cf32 is ~19 MB/s. Mitigations: default the
  ring to complex int16 (~9.6 MB/s), default the window to 60 s, make both settings
  prominent, and surface ring fill level in the status stream.
- Retention policy becomes a user-visible concept, which is a small UX tax.
- "Promote ring to permanent capture" is a feature we now must build.

## Would change our mind

For very high-rate sources (>50 MS/s) the ring may have to become optional or
lossy-by-decimation. Handle that as a source-level setting, not by reintroducing the
live/file split.
