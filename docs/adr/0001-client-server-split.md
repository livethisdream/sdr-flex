# ADR-0001: Client-server split; the GUI has no privileged path

**Status:** Accepted

## Decision

The engine is a server with an HTTP control plane and a WebSocket data plane. The
GUI is one client among several. Anything the GUI can do is expressible as API calls,
and the GUI gets no in-process shortcut, no private RPC, and no hidden state.

## Why

- The UI is the part most likely to be rewritten. Rewriting it must not mean
  rewriting the engine — that's the failure mode that made GQRX's features
  "hard to get to."
- Headless batch, the Python SDK, and reproducibility (UC-5, UC-6) are free
  consequences rather than parallel implementations.
- The engine can run on the machine with the radio while the UI runs elsewhere.

## Cost

- Everything is a round trip. State that a monolith would read from a variable is
  a request, so the client must mirror the tree and reconcile.
- Two representations of every concept: server model and client model.
- Debugging spans a process boundary.

## The discipline that makes it work

**If a feature is easier to build by adding a private path for the GUI, that's a
signal the API is wrong.** Fix the API. The first time an exception is granted, the
second client stops being cheap and the property is gone.

## Would change our mind

Nothing short of the round-trip latency making direct manipulation feel bad, which
we test at M1. Even then the fix is optimistic local prediction on the client, not
collapsing the split.
