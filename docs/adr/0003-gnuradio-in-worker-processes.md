# ADR-0003: GNU Radio runs in worker processes, one per source session

**Status:** Accepted

## Decision

The server never imports GNU Radio into its own process. Each source session gets a
worker process that owns its flowgraph fragments. Server↔worker communication is ZMQ
for control and events, shared-memory rings for bulk samples.

Considered and rejected: (a) GR embedded in the server — one bad plugin kills every
session, and the GIL serializes unrelated work; (c) not using GR at runtime and
implementing DSP natively — throws away the block ecosystem that is the main reason
to build on GR at all.

## Why

- **Crash containment.** GR blocks and OOT modules segfault. That must cost one
  session, not the whole server (see the failure table in the architecture doc).
- **The GIL.** Multiple sessions and the display renderer must actually run in
  parallel.
- **Clean restart.** Worker state is rebuildable by replaying the command log
  (ADR-0009), so restart-on-crash is a real recovery path, not a hope.
- **Install isolation.** A worker can run in a different environment than the
  server — the escape hatch for GR version conflicts between plugins.

## Cost

- IPC on every sample that crosses the boundary. Mitigated: bulk data uses shared
  memory rings, not the ZMQ broker, and the display path reads the media store
  directly via mmap.
- Process supervision, health checks, and orphan cleanup are now our problem.
- Harder to debug: a stack trace lives in another process. Requires deliberate work
  on log aggregation and surfacing tracebacks in the node's UI, from M1.

## Would change our mind

Nothing. Process isolation around a C++ DSP framework is close to non-negotiable.
