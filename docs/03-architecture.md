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
│  ┌───────────┐  ┌──────────────┐  ┌────────────────────────────────┐  │
│  │ Stream    │  │ Media Store  │  │ Display Renderer               │  │
│  │ Multiplex │  │ (SigMF +     │  │ (FFT pyramid, min/max envelope)│  │
│  │ (WS fan)  │  │  ring recs)  │  │                                │  │
│  └─────▲─────┘  └──────▲───────┘  └────────────────▲───────────────┘  │
└────────┼───────────────┼───────────────────────────┼──────────────────┘
         │ ZMQ           │ mmap / shared ring        │
┌────────┴───────────────┴───────────────────────────┴──────────────────┐
│                    DSP WORKERS (separate processes)                    │
│  worker[source-1]: GNU Radio top_block(s)   worker[source-2]: ...      │
│    ├ osmosdr/file src → tap:root                                       │
│    ├ tap:root → xlating filter → tap:A                                 │
│    └ tap:A   → demod → decoder → event sink                            │
└────────────────────────────────────────────────────────────────────────┘
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
| Server | Python 3.11+, FastAPI + uvicorn | Not in the sample path. Same language as GR bindings. Fast to iterate on a design that will change a lot. |
| DSP | GNU Radio 3.10, one worker process per source | Enormous existing block ecosystem; process isolation dodges the GIL and contains crashes ([ADR-0003](adr/0003-gnuradio-in-worker-processes.md)) |
| Server↔worker | ZMQ (control/events) + shared-memory rings (bulk) | ZMQ is GR-native; rings avoid copying IQ through the broker |
| Data wire | WebSocket, binary framed | One connection, browser-native, no polyfill; header + raw `Float32Array` is directly paintable |
| Control wire | HTTP/JSON + OpenAPI | Trivially scriptable, self-documenting, cheap to write a second client against |
| Client | TypeScript + React, WebGL2 | Waterfall at 60 fps needs GPU; canvas2D does not scale past a few hundred kilopixels/frame |
| Desktop | Tauri shell over the same web client (later) | One UI codebase, native file dialogs and USB when needed |
| IQ format | SigMF | The only real standard; annotations round-trip ([ADR-0008](adr/0008-sigmf-native.md)) |
| Project file | YAML serialization of the command log | Diffable, reviewable, replayable ([ADR-0009](adr/0009-command-log.md)) |
| Packaging | Container image, plus radioconda env | GNU Radio installation is the single biggest onboarding tax; eliminate it |

## Known risks

1. **GR `lock()`/`unlock()` is fragile under frequent structural edits.** Mitigated by
   fragmenting at taps so rebuilds are small and localized, and by build-then-swap
   rather than in-place mutation. If it still glitches, escalate to fragment-per-node.
   *This is the top technical risk in the design.*
2. **Ring-recording every live source is expensive.** 2.4 MS/s complex float32 is
   ~19 MB/s. Mitigations: default to complex int16 for the ring (9.6 MB/s), a bounded
   default window (60 s), and an explicit "promote to permanent capture" action.
3. **Python in the data-plane relay.** 30 fps × several MB is comfortable; 20 live
   audio branches plus 8 waterfalls may not be. Instrument early; the relay is the
   piece most likely to need a Rust rewrite, and it is small enough to be replaceable.
4. **The type system may be too rigid.** Real-world blocks do strange things with
   rates and framing. Escape hatch: a manifest may declare `out_type: dynamic` and
   report its type at runtime, at the cost of a palette that can only be filtered
   after first run.
5. **Plugins run in-process with the worker.** A bad plugin can take down a source
   session (contained, by design) but not the server. True sandboxing is deferred;
   plugin installation is an explicitly trusted action in v1.
