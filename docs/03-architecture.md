# Architecture

## Component map

```
┌──────────────────────── CLIENT (replaceable) ─────────────────────────┐
│  Web UI (TS/React/WebGL2)   │  Python SDK   │  CLI (`sdrflex`)        │
└───────────────┬─────────────┴───────┬───────┴──────────┬──────────────┘
                │ control: HTTPS/JSON │                  │
                │ data:  WSS/binary   │                  │
┌───────────────▼─────────────────────▼──────────────────▼──────────────┐
│                          SERVER  (Python, async)                       │
│                                                                        │
│  ┌───────────┐  ┌──────────────┐  ┌────────────┐  ┌────────────────┐  │
│  │ Session   │  │ Graph        │  │ Plugin     │  │ Annotation &   │  │
│  │ Manager   │  │ Compiler     │  │ Registry   │  │ Project Store  │  │
│  └───────────┘  └──────┬───────┘  └────────────┘  └────────────────┘  │
│  ┌────────────────────────────────────────────────────────────────┐   │
│  │ Command Log (append-only, serializable → project file)         │   │
│  └────────────────────────────────────────────────────────────────┘   │
│  ┌──────────────┐  ┌────────────────────────────────┐                 │
│  │ Media Store  │  │ Display Renderer               │                 │
│  │ (SigMF +     │  │ (FFT pyramid, min/max envelope)│                 │
│  │  ring recs)  │  │                                │                 │
│  └──────▲───────┘  └────────────────▲───────────────┘                 │
└─────────┼───────────────────────────┼─────────────────────────────────┘
          │ mmap                      │      ╔═══════════════════════════╗
          │                           │      ║ DATA-PLANE RELAY (Rust)   ║
          │                           └──────╢ ring → frame → WebSocket  ║
          │                                  ║ newest-wins, no GC        ║
          │        configured by control ────╢ (ADR-0014)                ║
          │                                  ╚═════════▲═════════════════╝
          │  shared-memory rings                       │
┌─────────┴────────────────────────────────────────────┴────────────────┐
│                    DSP WORKERS (separate processes)                    │
│  worker[source-1]: GNU Radio top_block(s)   worker[source-2]: ...      │
│    ├ osmosdr/file src → tap:root                                       │
│    ├ tap:root → xlating filter → tap:A                                 │
│    ├ tap:A   → demod → decoder → event sink                            │
│    └ tap:A   → convert/resample →┐                                     │
└──────────────────────────────────┼─────────────────────────────────────┘
                                   │ pipe (samples in, records out)
                          ┌────────▼──────────────────────────┐
                          │ EXTERNAL DECODERS (ADR-0013)      │
                          │ rtl_433 · multimon-ng · dump1090  │
                          │ direwolf · dsd · acarsdec · …     │
                          └───────────────────────────────────┘
         │
    ┌────┴─────────┐
    │ Hardware /   │
    │ IQ files     │
    └──────────────┘
```

## The three planes

**Control plane** — HTTP/JSON. Create a session, mutate the tree, list the
catalog, save a project. Low rate, request/response, strongly typed, fully
described by an OpenAPI schema. Everything here goes through the command log.

**Data plane** — WebSocket, binary frames. Spectrum rows, envelopes, audio,
decoded events. High rate, lossy by design, subscription-based. Never blocks the
control plane and never back-pressures DSP.

**Media plane** — the filesystem. SigMF captures, ring recordings, and derived
resolution pyramids. Both the workers and the display renderer read it directly
via mmap; it never travels over a socket.

Keeping these separate is what lets a slow client, a stalled render, or a crashed
worker each fail without taking the others down.

## Data model

```
Session
  ├─ Source        (device | file | stream)   → Medium
  ├─ Node[]        (the analysis tree)
  ├─ View[]        (attached to nodes, client-layout state)
  ├─ Annotation[]  (anchored in SOURCE time-frequency, not node coordinates)
  └─ CommandLog[]  (the authoritative history)

Node
  id            uuid
  parent        node_id | null            # null = source
  op            "tuner" | "gate" | plugin id
  params        { ... }                   # validated against the op's manifest
  out_type      StreamType                # derived, not stored by the client
  state         building | running | error | idle

StreamType
  kind          iq | real | symbols | bits | bytes | events | image
  sample_rate   Hz                         # or symbol rate / event rate
  center_hz     absolute RF center, propagated through every tuner
  t0            absolute timestamp of sample 0 (ns since epoch)
  provenance    [ node_id, ... ]           # path back to the source
  extra         { alphabet, bits_per_symbol, units, ... }
```

