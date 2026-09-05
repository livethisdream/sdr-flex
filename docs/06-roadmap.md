# Roadmap

Each milestone is independently useful. If the project stops at any of them, what
exists still works and is worth using. No milestone is a refactor of the previous one.

---

## M0 — Spectrum in a browser *(the walking skeleton)*

Prove the three-plane architecture end to end with the least DSP possible.

- Control plane: session manager, SigMF file source, one worker process, ZMQ control
- Worker → shared-memory ring; **Rust relay: ring → frame → WebSocket**
- Display renderer: FFT → `spectrum` frames at 30 fps
- Client: WebGL2 waterfall + spectrum, transport controls
- **Frame-timing instrumentation from day one** — jitter is the number that matters
- **License-boundary CI check** — control plane and relay must never import GNU Radio
  (ADR-0015). Trivial now; an audit later.

**Done when:** open a SigMF file, see a smooth waterfall, scrub it, and the p99
frame interval is within 4 ms of the mean. No tree, no tuner, no demod.
**Validates:** ADR-0001, ADR-0012, ADR-0014, and the WebGL path — the things most
likely to be wrong in a way that forces a rewrite. The relay is built here rather
than later precisely because retrofitting the ring contract across three languages
is the expensive version.

---

## M1 — Selection → Tuner → child view *(the core loop)*

The one gesture the whole product rests on.

- Node tree data model + command log
- Graph compiler for `source` and `tuner` only
- Selection → derived decimation and taps
- **Breadcrumb, view tabs, and the contextual menu on drag-release** (ADR-0018) —
  the layout is settled here rather than retrofitted, since it decides where every
  later feature lands
- **Auto/manual parameter state** with evidence views (ADR-0017)
- Inspector strip; hot retune (drag the box, spectrum follows)

**Done when:** drag a box, get a child waterfall, drag the box again and the child
follows live — in under 50 ms and under 120 px of pointer travel.
**Validates:** ADR-0002, ADR-0010, ADR-0018. If drilling in doesn't feel instant here,
the premise is wrong and it is cheap to find out now. This is also the first milestone
whose demo video is worth watching a newcomer attempt: the contextual menu's one real
risk is discoverability, and that is the only way to measure it.

---

## M2 — Demodulate and listen *(now it's GQRX)*

- AM / NBFM / WBFM / USB / LSB / CW demodulators
- `real` stream type, time-series view, audio subscription + mixer strip
- Type-filtered palette (first real use of ADR-0006)
- Multiple sibling tuners, fragment splitting (ADR-0004)

**Done when:** a live-equivalent listening experience with N simultaneous channels.
**Ship it.** This is a genuinely usable receiver and the first point where outside
feedback is worth collecting.

---

## M3 — Time is real *(now it's better than GQRX)*

- Ring recorder for live sources; live and file unified (ADR-0005). Disk-budget-derived
  window, cs16 default, rate/format policy in the interface (ADR-0016)
- **Source plugin interface defined in our own terms**, with SoapySDR/gr-osmosdr and
  **gr-iio (PlutoSDR)** as its first two implementations — not SoapySDR as the layer
- Time selection → `gate` node
- Multi-resolution pyramid: instant overview of large files, zoom as a server query
- Scrub backwards on a live source

**Done when:** you can catch a burst that already happened, zoom into 40 ms of it at
full resolution, and re-run a chain over it.
**This is the first capability no free tool has.**

### M3.5 — `rtl_433` in a box *(the cheapest win in the project)*

The `process` plugin kind ([ADR-0013](adr/0013-external-decoders-as-subprocesses.md))
ahead of the rest of the plugin system, because it is small and the payoff is enormous.

- `process` implementation kind: pipe management, supervision, format negotiation
- Auto-derived convert + resample chain to whatever the program wants on stdin
- `jsonl` output parser, `events` stream type, event-table view
- Opaque-node UI treatment
- Adapters: `rtl_433`, `multimon-ng`, `dump1090`
- **`Identify`** — run every applicable decoder in parallel over the ring, report
  which produced records, offer the winner as a node

**Done when:** three interactions from launch to a named device, and `Identify`
returns in under 3 s with progressive per-decoder results.
This is the **hobbyist shipping moment**, and it is a shortcut *through* the analyst
product — one action on an ordinary node, producing an ordinary node.
**Roughly 60 lines of manifest buy 270+ protocols.** Nothing else in this roadmap has
that ratio, which is why it is not waiting for M4.

---

## M4 — Third parties *(now it's extensible)*

- Plugin manifest schema + registry + validation with real error reporting
- `gr_hier`, `gr_block`, and `grc` implementation kinds (`process` landed at M3.5)
- More adapters: `direwolf`, `dsd`, `acarsdec`, `redsea`
- gr-satellites integration — ~100 decoders behind one dependency
- Plugins panel: what loaded, what didn't, why
- View plugins (client-side)
- Read-only compiled-flowgraph render + `.grc` export

**Done when:** someone outside the project adds a working operation without touching
the codebase.
**Validates:** the entire extensibility bet. If a manifest isn't sufficient to place
and render a block, find out before there are 40 built-in blocks assuming otherwise.

---

## M5 — Bits and meaning *(now it's URH-shaped)*

- `symbols`, `bits`, `bytes`, `events` stream types
- Slicers (OOK/PWM/PPM/Manchester), framing, CRC, a few real decoders
- Bit raster, hex, and event-table views
- Annotations anchored in source coordinates, propagating up the tree (ADR-0007)
- Analyzers emitting event streams; event cursor seeks the tree
- Project save/load, SigMF annotation round-trip (ADR-0008, ADR-0009)

**Done when:** UC-1 and UC-2 run start to finish.

---

## M6 — Beyond the GUI

- Headless CLI + batch runner over capture globs
- Python SDK
- Links (event field → hot parameter) for UC-3
- Tauri desktop shell
- Plugin version pinning in project files

**Done when:** UC-3, UC-5, and UC-6 run start to finish.

---

## Sequencing rationale

The order is chosen so that **the riskiest assumption in each layer is tested as
early as it possibly can be**:

- M0 tests whether the transport and rendering design can hold 30 fps *without jitter*.
- M1 tests whether "drag a box, get a node" actually feels like the product does in
  our heads. This is the premise; it is tested second.
- M2 is the first shippable thing, deliberately early — real users beat speculation.
- M3 is the differentiator, placed before extensibility because it shapes what the
  plugin API must expose about time.
- M3.5 is out of order on purpose: highest capability-per-line-of-code in the plan,
  and it stress-tests the type system's auto-resampling against real programs with
  real format demands before the plugin API is frozen.
- M4 tests the manifest contract while the built-in block count is still small enough
  to change it.
- M5 and M6 are additive and carry no architectural risk.

Three things are deliberately **not** deferred, because retrofitting each one is the
kind of rewrite this roadmap exists to avoid:

- **The command log** (M1) — undo, project files, crash recovery, and scripting all
  hang off it.
- **The Rust relay and ring contract** (M0) — a three-language interface is far
  cheaper to define before there is anything on either side of it.
- **Frame-timing instrumentation** (M0) — you cannot fix jitter you never measured,
  and by M5 nobody will remember which change caused it.

And two enforced from M0 because they erode silently: the **license boundary**
(ADR-0015) and the **source plugin interface** staying independent of SoapySDR
(ADR-0016).
