# ADR-0029: The client owns the clock; the server answers about moments

**Status:** Accepted — implements [ADR-0001](0001-client-server-split.md) and
[ADR-0021](0021-mock-engine-first.md) for the first real engine

## Decision

The engine moves out of the browser and behind a WebSocket. Three things make that
possible without changing the interface the UI was written against:

1. **The graph is mirrored, not queried.** Which node is where, what a node's time is,
   whether an ancestor pinned it — all of it is pure structure, all of it is needed
   synchronously while painting, and none of it touches a sample. It lives in
   `graph.js`, which both engines extend. Every mutating call returns a full graph
   snapshot and the client replaces its copy wholesale.
2. **The client owns the playhead.** `tick` runs on the mirror, and every read carries
   the absolute moment it wants. **The server keeps no clock at all.**
3. **`frame` reads the latest answer rather than asking a question.** It returns the
   most recent frame for that node and those options, and kicks off the next request
   when none is in flight. Before the first has arrived it returns `{ kind: 'pending' }`.
   For the waterfall's prefill, which settles all of its row times before drawing,
   `prefetch` states the whole plan and the rows come back in batches of 64.

Two things deliberately do **not** move to the server:

- **Plugins stay in the tab.** A plugin is JavaScript somebody dropped on the window.
  In a browser that is a sandbox; on the server it is arbitrary code running as the
  server, against every capture on the box, at the invitation of anything that can
  reach the port. The server produces `bytes`; the tab runs the decoder over them.
- **Captures stay on the server.** The library is a directory scan. The client names a
  capture by id and never sees the file.

## Why

**Why mirror the graph rather than query it.** The alternative is making the accessors
async, which means the paint path awaits, which means the paint path is no longer a
paint path. The graph is a few dozen nodes with a dozen parameters each — a few
kilobytes. Sending all of it on every change is cheaper than reconciling deltas and far
more obviously correct: the failure mode of a bad delta is a parameter that reads one
value and behaves like another, which is exactly the bug that is hardest to see.

**Why the client owns the clock.** If the server held the playhead, every frame request
would have to agree with it about *when*, two tabs would drag each other around, and a
dropped connection would lose the user's position. With the moment travelling in the
request, a reconnect loses pixels and nothing else, and the server becomes a pure
function of (graph, moment) — which is also what makes the parity test possible.

**Why `frame` returns stale data rather than waiting.** A live display that waits is a
display that stutters when the link does. A live display that shows the last thing it
got runs at whatever rate the link supports and degrades to a lower frame rate instead
of a growing queue. It is one round trip behind the engine, which on a tailnet is about
a millisecond.

**Why this was worth doing now.** The browser had to hold the whole capture: 360 MB of
`cu8` became a 360 MB `ArrayBuffer` in the tab, 5.5 s to load and 386 MB resident for as
long as you looked at it. The server reads a window of the file and keeps the last one,
so a 256 MB capture costs 18 MB resident and a 40 GB one costs the same.

## Costs

- **A second implementation of the engine interface.** `RemoteEngine` is about 300
  lines that must stay in step with `MockEngine`. The parity test exists to make
  divergence fail loudly rather than quietly: same calls, same graph, same frames, bit
  for bit.
- **`frame` can return `pending`, and callers must handle it.** They already had to
  handle `stub` and `none`, so this is a third case rather than a new idea — but the
  waterfall prefill had to learn not to advance past a row that has not arrived, or it
  leaves a gap nothing ever fills.
- **A hand-written WebSocket server.** About 150 lines instead of a dependency. The
  trade is a repository that still installs nothing and an image with no third party in
  it, against RFC 6455 framing being ours to get right. It is the most carefully tested
  file in the project for that reason, and the handshake was wrong in a way only a real
  browser caught.
- **Drag-and-drop no longer opens a capture when there is a server.** The file is on
  the wrong machine. It says so and opens the library instead.
- **No authentication.** The intended deployment is a tailnet, where the network is the
  boundary. That is a reasonable posture there and a poor one anywhere else, so the
  bind address defaults to the tailnet interface and falls back to loopback — never to
  every interface — and the port publish in `docker-compose.yml` is scoped to one host
  address.

## What would change our minds

- **If the DSP moves to Python or Rust.** The transport contract is the durable part
  and would survive; `MockEngine` doing double duty as the server's engine would not.
  The class is still called `MockEngine` on the server, which is now the wrong name and
  a rename waiting for that moment.
- **If two people ever need the same session.** The client owning the clock is exactly
  what makes that not work. A shared session needs a server-side playhead and an
  explicit answer about who moves it.
- **If a plugin needs more than kilobytes of input.** The reason plugins can stay in the
  tab is that `bytes → events` is cheap to ship. A plugin that wants IQ would have to
  run where the samples are, and that reopens the sandboxing question this ADR ducked.
