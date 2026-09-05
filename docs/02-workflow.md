# Workflow and Use Cases

## The interaction model

### One primitive: the Selection

A **Selection** is a rectangle in the time-frequency plane drawn over any stream.

- Constrain **frequency** → the engine inserts a **Tuner** (mix down, filter, decimate)
- Constrain **time** → the engine inserts a **Gate** (burst extraction, trigger)
- Constrain both → both
- Constrain neither → a pass-through tap you can hang views off

Selections **nest**. A selection over a demodulator's output is a selection in the
baseband plane. That nesting *is* the analysis tree.

### One decision at each step: what next?

At any node, the palette shows only the operations whose input type matches that
node's output type. On `iq` you can tune, demodulate, record, or measure. On `real`
you can filter, listen, view, or slice symbols. On `bits` you can frame, CRC-check,
decode, or diff. The list is short and always correct.

### Three panes, always

```
┌─────────────────────┬────────────────────────────────────────────┬──────────────┐
│ ANALYSIS TREE       │ CANVAS (the selected node's view)          │ INSPECTOR    │
│                     │                                            │              │
│ ▾ 📡 rtlsdr @433.9M │  ┌──────────────────────────────────────┐  │ Tuner "A"    │
│   │  2.4 MS/s       │  │        waterfall / spectrum          │  │              │
│   │                 │  │                                      │  │ center       │
│   ▾ ▭ A  ±25 kHz    │  │   ░░▓█▓░░      ▓█▓                   │  │  433.9201 MHz│
│     │  100 kS/s     │  │  ░░░▓▓░░░  ┌───────┐ ← drag to make  │  │ width        │
│     │               │  │            │  sel  │   a child       │  │  50.0 kHz    │
│     ▾ ∿ AM env      │  │            └───────┘                 │  │ decim  24 ⟳  │
│       │  100 kS/s   │  │                                      │  │ window Hann  │
│       │             │  └──────────────────────────────────────┘  │              │
│       ▾ ⠿ PWM       │  ├──────────────────────────────────────┤  │ ─── palette ─│
│         │  bits     │  │ timeline / scrubber   [◀◀][▶][▶▶]    │  │ + Demodulate │
│         └ 📋 hex    │  └──────────────────────────────────────┘  │ + Record     │
│                     │                                            │ + Measure    │
└─────────────────────┴────────────────────────────────────────────┴──────────────┘
```

- **Left — analysis tree.** The full chain. Each node shows its output type and rate.
  Selecting a node swaps the canvas. Nodes are cheap: adding one never disturbs a sibling.
- **Center — canvas.** The default view for the selected node's output type, plus a
  timeline scrubber that is *always* present and *always* refers to source time.
- **Right — inspector + palette.** Parameters of the selected node above, valid next
  operations below. The palette is the only place you add anything.

Two toggles live in the corner: **Flowgraph** (read-only render of the compiled GR
graph, for the people who want to see it) and **Annotations**.

### What the user never sees

Sample rates they must type. Decimation factors. Filter taps. Block names. Port
connections. Buffer sizes. All derived, all overridable in the inspector under a
disclosure triangle.

---

## UC-1 — Unknown burst on a live dongle (the core loop)

*Persona: hobbyist. Goal: what is my neighbor's doorbell sending?*

1. Launches SDR Flex. Picks `RTL-SDR #0`, types `433.92M`. Waterfall appears. **~4 s
   from launch to spectrum.** No project, no wizard.
2. Sees intermittent narrow bursts around 433.895. Drags a box around them.
   → Node **A** appears in the tree: `Tuner, 433.8950 MHz ±25 kHz, 100 kS/s`.
   The canvas switches to A's waterfall automatically; the bursts now fill the screen.
3. Scrubs back 8 seconds (the ring recorder has it) and drags a *time* box around
   one burst. → Node **B**: `Gate, t ∈ [−7.412 s, −7.374 s], 38 ms`.
   Canvas shows that burst's spectrogram at full resolution.
