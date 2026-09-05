# API Sketch

Illustrative, not final. The point is to show the *shape*: a small control surface, a
lossy binary data surface, and no privileged path for the GUI.

## Control plane — HTTP/JSON

```
POST   /v1/sessions                        → { session_id }
GET    /v1/sessions/{s}                    → full session state (tree, views, annotations)
DELETE /v1/sessions/{s}

POST   /v1/sessions/{s}/source             { kind, uri|device, params } → node(root)
GET    /v1/sessions/{s}/nodes              → Node[]
POST   /v1/sessions/{s}/nodes              { parent, op, params }       → Node
PATCH  /v1/sessions/{s}/nodes/{n}          { params }                   → Node + {rebuilt: bool}
DELETE /v1/sessions/{s}/nodes/{n}          (cascades to subtree)

POST   /v1/sessions/{s}/nodes/{n}/actions/{action_id}   { args }

GET    /v1/sessions/{s}/nodes/{n}/palette  → Op[]   # already type-filtered, server-side
GET    /v1/catalog                         → all installed ops + manifests
POST   /v1/catalog/rescan

POST   /v1/sessions/{s}/annotations        { t0, t1, f_lo, f_hi, label, node_id? }
GET    /v1/sessions/{s}/annotations?t0=&t1=

POST   /v1/sessions/{s}/transport          { action: play|pause|seek|rate, t? }

GET    /v1/sessions/{s}/project            → YAML (the command log)
POST   /v1/projects                        ← YAML, replays the log → { session_id }
GET    /v1/sessions/{s}/export/grc?node={n} → .grc file
```

Two things worth noting:

- **The palette is computed server-side.** The client does not implement the type
  system; it renders a list. That keeps a second client cheap to write.
- **`PATCH /nodes/{n}` returns whether a rebuild happened.** The client uses this to
  confirm its hot/cold prediction and to know when to clear views.

## Data plane — WebSocket, binary

```
WS /v1/sessions/{s}/stream

client → server (JSON control frames on the same socket):
  { "op": "subscribe",   "node": "A", "stream": "spectrum",
    "params": { "bins": 2048, "fps": 30, "avg": 4 } }        → { stream_id: 7 }
  { "op": "subscribe",   "node": "D", "stream": "events" }
  { "op": "unsubscribe", "stream_id": 7 }
  { "op": "window",      "stream_id": 7, "t0": ..., "t1": ... }   # zoom = a server query

server → client (binary frames):
  ┌────────────────────────────── 32-byte header ─────────────────────────────┐
  │ u16 magic │ u8 ver │ u8 dtype │ u32 stream_id │ u64 seq │ u64 t_ns │ u32 n │
  └───────────────────────────────────────────────────────────────────────────┘
  followed by n * sizeof(dtype) bytes of payload, ready for a typed-array view.
```

`dtype` ∈ `{f32, i16, u8, cf32, json}`. A `spectrum` frame is `n` f32 magnitude bins
and can go straight into a WebGL texture with no parsing. An `events` frame is `json`.

### Stream kinds

| Kind | Payload | Notes |
|---|---|---|
| `spectrum` | `n` f32 bins | Server does FFT, windowing, averaging. Rate is client-requested, server-capped. |
| `waterfall` | rows of `n` f32 | For history/zoom queries; live waterfall is accumulated client-side from `spectrum` |
| `timeseries` | interleaved min/max f32 pairs | Envelope decimation — draws a 10-minute capture in 2000 px |
| `iq` | `cf32` | Only for bounded windows (a gate) or a constellation view. Rate-limited. |
| `audio` | `i16` PCM or Opus | With a mixer strip per subscription |
| `events` | JSON records | Each carries `t_ns` and a `provenance` path back to source samples |
| `status` | JSON | Node state changes, rebuild start/end, errors, ring fill level |

### Delivery semantics

**Lossy, newest-wins, per subscription.** If a client cannot keep up, the server drops
frames for that subscription and increments a gap counter in the next header's `seq`.
The client draws a subtle "dropping" indicator. DSP is never back-pressured by a
display. See [ADR-0012](adr/0012-server-side-display-rendering.md).

`events` is the exception: it is **reliable and buffered**, because a dropped decoded
message is a lost result, not a dropped frame. Bounded queue; on overflow the session
goes to an explicit error state rather than silently losing records.

## Project file

```yaml
version: 1
source:
  kind: sigmf
  uri: captures/doorbell-433.sigmf-meta
  sha256: 3f9c...              # so a handoff can verify it's the same capture
log:                            # the command log; replaying it reconstructs everything
  - { cmd: add_node, id: A, parent: root, op: core.tuner,
      params: { center_hz: 433895000, bandwidth_hz: 50000 } }
  - { cmd: add_node, id: B, parent: A, op: core.gate,
      params: { t0: 12.310, t1: 12.348 } }
  - { cmd: add_node, id: C, parent: B, op: core.am_envelope, params: {} }
  - { cmd: add_node, id: D, parent: C, op: core.pwm_slicer,
      params: { symbol_us: 417, threshold: 0.42 } }
  - { cmd: annotate, target: source, t0: 12.310, t1: 12.313,
      f_lo: 433890000, f_hi: 433900000, label: preamble }
  - { cmd: set_param, node: D, params: { threshold: 0.38 } }
ui:
  selected: D
  layout: single
  scrubber_t: 12.331
```

Append-only, human-readable, git-diffable. Undo is truncating the log and replaying;
a project file and an undo stack are the same object
([ADR-0009](adr/0009-command-log.md)).

## Python SDK — the same API, no shortcuts

```python
from sdrflex import Session

with Session.open("captures/doorbell-433.sigmf-meta") as s:
    a = s.root.tune(center_hz=433_895_000, bandwidth_hz=50_000)
    for burst in a.analyze("core.burst_detector"):
        bits = burst.demodulate("core.am_envelope").decode("core.pwm_slicer",
                                                            symbol_us=417)
        print(burst.t0, bits.hex())
```

Every call here is one of the HTTP endpoints above. If the SDK can't express
something the GUI does, that's a bug in the API, not a missing SDK feature.
