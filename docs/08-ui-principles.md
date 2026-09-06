# UI Principles: The Friction Contract

The premise of this project is that the *workflow* is the product. That makes GUI
friction a correctness property, not a polish item. This document is written as a
contract we can be held to, with numbers.

## Twelve laws

1. **Five seconds to spectrum.** Launch to a moving waterfall, no project dialog, no
   wizard, no sample-rate prompt. The app opens onto a single list: recent captures
   on top, detected devices below. One click.

2. **No modal dialogs in the analysis loop.** Ever. Modals are how SDRangel and
   Sceptre bury their capability. Parameters live in the inspector, always visible.
   Confirmation is undo, not a prompt.

3. **Menu depth ≤ 1.** One flat, searchable list of operations. Headers and the
   search field appear once it is long enough to need them; below that, typing
   summons the field with the keystroke in it.
   Anything that wants to be a submenu becomes a filtered search instead. This law is
   what makes contextual menus safe ([ADR-0018](adr/0018-contextual-menus-and-view-tabs.md));
   a nested context menu would be worse than the sidebar it replaced.

4. **One structural gesture.** Drag a box. Everything else is picking from a short,
   always-valid list.

5. **Every drag is live.** A gesture is only bound to a hot parameter
   ([ADR-0010](adr/0010-hot-vs-cold-parameters.md)). If a value requires a rebuild,
   it does not get a drag handle. The user never discovers lag by feel.

6. **A gesture may create the condition it needs.** Dragging vertically on a live
   waterfall freezes it, because time selection is meaningless while the rows move.
   The tool does the obvious prerequisite rather than making the user discover a
   "hold" button and learn when to press it. Pause, correspondingly, must actually
   hold the display — a paused view that keeps scrolling identical frames looks like
   motion and breaks the promise the button makes.

7. **Never blank the canvas.** During a rebuild, keep painting the last good frame
   at reduced opacity with a thin progress hairline. A spinner over an empty box is
   the single most common way DSP tools feel broken.

8. **Undo always works.** Cmd/Ctrl-Z, unbounded, including node deletion, parameter
   changes, and annotations. Free from the command log
   ([ADR-0009](adr/0009-command-log.md)).

9. **Keyboard for everything repeated.** `/` searches the palette, `↑↓` walks the
   tree, `←→` steps bursts, `Space` play/pause, `Z` zoom to selection, `Esc` clears.
   A power user should be able to run UC-2 without the mouse leaving the waterfall.

10. **Never ask what can be derived — and let the user override all of it.** Every
    derived value is a real parameter with an explicit **auto** (`⟲`, re-derives when
    upstream changes) or **manual** (`🔒`, sticky) state — not a constant chosen once
    in the source. Filter taps, decimation, FFT size, dB range, slice threshold,
    symbol period, clip playback rate: if the engine computed it, the user can take
    it, and auto can always show the evidence it reasoned from
    ([ADR-0017](adr/0017-auto-manual-parameters.md)). Exploration is a sequence of
    held and varied quantities; the tool has to know which is which.

11. **Chrome recedes; the signal is the hero.** No gradient buttons, no chrome
    borders, no decorative panels. The waterfall is the brightest thing on screen,
    it gets the full width of the window, and everything else is quiet until hovered.
    Operations come to the cursor rather than occupying a permanent rail.

12. **Name it on screen; explain it on hover.** Visual simplicity is the goal, and
    words are the most expensive thing on a dense screen. Labels and values stay
    visible — a thing you cannot read is a thing you cannot find. *Descriptions*,
    rationale, constraints and consequences go in tooltips. And state earns a
    **cheaper visual encoding** rather than a word: the auto/manual mode is a 2 px
    colored edge, not a chip reading "auto".

## Layout

Actions come to the cursor. State gets a persistent surface. Views are tabs.
([ADR-0018](adr/0018-contextual-menus-and-view-tabs.md))

