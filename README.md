# SDR Flex

A modern, extensible signal analysis toolkit.

**Thesis:** you start at the spectrum and drill in. Every time you drag a box on a
waterfall, pick a demodulator, or attach a decoder, the tool builds a GNU Radio
flowgraph behind you. You never author a flowgraph — you get one.

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
- [Decisions](docs/adr/) — ADRs 0001–0012

## Status

Planning. No code yet. Read [the roadmap](docs/06-roadmap.md) for what M0 looks like.
