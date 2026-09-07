# SDR Flex

A modern, extensible signal analysis toolkit.

**Thesis:** you start at the spectrum and drill in. Every time you drag a box on a
waterfall, pick a demodulator, or attach a decoder, the tool builds a GNU Radio
flowgraph behind you. You never author a flowgraph — you get one.

Two constraints shape everything else:

- **Reuse over rewrite.** The field's best decoders already exist. `rtl_433` (250+ ISM
  protocols), `multimon-ng`, `dump1090`, `direwolf`, `dsd`, and the whole GNU Radio OOT
  ecosystem are reachable as plugins for ~20 lines of manifest each. See [reuse](docs/07-reuse.md).
- **Friction is a correctness property.** Six interactions and under 900 px of pointer
  travel from cold launch to decoded bits. 50 ms from dragging a tuner to the child
  spectrum moving. Under 4 ms of frame jitter. These are budgets in CI, not
  aspirations. See [UI principles](docs/08-ui-principles.md).
- **It is an exploratory tool, so nothing is only automatic.** Every derived value —
  and the choice of decoder itself — carries an explicit auto/manual state, and auto
  always shows the evidence it reasoned from.

## Why another one

| Tool | What it gets right | What we take, what we fix |
|---|---|---|
| **GQRX** | Dead-simple workflow: open, tune, listen | Take the workflow. Fix: one demod chain, no extensibility, features bolted on |
| **URH** | Best-in-class decoding and bit-level analysis | Take the analysis views and annotation model. Fix: only reachable for narrow use cases |
| **SDRangel** | Huge plugin ecosystem, power-user depth | Take the plugin breadth. Fix: unintuitive UI, data flow is invisible |
| **GNU Radio / GRC** | Best data-flow model in the field | Take it as the *engine* and export target. Fix: terrible at showing you the data |
| **Sceptre** | Right general workflow, full capability | Take the workflow shape. Fix: cost, nested-menu UX |
| **GNU Radio World** | Browser-based GR — right idea | Take the client-server instinct. Fix: maturity, and start from signals not blocks |

## Docs

- [Vision](docs/01-vision.md) — what this is and what it deliberately is not
- [Workflow & use cases](docs/02-workflow.md) — the interaction model, six worked walkthroughs
- [Architecture](docs/03-architecture.md) — components, data model, execution
- [Plugin model](docs/04-plugins.md) — how third parties extend the chain
- [API sketch](docs/05-api-sketch.md) — control plane and data plane
- [Roadmap](docs/06-roadmap.md) — milestones, each one shippable
- [Reuse](docs/07-reuse.md) — what already exists and how we reach it without rewriting it
- [UI principles](docs/08-ui-principles.md) — the friction contract: interaction and latency budgets
- [Demods & decoders](docs/09-demods-and-decoders.md) — what gets built, in what order, and what "shipped" means
- [Decisions](docs/adr/) — ADRs 0001–0027

## Settled

- **Target hardware:** PlutoSDR and below (≤ 10 MS/s). USRP B205mini and SignalHound
  BB60 named as a future ~60 MS/s tier — not built, not precluded
  ([ADR-0016](docs/adr/0016-performance-envelope.md)).
- **License:** Apache-2.0 core (server, relay, client, plugin SDK, protocol), GPL-3
  for the GNU-Radio-linking worker, with the boundary enforced in CI
  ([ADR-0015](docs/adr/0015-licensing-posture.md)).
- **Primary user:** the analyst chasing unknown signals — with the hobbyist's
  one-click `Identify` as a first-class shortcut *through* that product, not a
  separate mode.

## Status

[M0](docs/06-roadmap.md) is under way in [`web/`](web/) — a static toy model with no
backend, which already tunes, demodulates and decodes the synthetic scene end to end.
Everything else is still planning. [M0](docs/06-roadmap.md) is a static toy model — the real client against a
mock engine in the browser, hosted, no backend. It tests the premise in days and needs
GNU Radio on nobody's machine ([ADR-0021](docs/adr/0021-mock-engine-first.md)).
