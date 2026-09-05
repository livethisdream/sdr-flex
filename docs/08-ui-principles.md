# UI Principles: The Friction Contract

The premise of this project is that the *workflow* is the product. That makes GUI
friction a correctness property, not a polish item. This document is written as a
contract we can be held to, with numbers.

## Ten laws

1. **Five seconds to spectrum.** Launch to a moving waterfall, no project dialog, no
   wizard, no sample-rate prompt. The app opens onto a single list: recent captures
   on top, detected devices below. One click.

2. **No modal dialogs in the analysis loop.** Ever. Modals are how SDRangel and
   Sceptre bury their capability. Parameters live in the inspector, always visible.
   Confirmation is undo, not a prompt.

3. **Menu depth ≤ 1.** One flat, searchable list of operations, grouped by headers.
   Anything that wants to be a submenu becomes a filtered search instead. This law is
   what makes contextual menus safe ([ADR-0018](adr/0018-contextual-menus-and-view-tabs.md));
   a nested context menu would be worse than the sidebar it replaced.

4. **One structural gesture.** Drag a box. Everything else is picking from a short,
   always-valid list.

5. **Every drag is live.** A gesture is only bound to a hot parameter
   ([ADR-0010](adr/0010-hot-vs-cold-parameters.md)). If a value requires a rebuild,
   it does not get a drag handle. The user never discovers lag by feel.

6. **Never blank the canvas.** During a rebuild, keep painting the last good frame
   at reduced opacity with a thin progress hairline. A spinner over an empty box is
   the single most common way DSP tools feel broken.

7. **Undo always works.** Cmd/Ctrl-Z, unbounded, including node deletion, parameter
   changes, and annotations. Free from the command log
   ([ADR-0009](adr/0009-command-log.md)).

8. **Keyboard for everything repeated.** `/` searches the palette, `↑↓` walks the
   tree, `←→` steps bursts, `Space` play/pause, `Z` zoom to selection, `Esc` clears.
   A power user should be able to run UC-2 without the mouse leaving the waterfall.

9. **Never ask what can be derived — and let the user hold it.** Decimation, filter
   taps, FFT size, colormap range, symbol period, audio rate: all computed, all shown,
   none required. But derivation is a *mode*, not a one-time gift. Every derived value
   carries an explicit **auto** (`⟲`, re-derives when upstream changes) or **manual**
   (`🔒`, sticky) state, and auto can always show the evidence it reasoned from
   ([ADR-0017](adr/0017-auto-manual-parameters.md)). Exploration is a sequence of held
   and varied quantities; the tool has to know which is which.

10. **Chrome recedes; the signal is the hero.** No gradient buttons, no chrome
    borders, no decorative panels. The waterfall is the brightest thing on screen,
    it gets the full width of the window, and everything else is quiet until hovered.
    Operations come to the cursor rather than occupying a permanent rail.

## Layout

Actions come to the cursor. State gets a persistent surface. Views are tabs.
([ADR-0018](adr/0018-contextual-menus-and-view-tabs.md))

```
┌──────────────────────────────────────────────────────────────────┐
│ rtl-sdr #0 ▾ › A · Tuner ▾ › B · Gate ▾ › C · AM ▾ › D · PWM ▾   │ breadcrumb
│                              each ▾ opens that node's siblings   │
├──────────────────────────────────────────────────────────────────┤
│ Spectrum │ Waterfall │ Time │ Bits │ Flow │ +                    │ view tabs
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│                  CANVAS — full width                             │
│                                                                  │
│              drag a box ──▶ release ──▶ menu opens here          │
│                                          ┌──────────────────┐    │
│                                          │ / search…        │    │
│                                          │ ── DEMODULATE ── │    │
│                                          │ AM envelope      │    │
│                                          │ NBFM             │    │
│                                          │ ── DECODE ────── │    │
│                                          │ ⌁ Identify       │    │
│                                          │ rtl_433  ext     │    │
│                                          └──────────────────┘    │
├──────────────────────────────────────────────────────────────────┤
│ ◀◀ ▶ ▶▶  ──────────●───────────────────────────────  12.331 s    │ transport
├──────────────────────────────────────────────────────────────────┤
│ PWM D   symbol 417 µs ⟲   threshold 0.42 🔒   invert off ⟲       │ inspector
└──────────────────────────────────────────────────────────────────┘
```

Three thin bars and a canvas. The tree is a breadcrumb because it is *navigation*,
not a palette; the whole tree, when you want it, is the **Flow** tab.

## Interaction budget

Countable, testable, and a regression test for the workflow. From cold launch:

| Use case | Target | Breakdown |
|---|---|---|
| **UC-1** live dongle → decoded bits | **≤ 6** | device (2) · freq box (1) · time box (1) · demod (1) · slicer (1) |
| **UC-1'** same, via **Identify** | **≤ 3** | device (2) · Identify (1) |
| **UC-1''** same, picking `rtl_433` directly | **≤ 4** | device (2) · freq box (1) · pick rtl_433 (1) |
| **UC-2** open file → burst event table | **≤ 4** | open (2) · freq box (1) · burst detector (1) |
| **UC-3** add a monitored channel | **≤ 2** | freq box (1) · demod (1) |
| Retune an existing channel | **1** | drag the box |
| Compare two bursts | **≤ 3** | click row · `←`/`→` |

If a change to the design makes any of these numbers go up, the change is wrong until
argued otherwise. These get counted in review.

### Pointer travel

Clicks alone are the wrong metric, and counting only clicks would have scored the old
pinned-sidebar layout as equal to the contextual one. It was not equal — it charged a
~600 px round trip for every single operation. So travel is measured too:

