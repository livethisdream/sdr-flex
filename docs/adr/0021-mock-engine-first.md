# ADR-0021: The client is built first, against a mock engine

**Status:** Accepted

## Decision

The first thing built is a **static client running against a mock engine inside the
browser** that implements the same protocol the real server will. It is deployed as a
static site with no backend.

The mock is **not throwaway**. It stays forever as three things: the public demo, the
deterministic fixture for the UI budget tests in CI, and an offline mode.

## Why

The largest uncertainty in this project is not DSP — it is whether the interaction
model feels good. Drag-release-menu, breadcrumb navigation, stacked spectrum and
waterfall, the cell strip, auto/manual: every one of those is a bet, and none of them
needs a signal-processing engine to evaluate.

This is a direct payoff of [ADR-0001](0001-client-server-split.md). Because the GUI
has no privileged path into the engine, "the engine" can be four hundred lines of
JavaScript, and the client cannot tell. If a mock could *not* stand in for the server,
that would be evidence ADR-0001 had already been violated.

Concretely it buys:

- **Days instead of weeks per iteration** on the thing the project is pickiest about.
- **A link.** Anyone can try the workflow with no install — including the newcomer
  whose failure to find the contextual menu is the stated trigger for reconsidering
  [ADR-0018](0018-contextual-menus-and-view-tabs.md). That test is otherwise gated
  behind a GNU Radio install.
- **No GNU Radio on anyone's machine** to evaluate the design.
- **A permanent CI fixture.** The interaction-count and pointer-travel budgets need a
  deterministic backend to run against; a mock is better for that than the real engine,
  forever.

## The mock injects the latency budget

**This is the part that makes it honest.** A local JavaScript mock responds in
microseconds. Tuning the interface against that produces something that feels worse
the day it meets a real pipeline — you would have optimised against a backend that
cannot exist.

So the mock deliberately spends the
[latency budget](../08-ui-principles.md#latency-budget): ~40 ms before a parameter
change takes visible effect, frames capped at 30 fps with realistic jitter, and a
simulated rebuild pause on cold parameters. The prototype should feel exactly as fast
as the real thing will — no faster.

## Cost, and the discipline

- **The mock can grow into a second implementation.** The rule: it may only implement
  behavior the real engine will have, and it is never the place a feature ships
  first. A capability that exists only in the mock is a bug.
- **It cannot validate what it fakes** — real jitter, real throughput, DSP
  correctness, or anything at scale. M1 exists for that, and the roadmap says so.
- The protocol must be specified early enough for two implementations, which is a real
  cost — and also exactly the forcing function that keeps ADR-0001 honest.

## Hosting

Static hosting only; the choice is not architectural, so pick on constraints:

| | Private repo | Custom headers | Notes |
|---|---|---|---|
| **GitHub Pages** | Paid plan only | **No** | Simplest if the repo is public |
| **Cloudflare Pages** | Free | Yes, via `_headers` | Free tier is generous |
| **Netlify** | Free | Yes | Comparable |

The headers column matters later, not now: multithreaded WASM needs `SharedArrayBuffer`,
which needs COOP/COEP headers that GitHub Pages cannot set. Single-threaded WASM and
plain JavaScript are unaffected, so this only bites if the mock's DSP ever goes
multithreaded — at which point the real engine probably exists anyway.
