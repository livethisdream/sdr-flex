# ADR-0009: All state changes go through a serializable command log

**Status:** Accepted

## Decision

Every mutation — add node, delete node, set parameter, annotate, move the scrubber —
is a command appended to a per-session log. Session state is the fold of the log.
The project file is a serialization of the log.

## Why

Five features that are usually five separate subsystems become one mechanism:

| Feature | Implementation |
|---|---|
| Undo/redo | Truncate and replay |
| Project save/load | Serialize/replay the log |
| Crash recovery | Replay the log into a fresh worker (ADR-0003) |
| Scripting/batch | The SDK emits the same commands |
| Reviewable diffs | The log is line-oriented YAML; `git diff` is meaningful (UC-6) |

Retrofitting undo and project files onto mutable state is a rewrite. Adopting this
at M2 costs almost nothing; adopting it at M6 costs the whole model layer.

## Cost

- Every mutation path must go through the log. No sneaky in-place edits — the same
  discipline ADR-0001 demands, and it fails the same way if broken once.
- The log grows. Needs periodic compaction (fold to a snapshot + tail) for long
  sessions with a lot of parameter dragging.
- High-frequency hot-parameter changes (dragging a slider at 60 Hz) must be
  **coalesced** before they hit the log — a drag is one command with a final value,
  with intermediate values sent on the data plane only.

## Would change our mind

Nothing. The cost is small and paid once; the alternative is paid forever.