4. Palette on B offers demodulators valid for `iq`. Picks **AM envelope**.
   → Node **C**, output `real @ 100 kS/s`. Canvas becomes a time-series: a clean
   OOK pulse train. Amplitude histogram in the inspector shows two clusters.
5. Palette on C offers **PWM / PPM slicer**. The slicer's inspector auto-suggests a
   symbol period from pulse-width autocorrelation (`417 µs ±3`). Accepts.
   → Node **D**, output `bits`. Canvas becomes a bit raster.
6. Every burst in the ring lines up in the raster. Preamble is obviously
   `0xAAAA`. Selects those bits, hits **Annotate → "preamble"**. The annotation
   appears as a highlight on the *top-level* waterfall too, on every burst.
7. **Save project.** One YAML file referencing the SigMF capture. Sends it to a friend,
   who opens it and lands on node D with the same view.

**What made this work:** the ring recorder (step 3 scrubs backwards on a *live*
source), type-filtered palettes (steps 4–5 each had ~4 options, not 200), and
provenance (step 6's highlight propagating up). **Six interactions**, cold launch to
bits — see the [interaction budget](08-ui-principles.md#interaction-budget).

### UC-1' — the same signal, the fast way

Steps 1–2 identical. Then, on node **A**, the palette also offers **`rtl_433`
(250+ protocols)** — an [external decoder](07-reuse.md), marked opaque. One click,
and the event table fills with `{"model":"Acurite-609TXC","temperature_C":21.4,...}`.

**Four interactions**, no DSP knowledge required, and it either works immediately or
it doesn't — at which point you fall back to the transparent chain above. Offering
both, clearly labeled, is the whole reuse strategy
([ADR-0013](adr/0013-external-decoders-as-subprocesses.md)).

---

## UC-2 — Recorded IQ forensics

*Persona: RF engineer. Goal: characterize an FHSS signal in a 90-second capture.*

1. `File → Open` a 4 GB SigMF recording. Overview waterfall renders in **under 2 s**
   because the server builds a multi-resolution pyramid of the file (see
   [ADR-0012](adr/0012-server-side-display-rendering.md)) — never ships raw IQ for display.
2. Sees a hopping pattern. Selects the whole hop band → Tuner **A**.
3. On A, applies **Burst detector** (an analyzer, not a transform): produces an
   *event stream* of 1,412 detected bursts with time, center frequency, duration,
   and peak power. Canvas becomes a sortable event table + a scatter of freq vs. time.
4. Clicking any row **seeks the whole tree** to that burst and creates a transient
   Gate. Scatter reveals 79 discrete channels, 400 µs dwell.
5. Attaches a demodulator to the Gate. Pins the demod chain so it *follows* the
   event cursor: stepping through the table re-runs the chain per burst.
6. Exports the event table as CSV, and the annotations back into the SigMF `.sigmf-meta`.

**Architectural demands this makes:** analyzers that emit structured events, not
just samples; the ability to seek a whole subtree; and cheap re-execution of a
subtree over a new time window.

---

## UC-3 — Multi-channel live monitoring

*Persona: monitoring operator. Goal: watch a trunked system.*

1. Live source at 2.4 MS/s. Drags three boxes → Tuners **A**, **B**, **C**, all
   siblings, all live and independent.
2. A gets `P25 control channel decoder` (a plugin) → event stream of grants.
3. B and C get `P25 voice` → audio. Both play; a mixer strip appears with per-node
   mute/solo/gain.
4. Switches the canvas to **Grid layout**: four tiles — source waterfall, A's event
   log, B and C's audio meters — updating simultaneously.
5. A grant event on A auto-retunes C via a **link**: `C.center_hz ← A.events.last.freq`.
   Links are a first-class, declarative binding between an event field and a hot
   parameter. This is the one piece of "programming" exposed in the GUI, and it is
   deliberately limited to that shape.

**Architectural demands:** N independent live subtrees off one source without
mutual glitching ([ADR-0004](adr/0004-flowgraph-splitting-at-taps.md)); hot parameter
updates at event rate ([ADR-0010](adr/0010-hot-vs-cold-parameters.md)); multi-view layout.

---

## UC-4 — Bring your own block

*Persona: DSP developer. Goal: use my own equalizer inside this workflow.*

1. Writes a GNU Radio hier block, or reuses one from an OOT module.
2. Drops a manifest next to it:

```yaml
id: acme.eq.cma
name: CMA Equalizer
version: 0.2.0
category: transform
implementation:
  kind: gr_hier
  module: acme_eq
  class: cma_equalizer
ports:
  in:  { type: iq }
  out: { type: iq, sample_rate: same_as_input }
params:
  - { id: taps,  type: int,   default: 11, min: 3, max: 129, hot: false }
  - { id: mu,    type: float, default: 1e-3, scale: log, hot: true }
views:
  default: constellation
```

3. Restarts (or hits **Rescan plugins**). "CMA Equalizer" now appears in the palette
   **only on nodes whose output is `iq`**. `mu` is a live-draggable slider; `taps`
   shows a rebuild indicator. The constellation view is picked automatically.
4. No UI code was written. See [the plugin model](04-plugins.md).

**This is the whole extensibility bet:** the manifest's type and hotness declarations
are enough for the GUI to place, filter, and render the block correctly.

---

## UC-5 — Headless batch reproduction

*Persona: analyst with 400 captures. Goal: run yesterday's finding across all of them.*

```bash
sdrflex run analysis.sdrflex.yaml \
        --source-glob '/data/2026-09-*/**/*.sigmf-meta' \
        --emit node:D --format jsonl \
        --parallel 8 > decoded.jsonl
```

Same server, same graph compiler, no GUI. The project file from UC-1 *is* the batch
job. Any node can be named as an output tap. This falls out of
[ADR-0001](adr/0001-client-server-split.md) at no extra cost — the GUI has no
privileged path into the engine.

---

## UC-6 — Handoff and review

*Persona: two people, one signal.*

1. Analyst saves `doorbell.sdrflex.yaml` — tree, parameters, view layout, annotations,
   and a content hash of the source capture. It is ~6 KB of YAML and diffs cleanly in git.
2. Colleague opens it against the same capture. Identical state, including which node
   was selected and where the scrubber was.
3. Colleague changes the slicer threshold. `git diff` shows one line changed, because
   the project file is a serialization of the command log
   ([ADR-0009](adr/0009-command-log.md)), not an opaque blob.

---

## What these use cases jointly require

| Requirement | Comes from | ADR |
|---|---|---|
| Scrub backwards on a live source | UC-1.3 | [0005](adr/0005-all-sources-are-time-indexed.md) |
| Palette filtered to valid ops | UC-1.4, UC-4.3 | [0006](adr/0006-semantic-stream-types.md) |
| Annotations propagate up the tree | UC-1.6 | [0007](adr/0007-stream-context-and-provenance.md) |
| Instant overview of a 4 GB file | UC-2.1 | [0012](adr/0012-server-side-display-rendering.md) |
| Analyzers emitting structured events | UC-2.3, UC-3.2 | [0006](adr/0006-semantic-stream-types.md) |
| N live branches, no cross-glitching | UC-3.1 | [0004](adr/0004-flowgraph-splitting-at-taps.md) |
| Live param drags vs. rebuilds | UC-3.5, UC-4.3 | [0010](adr/0010-hot-vs-cold-parameters.md) |
| Third-party blocks with zero UI code | UC-4 | [0006](adr/0006-semantic-stream-types.md), [plugins](04-plugins.md) |
| Headless, scriptable, reproducible | UC-5 | [0001](adr/0001-client-server-split.md) |
| Git-friendly project files | UC-6 | [0009](adr/0009-command-log.md) |
| Existing CLI decoders usable as nodes | UC-1', UC-3.2 | [0013](adr/0013-external-decoders-as-subprocesses.md) |
| Drag feels attached to the cursor (<50 ms) | UC-1.2, UC-3.5 | [0014](adr/0014-rust-data-plane.md), [0010](adr/0010-hot-vs-cold-parameters.md) |