| | Budget |
|---|---|
| Pointer travel per operation, after a selection drag | **< 120 px** |
| Pointer travel, full UC-1 run | **< 900 px** |

A design that adds a pinned panel between the canvas and a frequent action fails this
even if it adds no clicks.

## Latency budget

"Speed" for a GUI means *perceived* speed, and perception has thresholds. Every
number below is a hard target, measured end to end, at 2.4 MS/s on a mid-range laptop.

| Interaction | Budget | Why that number |
|---|---|---|
| Drag tuner box → child spectrum moves | **< 50 ms** | Below ~100 ms a drag feels attached to the cursor; above it, it feels like remote control |
| Waterfall frame cadence | **30 fps sustained, 60 preferred, jitter < 4 ms** | Jitter is more visible than rate. A steady 30 beats a lumpy 60. |
| Palette open | **< 16 ms** | One frame. It is a pre-computed list; there is no excuse. |
| Add a node → first frame from it | **< 300 ms** | Includes a fragment rebuild. Beyond this it needs the dimmed-last-frame treatment (law 6). |
| Cold launch → first waterfall frame | **< 5 s** | Law 1 |
| Open a 4 GB capture → overview | **< 2 s** | Pyramid read, not a scan ([ADR-0012](adr/0012-server-side-display-rendering.md)) |
| Zoom to a new time window | **< 120 ms** | Server round trip; cached pyramid levels make small zooms instant |
| Seek to a burst from an event row | **< 200 ms** | |
| `Identify` over an 8 s window | **< 3 s** | Decoders run in parallel over ring data at faster-than-real-time. Progressive results — each decoder reports as it finishes, no all-or-nothing wait. |
| Audio glitch on a sibling edit | **0** | Fragment isolation ([ADR-0004](adr/0004-flowgraph-splitting-at-taps.md)) — this is a correctness bug, not a performance one |

### Where the 50 ms goes

```
mouse move → client                     ~1 ms
control message → server → worker       ~2 ms   (hot param, no rebuild)
GR message port → block setter          ~1 ms
GR buffer latency                      10-30 ms  (tunable: max_noutput_items)
tap ring hop                            ~2 ms
Rust relay: ring → frame → WebSocket    <1 ms   (ADR-0014)
browser: WS → texture upload → paint    8-16 ms
                                       ─────────
                                        25-53 ms
```

The two variable terms are GR's buffer latency and the browser's frame. Both are
tunable, and neither involves Python — which is exactly why the hot path is Rust
([ADR-0014](adr/0014-rust-data-plane.md)). A GC pause in a Python relay would show up
as visible waterfall jitter, and this user base will see it.

## Visual direction

**Dark first.** Not a theme option — the primary design target. Signal work happens in
dim rooms and the waterfall carries the information; a bright UI destroys the dynamic
range your eye has available for it.

**Perceptually uniform colormaps only.** Viridis, inferno, magma, cividis. The
classic rainbow/jet colormap **lies about the data** — it creates false edges at the
cyan and yellow bands and hides real structure in the green. Offer jet under a
"legacy" label for people who have trained on it, and default to something honest.
Colormap range auto-fits from a running percentile of the data, and is draggable on
the color bar.

**Color is data, not decoration.** The waterfall owns the saturated end of the
palette. UI chrome is neutral grey. Accent color appears in exactly three places:
the active selection box, the playhead, and error states. Nothing else is colored.

**Typography.** One sans family for UI, one mono for numbers. Every frequency,
rate, and timestamp is tabular-figure mono so digits don't jitter as they update —
this matters enormously when values are changing 30 times a second and it is the
kind of thing that reads as "expensive" without anyone knowing why.

**Density.** Closer to a DAW than to a web app. Information-dense, but with real
alignment and consistent spacing — dense is not the same as cramped. The failure mode
we are avoiding is SDRangel's, which is dense *and* unaligned, so the eye can't find
anything.

**Motion, only for continuity.** Tree expansion, canvas cross-fade on node switch,
the selection box snapping. 120–180 ms, ease-out. Nothing bounces. Nothing pulses.
No loading skeletons — see law 6.

**The flowgraph, when shown, is beautiful and read-only.** It is the reward for
curiosity, not the workspace. Auto-laid-out left-to-right, edges labeled with rate
and type, the currently selected node highlighted. It should make a GNU Radio user
smile and a newcomer understand.

## Named anti-patterns

Each of these is a real failure in a real tool, listed so we can point at them in
review:

| Anti-pattern | Where | Our rule |
|---|---|---|
| Capability reachable only through nested menus | Sceptre | Law 3 |
| Wall of tiny buttons, most inapplicable | SDRangel | Type-filtered palette ([ADR-0006](adr/0006-semantic-stream-types.md)) |
| Data flow invisible; can't tell what feeds what | SDRangel | The tree *is* the navigation |
| Features bolted on beside the workflow instead of into it | GQRX | Everything is a node; there is no "extras" menu |
| Great data-flow view, useless data view | GNU Radio | The canvas is the product; the flowgraph is a toggle |
| Powerful only if you already know the answer | GRC, URH | Analyzers propose (symbol period, burst bounds, protocol guess) |
| Modal config before you can see anything | most | Law 1 |
| Spinner over a blank canvas | most | Law 6 |
| Rainbow colormap | almost all | Perceptually uniform default |

## How we hold ourselves to this

- The interaction and latency budgets are in CI as **automated tests**, not aspirations:
  a scripted client counts interactions for each use case and measures frame timing.
- Any PR that adds a modal, a submenu, or a required-value prompt needs an explicit
  argument in the description.
- Every milestone demo is a **cold launch running a full use case on video**, timed.
  If it doesn't feel good on video, it doesn't feel good.