The **`StreamType` is the linchpin**. It is what the palette filters on
([ADR-0006](adr/0006-semantic-stream-types.md)), what lets a baseband view show
absolute RF frequency, and what makes an annotation four levels deep resolvable
back to a source sample index ([ADR-0007](adr/0007-stream-context-and-provenance.md)).

## Execution model

### Compiling the tree

The Graph Compiler walks the node tree and emits a set of **flowgraph fragments**,
split at *tap boundaries*: the source and every tuner. Each fragment becomes one GNU
Radio `top_block`; fragments are joined by shared-memory rings
([ADR-0004](adr/0004-flowgraph-splitting-at-taps.md)).

```
tree                          fragments
────                          ─────────
source ────────────────────►  F0: src → resample → tap:root
  ├─ A (tuner) ───────────►   F1: tap:root → xlate/filter/decim → tap:A
  │   └─ C (demod)              F2: tap:A → am_demod → env_slicer → event_sink
  │       └─ D (decode)
  └─ B (tuner) ───────────►   F3: tap:root → xlate/filter/decim → tap:B
      └─ E (demod)              F4: tap:B → nbfm → audio_sink
```

Editing D rebuilds only F2. Editing A rebuilds F1 and F2; F3 and F4 never stall.
This is the property UC-3 needs.

### Deriving parameters from a selection

A frequency box of width `W` centered at `f_c`, over a stream at rate `fs`:

```
target_rate  = snap_up(W * OVERSAMPLE)         # OVERSAMPLE ≈ 1.25
decim        = largest integer d with fs/d >= target_rate,
               preferring d with small prime factors
taps         = firdes.low_pass(1, fs, W/2, W*TRANSITION, window)
block        = freq_xlating_fir_filter_ccf(decim, taps, f_c - stream.center_hz, fs)
```

Everything on the right is derived. The inspector exposes all of it, pre-filled, so
a power user can override any term without leaving the workflow. That combination —
derived by default, fully exposed on demand — is the whole difference between
"GQRX simplicity" and "GQRX limitation."

### Parameter changes

Two classes, declared per parameter in the manifest
([ADR-0010](adr/0010-hot-vs-cold-parameters.md)):

- **Hot** — pushed to a running block via a GR message port or a setter. Sub-frame
  latency. Dragging a tuner box is hot: it's just a new mixer frequency.
- **Cold** — requires rebuilding the fragment and everything downstream of it.
  Changing decimation is cold, because the rate changes propagate.

The client shows this: hot params are direct-manipulation (drag, scrub, slider),
cold params show a subtle rebuild badge. Nobody is surprised by a 300 ms hiccup.

### Rebuild protocol

1. Compiler produces the new fragment definition.
2. Worker builds the new `top_block` **without starting it**.
3. New fragment attaches to the upstream tap ring at the current write position.
4. Old fragment stops; new one starts. Consumers of the old fragment's output tap
   see a discontinuity marker in the stream, and views handle it by clearing.

Buildings-then-swap keeps the glitch bounded and keeps siblings untouched.

## Failure model

| Failure | Blast radius | Recovery |
|---|---|---|
| Plugin block raises | one fragment | Fragment → `error` state, node shows the traceback inline, rest of tree keeps running |
| Worker process dies | one source session | Supervisor restarts, replays the command log, resumes at the ring's live edge |
| Client disconnects | nothing | Subscriptions torn down; DSP keeps running if a recorder is attached, else pauses |
| Display renderer backs up | display only | Frames dropped, newest-wins; DSP never blocks |
| Disk full (ring recorder) | recording only | Ring wraps; oldest history lost; loud UI warning |

The rule underneath all of these: **the DSP path never blocks on the display path,
and the control plane never blocks on either.**

## Technology choices

