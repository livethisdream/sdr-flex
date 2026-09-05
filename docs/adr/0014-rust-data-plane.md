# ADR-0014: The hot path never touches Python

**Status:** Accepted
**Supersedes:** the "Python server" row in the original technology table

## Decision

The server is split by plane, not by module:

- **Control plane: Python.** Sessions, graph compiler, plugin registry, command log,
  HTTP API. Everything that changes shape often.
- **Data plane: Rust.** A separate relay process that reads worker output rings via
  shared memory, formats display frames, and fans them out over WebSocket.

Python **configures** the relay ("subscription 7 = ring X, 2048 bins, 30 fps, f32")
and then gets out of the way. No sample, frame, or audio buffer passes through the
Python process.

## Why

The latency budget ([UI principles](../08-ui-principles.md#latency-budget)) allows
**< 4 ms of frame-to-frame jitter**. A Python relay would meet the *throughput*
requirement comfortably — 30 fps × a few MB is nothing — but not the *jitter*
requirement: a GC pause lands as a visible hitch in the waterfall, and this user base
watches waterfalls for a living.

Perceived speed is dominated by consistency, not average throughput. A steady 30 fps
looks better than a lumpy 60. That is a design requirement, so it is an architecture
requirement.

The split also puts each language where it earns its keep. The graph compiler and
plugin registry will be rewritten many times as the design settles — that work is
much faster in Python. The relay is a small, stable, well-specified piece of code
(subscribe, read ring, decimate/format, fan out, drop oldest) that will barely change
after it works. Roughly 1,500 lines.

## Cost

- Two languages in the server. Two build toolchains, two test setups, one FFI-free
  but still real interface between them.
- The shared-memory ring format becomes a contract between Rust, Python, and the C++
  GR workers. It must be specified, versioned, and tested from all three sides.
- A contributor who wants to add a display stream kind has to touch Rust.

## Mitigation

The Python↔Rust interface is deliberately tiny: a control socket carrying subscription
descriptors, and the ring format. It is not a general-purpose binding. If the ring
spec is written once and well, most contributors never see Rust.

## Would change our mind

Nothing, on the jitter argument. If Rust proves to be a contribution barrier, the
same boundary could hold a C++ relay — the decision that matters is that **the hot
path is not garbage-collected**, not which non-GC language it is.