```
┌──────────────────────────────────────────────────────────────────┐
│ rtl-sdr #0 › A · Tuner ⊓ ✕ › B · Tuner                           │ breadcrumb
├──────────────────────────────────────────────────────────────────┤
│ Spectrum │ AM env ✕ │ PWM │ Flow │                            + │ block tabs
├──────────────────────────────────────────────────────────────────┤
│      ╱╲        ╱╲                                           ▓    │ live + peak
│  ╱╲╱  ╲──╱╲──╱  ╲───╲                                       ▓    │ hold traces
├────────────────── draggable splitter ───────────────────────▒────┤
│ ░░░▒▓█▓▒░░    ░▒▓░                                          ░    │ waterfall
│ ░░░▒▓█▓▒░░    ░▒▓░        ← drag a box, release, menu opens       │ + color bar
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

Three thin bars and a canvas. The tree is a breadcrumb because it is *navigation*,
not a palette; the whole tree, when you want it, is the **Flow** tab.

**Spectrum and waterfall are one tab, not two** ([ADR-0020](adr/0020-views-that-share-an-axis.md)).
They plot against the same frequency, so they stack over one shared axis drawn once.
A peak in the trace only means something once you can see whether it has been there
for five seconds or five milliseconds — you read them together, always. The splitter
between them is draggable and collapses either way, which is how "waterfall only"
exists without being a mode.

### The parameter bar floats, and a tap opens the control

**One pill holding runs of bare controls**, floating over the bottom of the canvas —
the shape of the HUD in `livethisdream/ece444` (`book/_static/shell.css`), which
solves the same problem well. Bordering every control makes nine boxes in a box; the
container is the only edge, and the controls inside earn a background on hover.

Three things taken from it directly:

- **A control is labeled with its current value**, not its own name. There, the page
  counter *is* the contents button, because "12/25" already says what it opens. Here
  a pill reads `1024 bins` or `Viridis`; the parameter's name lives in the popover it
  opens and in its tooltip, rather than being spent on the bar. That alone took the
  bar from 962 px to 504.
- **`width: max-content`** with a viewport cap. A fixed element given `left` and no
  `right` shrink-fits against half the window and wraps onto two rows at phone widths
  while its contents would have fitted.
- **Fold controls into popovers rather than hiding them when space runs short.**
  Their note is the reason: the presenter tools were hidden below 46 rem to stop the
  bar overflowing a phone, which dropped exactly the wrong things. Everything stays
  available at every width.

Floating also costs the waterfall no height, and lets the bar be only as wide as it
needs to be rather than as wide as the window.

**Tapping a pill opens a popover with a control shaped to the parameter** — a list for
an enum, a slider with steppers for a number, and an `⟲ auto` switch wherever
something can derive the value. Scrub-dragging a number pill still works, so the fast
path survives for a mouse, but it is no longer the *only* path: dragging was hard to
aim, and on a touch screen it fought the bar's own horizontal scroll.

Each group keeps its three most-used controls inline and folds the rest behind one
`⋯` pill. A bar that shows everything is the old strip with round corners.

Read-only values stay on the bar as dimmed, inert pills. They are what the top row
stopped repeating, so they have to live somewhere.

### The strip is cells, not a text run

A horizontal list of `label: value` pairs is a status line, not a control surface —
everything carries equal weight and nothing invites a gesture. So each parameter is a
**cell**: label above, value large in tabular mono, unit beneath. Cells group under
the node name and the view name.

Three things do the organising work, and none of them is a text badge:

- **A 2 px left edge carries the mode**, in four states: green `⟲ auto`, coral
  `🔒 manual`, neutral for a setting with no auto counterpart, and none at all for a
  read-only output. Six repeated "auto" chips were noise; a colored edge is scannable
  at a glance and silent when you are not looking for it. Clicking the edge toggles it.

  The neutral state matters more than it sounds. The accent means *the user placed
  this*, so a display setting nobody overrode must not wear it — the first version
  painted every view parameter coral, and a strip where most cells shout drowns out
  the two that should.
- **Read-only outputs look read-only.** A derived output rate has no fill and no
  edge — it is a consequence, not a control, and should not invite a drag.
- **Each cell is its own drag target.** Value cells scrub; enums cycle; the range
  cell opens two handles. The control gets the affordance its *type* deserves rather
  than every parameter rendering identically.
- **And it has to look it before the pointer arrives.** The first version rendered
  every cell as label-value-unit with no affordance, and it was read as a row of
  metrics — someone asked what the readouts at the bottom were *for*. Law 12 moves
  explanation to hover; it never moves **interactivity** there. Scrubbable values
  carry faint drag chevrons at rest, enums show a caret, and read-only outputs have
  neither, so the three kinds are distinguishable without touching anything.

### One row for "which radio, and where in it"

The device is the root of the analysis path, so the top row carries only **which
radio and where in it**: the source's name and live indicator, then the channel path.
An earlier layout had a status bar as well, and named the source twice, the current
channel three times, and the sample rate twice — the top of the screen describing
itself instead of the signal.

Numbers are not identity, so none live up there. The device's center frequency and
sample rate are its node's parameters and belong in the strip when the source is
selected; the channel's own rate is the derived `out` cell it already was. Nothing is
lost by moving them, because **the frequency axis under the spectrum shows absolute RF
at all times** — the one number you need constantly is already drawn against the data
it describes. The tab bar needs no channel chip either, since the highlighted crumb
sits directly above it.

The rule generalises: **before adding a row, check what the rows you have already
say.** Chrome accretes by addition and only ever shrinks deliberately.

### Naming tabs

A block tab is named for the node whose result it shows — `AM env` — and the channel
is named **once**, in the breadcrumb, rather than prefixed onto every tab.

Prefixing (`A: Spectrum`, `A: Time`, `A: Flow`) repeats information that is identical
across the entire row, in the most horizontally constrained strip in the layout, which
is the word budget's exact failure mode.

**Only channels are lettered.** A letter answers "which signal am I looking at", and
there is one of those per breadcrumb entry. Spending letters on the blocks inside a
channel — `A · Tuner` › `C · AM env` › `D · PWM` — gave every demodulator a name that
carried no information, and made a chain of blocks read as a row of peers. Blocks are
known by what they do, which is shorter and already unique within a channel.

Siblings stay visible at the current breadcrumb level rather than collapsing to the
selected one — a set of channels off one source is the normal case, and a breadcrumb
that hides the others reads as though the tool forgot what you built.

The prefix does become right in one place: a **torn-off tile** has no breadcrumb above
it, so a floating pane is labeled with its full path, `B · Tuner › PWM`.

### Removal lives on the thing being removed

An `✕` appears on the current breadcrumb entry and on the current block tab, and
nowhere else. Putting one on every crumb and every tab turns the two most-used
navigation rows into a row of ways to lose work — and on a phone, into a row of
mistargets. Putting it on the one you are looking at answers "how do I get rid of
this?" in the place the question gets asked, and it is never the thing your thumb
lands on by accident.

### The display range has to follow the data

Narrowing a channel narrows its FFT bins, so its noise floor sits ten to twenty dB
below its parent's. A dB range inherited from the parent leaves a tuner rendering
*entirely beneath the colormap floor* — which looks exactly like a display that has
stopped, and was reported as one.

Measured on the synthetic scene: the source spans −83…−12 dB, a 50 kHz tuner off it
spans −103…−64, a 10 kHz tuner −100…−70. No fixed default straddles those. So the
range is `⟲ auto` per channel, fitted to the tenth percentile and the strongest bin,
snapping on arrival and easing while live — and pinned the instant you drag the color
bar or scrub the cells.

The general lesson is broader than dB: **a derived default computed once for the root
is not a default, it is an assumption about every child.** Anything that scales with
sample rate, bin width or bandwidth has to be re-derived per node or it will be wrong
everywhere except where it was chosen.

### Zooming is not tuning

Two operations narrow the frequency you are looking at, and confusing them would be
expensive:

- **Tuning** narrows the *signal*. It creates a channel, changes the sample rate, and
  runs real DSP. It is a structural act, it appears in the breadcrumb, and it is undoable
  as a node.
- **Zooming** narrows the *view*. Same signal, same rate, more pixels per hertz. It
  changes nothing downstream and belongs to the display, so it lives in the view
  parameters and on the object itself.

Both are reached from the same surface, which is why the distinction has to be legible.
A drag creates a channel; a wheel, a pinch, or `+`/`-` zooms. Every coordinate mapping
runs through the visible window rather than the channel span, so a box drawn while
zoomed lands where it looks like it lands — and the axis labels, which always read
absolute RF, are the honest indicator of where you are.

**Gestures**: wheel or pinch to zoom about the pointer; shift-wheel or a two-finger
drag to pan; `+`/`-` to zoom about the center; `0` or double-click to fit the span. A
`×` factor appears on the axis only when zoomed, so the default view says nothing.

### Chrome sits beside the signal, not on it

The parameter bar floated over the waterfall and covered the frequency axis — the
labels it could least afford to hide. Both bars now sit **below the axis**: the
transport pill, then the options pill. Floating buys nothing if what it floats over is
the thing you were reading.

### Instrumentation is not chrome

The interaction, travel, frame-rate and jitter counters are a **development
instrument**, not part of the product. They live behind the `M` key, off by
default, with no button — a control for a development instrument was still a control
on the bar. Their job is to fail a build, not to occupy a permanent strip in a
tool whose tenth law is that chrome recedes.

### Where settings live

There is **no settings pane** — not on the left, not anywhere. "Settings" is four
things with four lifetimes, and one test assigns every one of them
([ADR-0019](adr/0019-settings-surfaces.md)):

> **If you must see the signal change as you change it, the setting goes on the object
> or in the strip. If not, it can go where the signal isn't.**

| Home | What lives there |
|---|---|
| **On the object** | dB range (`⟲ auto` by default; drag the color bar to pin it), **zoom and pan** (wheel, pinch, `+`/`-`/`0`), selection bounds, playhead. No chrome at all — the control belongs where its effect is. |
| **The strip** | Node parameters, then the *active view's*, as two labeled groups of cells. Device gain and PPM are node parameters of the source. A `⌄` expands the strip into a temporary panel when a node has many. |
| **A view tab** | Flow, Plugins, Annotations, Project. Full canvas, zero chrome, reached like any other view. |
| **A preferences overlay** | Theme, keybindings, plugin paths, disk budget, audio device. A modal is honest here — law 2 governs the analysis loop, and configuring the tool means deliberately stepping out of it. |

The one hard case — clipping while four levels deep, with gain belonging to the
source — is answered by the rig bar carrying live source health: the clip indicator
is clickable and moves the breadcrumb to the source. One click, no permanent chrome.

## Law 12 in detail — because the naive version is harmful

"Move text into tooltips" taken literally produces a wall of unlabeled controls: the
SDRangel failure we [named as an anti-pattern](#named-anti-patterns). Three boundaries
keep it honest.

**Identity is visible; explanation is on hover.** The test is *what* versus *why*.

| Always visible | On hover |
|---|---|
| `CENTER` · `433.8950` · `MHz` | why 433.8950 — the estimator and its evidence |
| The colored mode edge | "Manual, pinned 12:04. Auto would suggest 47.5 kHz." |
| `AM envelope` in the menu | what it does, what it outputs, its rate constraint |
| `rtl_433` and its `ext` mark | "External process — opaque, no drill-down past this node" |
| `ring 41.2 s` | retention policy, disk budget, where the ring is written |
| A node's error mark | the traceback |

An auto/manual tooltip **shows what the other mode would have said** — pinning a width
to 50 kHz should tell you auto would have chosen 47.5. That is exactly the kind of
content that is invaluable on demand and unbearable as permanent text.

**What you need mid-gesture stays visible.** You cannot hover while dragging. Any
state you check *during* a gesture — the mode edge, the value you are scrubbing, the
selection bounds — is visible, always. This is the boundary that stops the law from
eating the interface.

**A tooltip is never the only path.** Everything in one is reachable from the expanded
strip or a details view, for keyboard and touch users. A tooltip is an accelerator,
not a hiding place.

### Word budget

> **No sentence appears in persistent chrome.**

Chrome carries labels, values and units — nothing that parses as prose. A placeholder
like an em-dash standing in for an absent unit is also a word: leave the space blank
and keep the baseline instead.

**"Persistent" is doing the work in that sentence.** Prose is welcome in four places,
all of them transient or opt-in — which is also where the newcomer's on-ramp lives,
and the answer to the discoverability cost of
[ADR-0018](adr/0018-contextual-menus-and-view-tabs.md):

| Where prose is allowed | Why it is not clutter |
|---|---|
| **Tooltips** | Summoned, never occupying |
| **Empty states** | Vanish the moment there is content — the canvas before any node exists is the right place to say "drag a box" |
| **Error messages** | The one time explanation is the whole point |
| **Preferences overlay** | You deliberately left the analysis loop |

**Scope: this law governs the product, not its documentation.** The design docs and
the published design page are *supposed* to explain themselves at length — that is
their entire job, and captions, legends and rationale belong there. A reader of the
spec and a user of the instrument have opposite text budgets. Do not point this budget
at `docs/`.

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
palette. UI chrome is neutral grey. **The accent marks what the user placed** — the
selection box, the playhead, a parameter pinned to manual. Nothing else takes it.
(Errors use the semantic critical red, not the accent; a failure is not something the
user placed.) That single rule is easier to hold than a list of allowed locations,
and it is why a pinned parameter and a selection box share a color: both are the
user's mark on the instrument.

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
- Any PR that adds a modal, a submenu, a required-value prompt, or a **sentence in
  persistent chrome** needs an explicit argument in the description.
- Every milestone demo is a **cold launch running a full use case on video**, timed.
  If it doesn't feel good on video, it doesn't feel good.
