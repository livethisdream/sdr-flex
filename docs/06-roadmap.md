# Roadmap

Each milestone is independently useful. If the project stops at any of them, what
exists still works and is worth using. No milestone is a refactor of the previous one.

The order is chosen so that **the riskiest assumption in each layer is tested as early
as it possibly can be** — which is why the first thing built has no server in it at all.

---

## M0 — Toy model *(static, hosted, no backend)*

A real client running against a **mock engine inside the browser** that speaks the
same protocol the real server will. Deployed as a static site; anyone can click a link
and try the workflow. See [ADR-0021](adr/0021-mock-engine-first.md).

- Client shell: breadcrumb, view tabs, contextual menu on drag-release, cell strip
- Stacked spectrum + waterfall on one shared frequency axis (ADR-0020), WebGL2
- Mock engine: synthetic scene, plus drag-and-drop of a real SigMF or `cf32` file
- Enough DSP in JS to be honest: tuner (shift + decimate + FIR), gate, AM envelope,
  PWM slicer, and a pulse-width autocorrelation estimator for `⟲ auto`
- **The mock injects the latency budget** — ~40 ms on parameter changes, frames capped
  at 30 fps with realistic jitter — so the prototype feels like the real thing rather
  than better than it
- Interaction-count and pointer-travel instrumentation baked in from the first commit

**Explicitly not in scope:** real hardware, ring recording, plugins, external
processes, GNU Radio, audio.

**Done when:** a stranger can open the link, drag a box, drill in, and reach bits —
and the interaction and travel budgets are being measured automatically.

**Validates:** ADR-0002 (the premise), ADR-0018 (the biggest UX bet, including its one
real risk: whether a newcomer finds the contextual menu), ADR-0017, ADR-0020, and the
WebGL rendering path. That is nearly all of the *design* risk, tested in days, with no
GNU Radio installed anywhere.

---

## M1 — Walking skeleton *(the real pipeline, feeding the same client)*

Now prove the engine can feed the client that already exists.

- Control plane: session manager, SigMF file source, one worker process, ZMQ control
- Worker → shared-memory ring; **Rust relay: ring → frame → WebSocket** (ADR-0014)
- Display renderer: FFT → `spectrum` frames at 30 fps
- The client swaps its mock engine for the real one behind the same protocol
- **Frame-timing instrumentation** — jitter is the number that matters
- **License-boundary CI check** — control plane and relay must never import GNU Radio
  (ADR-0015). Trivial now; an audit later.

**Done when:** the M0 client, unchanged above its transport layer, renders a real
SigMF file at a p99 frame interval within 4 ms of the mean.

**Validates:** ADR-0001, ADR-0012, ADR-0014. The relay and ring contract are built
here rather than later because retrofitting a three-language interface is the
expensive version.

---

## M2 — Selection → tuner, for real

- Node tree, command log, graph compiler for `source` and `tuner`
- Selection → derived decimation and taps in GNU Radio
- Hot retune (drag the box, spectrum follows)
- Auto/manual parameter state with real estimators and evidence views (ADR-0017)

**Done when:** the M0 workflow runs end to end on the real engine, in under 50 ms and
under 120 px of pointer travel per operation.
**Validates:** ADR-0010, and whether GR's `lock()`/`unlock()` survives frequent
structural edits — the top technical risk in the design.

---

## M3 — Demodulate and listen *(now it's GQRX)*

- AM / NBFM / WBFM / USB / LSB / CW demodulators
- `real` stream type, time-series view, audio subscription + mixer strip
- Type-filtered menus (first real use of ADR-0006)
- Multiple sibling tuners, fragment splitting (ADR-0004)

**Done when:** a usable listening experience with N simultaneous channels.
**Ship it.** The first point where outside feedback is worth collecting on the
*engine* — M0 was already collecting it on the workflow.

---

## M4 — Time is real *(now it's better than GQRX)*

- Ring recorder for live sources; live and file unified (ADR-0005). Disk-budget-derived
  window, cs16 default, rate/format policy in the interface (ADR-0016)
