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

At any node, the menu shows only the operations whose input type matches that node's
output type. On `iq` you can tune, demodulate, record, or measure. On `real` you can
filter, listen, view, or slice symbols. On `bits` you can frame, CRC-check, decode, or
diff. The list is short and always correct — which is precisely why it can live at the
cursor instead of on the wall.

### The canvas gets the window

Actions come to the cursor. State gets a persistent surface. Views are tabs.
([ADR-0018](adr/0018-contextual-menus-and-view-tabs.md))

```
┌──────────────────────────────────────────────────────────────────┐
│ rtl-sdr #0 ▾ › A · Tuner ▾ › B · Gate ▾ › C · AM ▾ › D · PWM ▾   │ breadcrumb
├──────────────────────────────────────────────────────────────────┤
│ Spectrum │ C · AM env │ D · PWM │ Flow │ +                      │ block tabs
├──────────────────────────────────────────────────────────────────┤
│      ╱╲        ╱╲                                           ▓    │ live + peak
│  ╱╲╱  ╲──╱╲──╱  ╲───╲                                       ▓    │ hold traces
├────────────────── draggable splitter ───────────────────────▒────┤
│ ░░░▒▓█▓▒░░    ░▒▓░                                          ░    │ waterfall
│ ░░░▒▓█▓▒░░    ░▒▓░        ← drag a box, release, menu opens       │ + colour bar
├──────────────────────────────────────────────────────────────────┤
│ 433.720    433.820    433.920 MHz    434.020    434.120          │ ONE axis
├──────────────────────────────────────────────────────────────────┤
│ ◀◀ ▶ ▶▶  ──────────●───────────────────────────────  12.331 s    │ transport
├──────────────────────────────────────────────────────────────────┤
│ TUNER A                              │ WATERFALL                 │ inspector
│ ┃CENTER    ┃WIDTH    ┃DECIM ┃TAPS    │ ┃FFT  ┃WIN  ┃AVG ┃RANGE   │
│ ┃433.8950  ┃50.0     ┃24    ┃129     │ ┃2048 ┃Hann ┃4   ┃−96/−18 │
│ ┃MHz       ┃kHz      ┃      ┃Hann    │ ┃     ┃     ┃    ┃dBFS  ⌄ │
└──────────────────────────────────────────────────────────────────┘
   ┃ green edge = ⟲ auto     ┃ coral edge = 🔒 manual
```

- **Breadcrumb.** The path from source to the selected node. Each `▾` opens that
  node's siblings — which is how you navigate a tree without spending a permanent
  rail on it. The whole tree, when you want the overview, is the **Flow** tab.
- **Block tabs.** A *channel* — the source, a tuner, a gate, anything carrying IQ —
  is a workspace. Everything you apply to it downstream, until the next channel, is a
  **block**, and each block's result is a tab rather than somewhere you navigate to.
  Adding a demodulator does not move you; it adds a tab beside the spectrum you were
  already looking at. The compiled
  flowgraph is an ordinary tab here, not a special corner toggle. Views sharing an
  axis live in one tab together: **spectrum and waterfall stack over a single
  frequency axis** ([ADR-0020](adr/0020-views-that-share-an-axis.md)), as do a
  demodulated waveform and the bit raster beneath it.
- **Canvas, full width.** Frequency resolution is horizontal, so width is the scarce
  dimension and no chrome takes it.
- **Contextual menu.** Releasing a selection drag opens it at the release point —
  flat, grouped, searchable with `/`. There is no pinned palette; a `+` on the tab
  bar opens the same menu for anyone who hasn't found the gesture yet.
