# Reuse: Standing on What Already Works

**Requirement:** reuse as much existing demodulation and decoding as possible. Writing
250 device decoders is not a project, it's a career.

## The key observation

The largest, most battle-tested body of decoders in this field is **not library code**.
It is standalone Unix programs that read samples on stdin and emit records on stdout.

```
rtl_fm ... | multimon-ng -t raw -a POCSAG1200 -
rtl_fm ... | direwolf -
```

That incantation is how half the community already decodes things. It works because
those programs already agreed on an interface: **samples in, records out**.

So `process` is a **first-class plugin kind**, a peer of `gr_hier` — not a
shell-out escape hatch. See [ADR-0013](adr/0013-external-decoders-as-subprocesses.md).

## Inventory

### Tier 1 — link natively (GNU Radio ecosystem)

| Project | Content | Path |
|---|---|---|
| **gr-satellites** | ~100 satellite telemetry decoders, framing, FEC | `gr_hier`, direct |
| gr-osmosdr / **SoapySDR** | Every mainstream SDR device | Source plugins |
| gr-pager, gr-dab, gr-ieee802-11, gr-rds, gr-air-modes | Protocol decoders | `gr_hier`, direct |
| **liquid-dsp** (MIT) | Fast modem/filter/sync primitives | Native link — our own fast path |
| VOLK | SIMD kernels | Comes with GR |

This is the reason to build on GNU Radio at all. gr-satellites alone is worth the
dependency.

### Tier 2 — wrap as a subprocess (the big win)

| Program | Input | Output | Covers |
|---|---|---|---|
| **rtl_433** | IQ, file or pipe, format-tagged | JSON lines | **250+ ISM device protocols** — sensors, TPMS, remotes, weather stations |
| **multimon-ng** | raw s16 audio @ 22050 | text lines | POCSAG, FLEX, AFSK, DTMF, EAS, X10, ZVEI, ~15 total |
| **dump1090** (fa) | cu8 IQ @ 2.4 MS/s | Beast / SBS / JSON | ADS-B |
| **direwolf** | audio, stdin | KISS / AGWPE over TCP | APRS, AX.25 |
| **dsd / dsd-fme** | audio, stdin | audio + metadata | DMR, P25, NXDN, D-STAR |
| **acarsdec** | IQ or audio | JSON | ACARS |
| **redsea** | demodulated FM MPX | JSON | RDS |
| **AIS decoders** (aisdecoder, rtl-ais) | audio / IQ | NMEA | AIS |

One manifest each. Roughly 20 lines. **Day-one coverage of most of what people
actually want to decode**, without writing a decoder.

> Exact invocations are per-tool and need verification against current releases before
> each adapter ships. The pattern — format-tagged samples on stdin, structured records
> on stdout — is stable across all of them.

### Tier 3 — port the algorithm, not the code

| Project | Why it's hard | What we take |
|---|---|---|
| **SDRangel** | Demods inherit `BasebandSampleSink`, are wired to its `MessageQueue`, channelizer, and Qt GUI. Not a library. Extraction means rewriting against our interfaces. | The *parameter choices* and algorithm structure, ported per-demod when a gap exists. Not linked. |
| **URH** | Python, but its value is the *interactive* decode chain, not batch decoders | Its **encoding chain model** (invert / differential / Manchester / carrier / cut) is self-contained and worth reimplementing as composable native nodes |
| **inspectrum** | Analysis UI only, no decoders | Interaction ideas — its cursor/symbol-period tool is the best in the field |

**Be honest about SDRangel:** it is a source of ideas and coverage knowledge, not a
source of linkable code. Any doc or pitch that implies otherwise is wrong.

## The transparency tradeoff

External decoders are **opaque**. You cannot see inside `rtl_433`, adjust its slicer
threshold, or annotate an intermediate stage. URH's entire value proposition is the
opposite — a decode chain you can see and adjust at every step.

We want both, and we mark the difference in the UI:

| | Native / GR chain | External process |
|---|---|---|
| Drill down past it | Yes, every stage is a node | **No** — terminal node |
| Adjust intermediate steps | Yes | Only its CLI parameters |
| Provenance mapping | Exact | **Approximate** (`t0` + latency estimate) |
| Annotate inside | Yes | Only the output records |
| Effort to add | Days | ~20 lines of manifest |
| UI treatment | Normal node | Marked opaque, dashed border, "external" badge |

**Strategy:** external processes for *breadth* — get to a decoded result fast, over
huge protocol coverage. Native chains for *depth* — when you need to understand or
modify the decode, or when nothing exists yet. The palette shows both, clearly
labeled, and the user chooses knowing what they get.

This is a feature, not a compromise. "Try rtl_433 on this, and if it doesn't
recognize it, build the chain yourself" is exactly the workflow an analyst wants.

## Adapter shape

```yaml
id: ext.rtl433
name: rtl_433 (250+ ISM protocols)
category: decoder
opaque: true                         # UI marks it, no drill-down offered

implementation:
  kind: process
  command: [rtl_433, -r, "-", -F, json, -s, "{sample_rate}"]
  stdin:
    type: iq
    format: cu8                      # engine inserts convert + resample as needed
    sample_rate: { preferred: 250000, min: 250000 }
  stdout:
    parser: jsonl                     # jsonl | regex | kiss | beast | sbs | custom
    schema: schemas/rtl433_event.json
  restart: on_exit                    # supervise; surface exit code in the node
  health: { max_restarts: 3, window_s: 60 }

ports:
  in:  { type: iq }
  out: { type: events }

params:
  - { id: protocols, type: multiselect, source: "rtl_433 -R help", hot: false }
  - { id: level,     type: float, default: 0.0, hot: false }

views: { default: event_table }
```

The engine reads `stdin.format` and `sample_rate` and **derives the conversion and
resampling chain automatically** — the same machinery that derives filter taps from a
selection box ([architecture](03-architecture.md#deriving-parameters-from-a-selection)).
The plugin author declares what the program wants; they never wire a converter.

## Three benefits from one boundary

The subprocess boundary buys three separate things at once:

1. **Reuse** — hundreds of decoders reachable in ~20 lines each.
2. **Isolation** — a segfaulting decoder kills one pipe, not the session.
3. **Licensing** — arms-length aggregation, not derivative linking. See
   [ADR-0015](adr/0015-licensing-posture.md).

Cost is one pipe copy. Every external decoder sits after heavy decimation — audio
rate or a few hundred kS/s — so it is measured in single-digit MB/s. Irrelevant.

## What we still have to write

- The **Tuner** and **Gate** (the core primitives — nobody else's abstraction fits)
- Basic analog demods (AM/FM/SSB) — trivial in GR, and we want them transparent
- Slicers and the URH-style composable encoding chain — the *transparent* decode path
- Burst detection and classification analyzers
- Every view

That's a tractable list. Everything else, we borrow.
