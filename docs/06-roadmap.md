# Roadmap

Each milestone is independently useful. If the project stops at any of them, what
exists still works and is worth using. No milestone is a refactor of the previous one.

---

## M0 — Spectrum in a browser *(the walking skeleton)*

Prove the three-plane architecture end to end with the least DSP possible.

- Server: session manager, SigMF file source, one worker process, ZMQ control
- Display renderer: FFT → `spectrum` frames at 30 fps
- Data plane: WebSocket binary framing, one subscription
- Client: WebGL2 waterfall + spectrum, transport controls

**Done when:** open a SigMF file, see a smooth waterfall, scrub it. No tree, no
tuner, no demod.
**Validates:** ADR-0001, ADR-0012, and the WebGL rendering path — the three things
most likely to be wrong in a way that forces a rewrite.

---

## M1 — Selection → Tuner → child view *(the core loop)*

The one gesture the whole product rests on.

- Node tree data model + command log
- Graph compiler for `source` and `tuner` only
- Selection → derived decimation and taps
- Tree pane, canvas switching, inspector with overridable derived values
- Hot retune (drag the box, spectrum follows)

**Done when:** drag a box, get a child waterfall, drag the box again and the child
follows live.
**Validates:** ADR-0002 and ADR-0010. If drilling in doesn't feel instant here, the
premise is wrong and it is cheap to find out now.

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

- Ring recorder for live sources; live and file unified (ADR-0005)
- Live SDR sources via gr-osmosdr / SoapySDR
- Time selection → `gate` node
- Multi-resolution pyramid: instant overview of large files, zoom as a server query
- Scrub backwards on a live source

**Done when:** you can catch a burst that already happened, zoom into 40 ms of it at
full resolution, and re-run a chain over it.
**This is the first capability no free tool has.**

---

## M4 — Third parties *(now it's extensible)*

- Plugin manifest schema + registry + validation with real error reporting
- `gr_hier`, `gr_block`, and `grc` implementation kinds
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

- M0 tests whether the transport and rendering design can hold 30 fps at all.
- M1 tests whether "drag a box, get a node" actually feels like the product does in
  our heads. This is the premise; it is tested second.
- M2 is the first shippable thing, deliberately early — real users beat speculation.
- M3 is the differentiator, placed before extensibility because it shapes what the
  plugin API must expose about time.
- M4 tests the manifest contract while the built-in block count is still small enough
  to change it.
- M5 and M6 are additive and carry no architectural risk.

The one thing deliberately **not** deferred is the command log (M1). Retrofitting
undo, project files, and scripting onto a mutable-state design is the kind of rewrite
this roadmap exists to avoid.