- **Source plugin interface defined in our own terms**, with SoapySDR/gr-osmosdr and
  **gr-iio (PlutoSDR)** as its first two implementations — not SoapySDR as the layer
- Time selection → `gate` node
- Multi-resolution pyramid: instant overview of large files, zoom as a server query

**Done when:** you can catch a burst that already happened, zoom into 40 ms of it at
full resolution, and re-run a chain over it.
**This is the first capability no free tool has.**

---

## M4.5 — `rtl_433` in a box *(the cheapest win in the project)*

The `process` plugin kind ([ADR-0013](adr/0013-external-decoders-as-subprocesses.md))
ahead of the rest of the plugin system, because it is small and the payoff is enormous.

- `process` kind: pipe management, supervision, format negotiation
- Auto-derived convert + resample chain to whatever the program wants on stdin
- `jsonl` parser, `events` stream type, event-table view, opaque-node UI treatment
- Adapters: `rtl_433`, `multimon-ng`, `dump1090`
- **`Identify`** — every applicable decoder in parallel over the ring

**Done when:** three interactions from launch to a named device, `Identify` returning
in under 3 s with progressive per-decoder results.
**Roughly 60 lines of manifest buy 270+ protocols.** Nothing else has that ratio,
which is why it is out of order.

---

## M5 — Third parties *(now it's extensible)*

- Plugin manifest schema + registry + validation with real error reporting
- `gr_hier`, `gr_block`, and `grc` implementation kinds (`process` landed at M4.5)
- More adapters: `direwolf`, `dsd`, `acarsdec`, `redsea`
- gr-satellites integration — ~100 decoders behind one dependency
- Plugins panel; view plugins; read-only flowgraph render and `.grc` export

**Done when:** someone outside the project adds a working operation without touching
the codebase.

---

## M6 — Bits and meaning *(now it's URH-shaped)*

- `symbols`, `bits`, `bytes`, `events` types; slicers, framing, CRC, real decoders
- Bit raster, hex and event-table views, aligned under the waveform on shared time
  (ADR-0020)
- Annotations anchored in source coordinates, propagating up the tree (ADR-0007)
- Analyzers emitting event streams; event cursor seeks the tree
- Project save/load, SigMF annotation round-trip (ADR-0008, ADR-0009)

**Done when:** UC-1 and UC-2 run start to finish.

---

## M7 — Beyond the GUI

- Headless CLI + batch runner, Python SDK
- Links (event field → hot parameter) for UC-3
- Tauri desktop shell; plugin version pinning in project files

**Done when:** UC-3, UC-5 and UC-6 run start to finish.

---

## Sequencing rationale

- **M0 tests the premise before anything expensive exists.** The largest uncertainty
  in this project is whether the interaction model feels good, and it needs no DSP
  engine to answer. Iterating on feel against a browser-resident mock is far faster
  than against a GNU Radio pipeline, and the result is a link you can hand to people.
- **M1 then tests whether the real pipeline can hold 30 fps without jitter**, feeding
  a client that already exists and is already liked.
- **M2** is where the top technical risk (GR under frequent structural edits) finally
  gets touched — deliberately after the design is settled, so a rebuild-glitch problem
  is met with a fixed target rather than a moving one.
- **M3** is the first shippable engine, deliberately early.
- **M4** is the differentiator, placed before extensibility because it shapes what the
  plugin API must expose about time.
- **M4.5** is out of order on purpose: highest capability-per-line in the plan, and it
  stress-tests auto-resampling against real programs before the plugin API is frozen.
- **M5–M7** are additive and carry no architectural risk.

Four things are deliberately **not** deferred, because retrofitting each is the kind
of rewrite this roadmap exists to avoid:

- **The command log** (M2) — undo, project files, crash recovery and scripting hang off it.
- **The Rust relay and ring contract** (M1) — a three-language interface is far cheaper
  to define before anything sits on either side of it.
- **Frame-timing and interaction instrumentation** (M0/M1) — you cannot fix jitter or
  friction you never measured, and by M6 nobody will remember which change caused it.
- **The license boundary** (M1) and the **source interface** staying independent of
  SoapySDR (M4) — both erode silently.
