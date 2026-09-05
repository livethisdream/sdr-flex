# Plugin Model

## The contract

A plugin is a **manifest** plus an **implementation**. The manifest is the whole
interface between a plugin and the GUI: it declares port types, parameters, and view
hints, and that is enough for the client to place the block in the right palettes,
render its controls, and pick its default visualization. **A plugin author writes no
UI code.**

## Categories

| Category | Input → Output | Examples |
|---|---|---|
| `source` | — → `iq` | RTL-SDR, HackRF, SigMF file, UDP stream |
| `transform` | `iq` → `iq` | Tuner, equalizer, AGC, notch, Doppler correct |
| `demodulator` | `iq` → `real` \| `symbols` \| `iq` | AM, NBFM, SSB, PSK, FSK, OFDM |
| `decoder` | `real` \| `symbols` \| `bits` → `bits` \| `bytes` \| `events` | PWM slicer, Manchester, Reed-Solomon, POCSAG, ADS-B |
| `analyzer` | any → `events` | Burst detector, cyclostationary classifier, SNR meter |
| `sink` | any → — | Audio out, file writer, UDP forwarder |
| `view` | any → pixels (client-side) | Constellation, eye, bit raster, hex, event table |

Categories are for the palette's grouping only. The **type system** decides what is
actually offered where.

## Manifest schema

```yaml
id: org.example.pocsag            # reverse-DNS, globally unique
name: POCSAG Decoder
version: 1.0.0
category: decoder
description: Decodes POCSAG-512/1200/2400 pager traffic.
requires:
  gnuradio: ">=3.10"
  modules: [gr-pager]             # checked at load; missing → greyed out with reason

implementation:
  kind: gr_hier                   # gr_hier | gr_block | python | grc | wasm(view only)
  module: pocsag_hier
  class: pocsag_decoder

ports:
  in:
    type: real
    constraints:
      sample_rate: { min: 9600 }  # palette hides this block on slower streams
  out:
    type: events
    schema: schemas/pocsag_message.json

params:
  - id: baud
    type: enum
    values: [512, 1200, 2400]
    default: 1200
    hot: false                    # rate change → rebuild this fragment downward
    ui: { widget: segmented }
  - id: invert
    type: bool
    default: false
    hot: true                     # live toggle, no rebuild
  - id: threshold
    type: float
    default: 0.5
    min: 0.0
    max: 1.0
    scale: linear
    hot: true
    ui: { widget: slider, unit: "" }

views:
  default: event_table
  suggested: [event_table, bit_raster]

actions:                          # optional verbs surfaced as buttons
  - { id: resync, label: "Force resync", kind: message, port: cmd }
```

### Why each field earns its place

- **`ports.*.type` + `constraints`** — the palette filter. Without it you get
  SDRangel's wall of buttons.
- **`params[].hot`** — lets the client decide between a live-drag slider and a
  control with a rebuild badge. Without it, every parameter feels dangerous.
- **`params[].ui`** and `scale` — the difference between a usable log-scale gain
  slider and a text box. Cheap to declare, disproportionate effect.
- **`requires`** — a missing OOT module becomes a greyed palette entry with a reason,
  not an import error at run time.
- **`views`** — the client picks a sensible default so the user sees *something*
  immediately after adding the block.

## Type compatibility

An operation is offered on node `N` when:

1. `op.in.type` matches `N.out_type.kind`, **and**
2. every `op.in.constraints` predicate holds against `N.out_type`, **and**
3. `op.requires` is satisfied on this server.

Coercions are explicit and few — the engine will insert a resampler when a block
declares a required rate, and will show that it did. It will never silently
reinterpret `symbols` as `bits`.

## Implementation kinds

| Kind | What you write | Use when |
|---|---|---|
| `gr_hier` | A GNU Radio hier block (Python or C++) | Default for transparent chains. Composes existing GR blocks. |
| `process` | A manifest wrapping an existing CLI program | **Reusing the field's existing decoders** — `rtl_433`, `multimon-ng`, `dump1090`, `direwolf`, `dsd`. See [ADR-0013](adr/0013-external-decoders-as-subprocesses.md) and [reuse](07-reuse.md). |
| `gr_block` | A single GR block from an OOT module | Wrapping something that already exists |
| `grc` | A `.grc` file | Prototyping in GRC, promoting to a plugin |
| `python` | A plain callable over numpy arrays | Analyzers and decoders that aren't stream DSP |
| `wasm` | A WASM module | **Views only**, runs client-side |

`process` is a **peer of `gr_hier`, not an escape hatch**. It is how the project gets
250+ ISM protocols, ADS-B, POCSAG, APRS, and four digital voice modes on day one
without writing a decoder. Nodes backed by a process are marked **opaque** in the UI:
no drill-down, approximate provenance, visibly distinct. That tradeoff — breadth via
opaque reuse, depth via transparent native chains — is covered in
[reuse](07-reuse.md#the-transparency-tradeoff).

`grc` as a first-class kind matters: it means the on-ramp from "I prototyped this in
GNU Radio Companion" to "it's a first-class operation in the workflow" is writing a
20-line manifest. That is the cheapest possible path from the existing GR community
into this tool.

## Distribution

- **v1:** a plugins directory scanned at startup and on demand. Manifests validated
  against a JSON Schema; failures reported in a Plugins panel with line numbers, never
  silently swallowed.
- **later:** signed bundles, a registry, per-plugin version pinning in the project file
  so UC-6 handoffs are reproducible.

Plugins run in the worker process, in-process with GNU Radio. That means a bad plugin
can crash one source session. That is contained and recoverable, and it is a deliberate
tradeoff: real sandboxing costs an IPC hop per block and buys little in a tool where
you already chose to install the plugin. See [ADR-0003](adr/0003-gnuradio-in-worker-processes.md).

## Views are plugins too

A view receives a typed stream subscription and a canvas. It is client-side
(TypeScript or WASM), declared with its own manifest naming the stream kinds it can
render. This is what keeps "beautiful, intuitive GUI" extensible rather than
hard-coded: a new decoder can ship the right way to *look* at its output alongside
the decoder itself.