| Layer | Choice | Why |
|---|---|---|
| Control plane | Python 3.11+, FastAPI + uvicorn | Never in the sample path. Same language as GR bindings. Fast to iterate on the parts that change most (compiler, registry). |
| Data plane | **Rust relay process** | Reads worker rings via shared memory, formats frames, fans out over WebSocket. No GC in the hot path — jitter, not throughput, is the binding constraint ([ADR-0014](adr/0014-rust-data-plane.md)) |
| DSP | GNU Radio 3.10, one worker process per source | Enormous existing block ecosystem; process isolation dodges the GIL and contains crashes ([ADR-0003](adr/0003-gnuradio-in-worker-processes.md)) |
| Devices | Our own source-plugin interface; **SoapySDR is one implementation, not the layer** | Pluto needs libiio/gr-iio and is network-attached; SignalHound BB60 has only a vendor SDK ([ADR-0016](adr/0016-performance-envelope.md)) |
| Server↔worker | ZMQ (control/events) + shared-memory rings (bulk) | ZMQ is GR-native; rings avoid copying IQ through the broker, and let the Rust relay read without a Python hop |
| External decoders | Subprocesses over pipes | `rtl_433`, `multimon-ng`, `dump1090`, `direwolf`, … — hundreds of proven decoders for ~20 lines of manifest each ([ADR-0013](adr/0013-external-decoders-as-subprocesses.md), [reuse](07-reuse.md)) |
| Data wire | WebSocket, binary framed | One connection, browser-native, no polyfill; header + raw `Float32Array` is directly paintable |
| Control wire | HTTP/JSON + OpenAPI | Trivially scriptable, self-documenting, cheap to write a second client against |
| Client | TypeScript + React, WebGL2 | Waterfall at 60 fps needs GPU; canvas2D does not scale past a few hundred kilopixels/frame |
| Desktop | Tauri shell over the same web client (later) | One UI codebase, native file dialogs and USB when needed |
| IQ format | SigMF | The only real standard; annotations round-trip ([ADR-0008](adr/0008-sigmf-native.md)) |
| Project file | YAML serialization of the command log | Diffable, reviewable, replayable ([ADR-0009](adr/0009-command-log.md)) |
| Packaging | Container image, plus radioconda env | GNU Radio installation is the single biggest onboarding tax; eliminate it |

## Latency budget

Perceived speed is set by the slowest link and by *jitter*, not average throughput.
The full budget, including the 50 ms drag-to-pixel target and where every millisecond
goes, is in [UI principles](08-ui-principles.md#latency-budget). The architectural
consequences are ADR-0014 (no GC in the hot path) and ADR-0004 (small, local rebuilds).

## Known risks

1. **GR `lock()`/`unlock()` is fragile under frequent structural edits.** Mitigated by
   fragmenting at taps so rebuilds are small and localized, and by build-then-swap
   rather than in-place mutation. If it still glitches, escalate to fragment-per-node.
   *This is the top technical risk in the design.*
2. **Ring-recording every live source costs disk bandwidth.** At the v1 target of
   ≤ 10 MS/s ([ADR-0016](adr/0016-performance-envelope.md)) this is 40 MB/s in cs16 —
   comfortable on NVMe. Mitigations: cs16 by default, a **disk budget** (default 4 GB)
   from which the ring *duration* is derived rather than being asked for, and an
   explicit "promote to permanent capture" action. At the future 40–61 MS/s tier the
   ring must be able to record decimated or be switched off per source, so the
   recorder interface takes a rate/format policy from day one.
3. **The Python↔Rust ring contract.** The shared-memory ring format is now a
   three-way contract between C++ workers, the Rust relay, and Python control. It must
   be specified, versioned, and tested from all three sides, or it becomes the place
   where the hardest bugs live.
4. **The type system may be too rigid.** Real-world blocks do strange things with
   rates and framing. Escape hatch: a manifest may declare `out_type: dynamic` and
   report its type at runtime, at the cost of a palette that can only be filtered
   after first run.
5. **Plugins run in-process with the worker.** A bad GR plugin can take down a source
   session (contained, by design) but not the server. External decoders (ADR-0013) are
   better off — they only kill their own pipe. True sandboxing of GR plugins is
   deferred; installing one is an explicitly trusted action in v1.
6. **External decoder version drift.** A user's `rtl_433` may not match what a
   manifest assumes. Manifests declare version constraints; the Plugins panel reports
   mismatches rather than failing at run time. Adapters need testing against real
   releases, which is ongoing maintenance we are signing up for.