- **Inspector strip.** Cells, not a text run — label above, value in tabular mono,
  a 2 px left edge carrying the mode (green `⟲ auto`, coral `🔒 manual`), grouped
  under the node name and the view name. The edge replaced a text chip because state
  earns a cheaper visual encoding than a word; hovering it explains the mode *and*
  what the other mode would have chosen
  ([law 11](08-ui-principles.md#law-11-in-detail--because-the-naive-version-is-harmful)). Parameters of the selected node, then the
  *active view's* — which belong to the view, not the node, since Spectrum and
  Waterfall want different settings on the same node. Every derived value shows
  `⟲ auto` (re-derives when upstream changes) or `🔒 manual` (sticky) —
  [ADR-0017](adr/0017-auto-manual-parameters.md). `⌄` expands the strip into a
  temporary panel for parameter-heavy nodes.

There is **no settings pane.** Anything you tune while watching the signal is on the
object itself (drag the colour bar for dB range, scroll an axis for span) or in the
strip; everything else is a view tab or the preferences overlay
([ADR-0019](adr/0019-settings-surfaces.md)).

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
5. Menu on C offers **PWM / PPM slicer**. Its symbol period arrives as `⟲ 417 µs` —
   auto, from pulse-width autocorrelation. Clicking the `⟲` shows the histogram it
   reasoned from: two clean clusters, so the estimate is trustworthy. Accepts.
   → Node **D**, output `bits`. Canvas becomes a bit raster.
   Later, widening A's filter to check the band edges does *not* disturb 417 µs,
   because one click on the value pinned it to `🔒 manual` first — the comparison
   survives ([ADR-0017](adr/0017-auto-manual-parameters.md)).
6. Every burst in the ring lines up in the raster. Preamble is obviously
   `0xAAAA`. Selects those bits, hits **Annotate → "preamble"**. The annotation
   appears as a highlight on the *top-level* waterfall too, on every burst.
7. **Save project.** One YAML file referencing the SigMF capture. Sends it to a friend,
   who opens it and lands on node D with the same view.

**What made this work:** the ring recorder (step 3 scrubs backwards on a *live*
source), type-filtered menus (steps 4–5 each had ~4 options, not 200), auto values
that show their evidence and stay put once pinned (step 5), and provenance (step 6's
highlight propagating up). **Six interactions and under 900 px of pointer travel**,
cold launch to bits — see the [budgets](08-ui-principles.md#interaction-budget).

### UC-1' — the same signal, the fast way: **Identify**

Steps 1–2 identical. Then, on node **A**, one button: **Identify**.

The engine runs every [external decoder](07-reuse.md) whose rate and format
constraints fit this stream — `rtl_433`, `multimon-ng`, `dump1090`, and friends —
speculatively, in parallel, over the last N seconds of ring. Then it reports which
ones produced output:

```
  Identify — 8 s window, 6 decoders tried
  ─────────────────────────────────────────────────────────
  ✓ rtl_433          41 records   Acurite-609TXC, Nexus-TH
    multimon-ng       0 records   POCSAG1200, FLEX
    dump1090          0 records
  ─────────────────────────────────────────────────────────
  [ Add rtl_433 as a node ]        [ Build a chain instead ]
```

**Three interactions**, cold launch to a named device. No DSP knowledge required.

`Identify` is the hobbyist path, and it is deliberately a *shortcut through* the
analyst product rather than a separate mode: it is one action on an ordinary node,
its result is an ordinary node, and when it finds nothing you are already standing in
the right place to build the transparent chain by hand. It also serves the analyst —
"what is this?" is the first question either persona has, and ruling out 250 known
protocols in one click is a genuinely useful negative result.

It falls almost free out of two decisions already made: the process plugin kind
([ADR-0013](adr/0013-external-decoders-as-subprocesses.md)) and the type system that
already knows which decoders can accept this stream
([ADR-0006](adr/0006-semantic-stream-types.md)).

---

## UC-2 — Recorded IQ forensics

*Persona: RF engineer. Goal: characterize an FHSS signal in a 90-second capture.*

1. `File → Open` a 4 GB SigMF recording. Overview waterfall renders in **under 2 s**
   because the server builds a multi-resolution pyramid of the file (see
   [ADR-0012](adr/0012-server-side-display-rendering.md)) — never ships raw IQ for display.
2. Sees a hopping pattern. Selects the whole hop band → Tuner **A**.
3. On A, applies **Burst detector** (an analyzer, not a transform). Its threshold
   and minimum-duration arrive as `⟲ auto`; the engineer pins minimum-duration to
   `🔒 200 µs` so it stops changing as she sweeps the threshold. Produces an
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
4. Switches the canvas to **Grid layout**: four view tabs torn off into tiles —
   source waterfall, A's event log, B and C's audio meters — updating simultaneously.
   Tearing a tab out of the tab bar is how a tile gets made.
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
| Speculative multi-decoder probe (`Identify`) | UC-1' | [0013](adr/0013-external-decoders-as-subprocesses.md) + [0006](adr/0006-semantic-stream-types.md) |
| Held vs. varied quantities during exploration | UC-1.5, UC-2.3 | [0017](adr/0017-auto-manual-parameters.md) |
| Several views of one node at once | UC-2.4, UC-3.4 | [0018](adr/0018-contextual-menus-and-view-tabs.md) |
| Near-zero pointer travel per operation | all | [0018](adr/0018-contextual-menus-and-view-tabs.md) |
| Settings reachable without leaving the signal | all | [0019](adr/0019-settings-surfaces.md) |
| Drag feels attached to the cursor (<50 ms) | UC-1.2, UC-3.5 | [0014](adr/0014-rust-data-plane.md), [0010](adr/0010-hot-vs-cold-parameters.md) |
