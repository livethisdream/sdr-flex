# ADR-0018: Contextual menus over persistent palettes; views are tabs

**Status:** Accepted
**Revises:** the three-pane layout in [workflow](../02-workflow.md)

## Decision

**Actions come to the cursor. State gets a persistent surface. Views are tabs.**

- The **operation palette is a contextual menu** opened at the pointer, not a pinned
  sidebar. Releasing a selection drag opens it automatically, at the release point.
- The **analysis tree is a breadcrumb** across the top, listing *channels only*, each
  segment a menu of its siblings. The full tree/flowgraph is available as a view tab,
  not a permanent rail.
- **Each channel's blocks are tabs** in the center pane. A *channel* is a node that
  carries IQ — the source, a tuner, a gate; everything downstream of one until the
  next channel is a *block*. Blocks are tabs, not destinations: a channel is a
  workspace you stay in while you flip between the results of what you applied to it.
  So a gate's tab bar reads `Spectrum │ C · AM demod │ D · PWM │ Flow`. Views that share
  an axis occupy one tab together — spectrum and waterfall are the **Spectrum** tab
  ([ADR-0020](0020-views-that-share-an-axis.md)).

  This puts the unit of navigation exactly where the engine splits flowgraph fragments
  ([ADR-0004](0004-flowgraph-splitting-at-taps.md)), which is not a coincidence: a
  channel is a tap boundary, and a tap boundary is where a rebuild stops. What you
  navigate between and what the engine rebuilds independently are the same thing.
- **Parameters live in a bottom strip**, full width, under the canvas.

```
┌──────────────────────────────────────────────────────────────────┐
│ rtl-sdr #0 › A · Tuner ⊓ ✕ › B · Tuner                           │ breadcrumb
├──────────────────────────────────────────────────────────────────┤
│ Spectrum │ AM demod ✕ │ Listen │ Flow │                        + │ block tabs
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│                  CANVAS — full width                             │
│         drag a box → release → menu opens right there            │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│ ◀◀ ▶ ▶▶  ──────────●───────────────────────────  12.331 s        │ transport
├──────────────────────────────────────────────────────────────────┤
│ PWM D   symbol 417 µs ⟲   threshold 0.42 🔒   invert off ⟲        │ inspector
└──────────────────────────────────────────────────────────────────┘
```

## Why

The palette was **already contextual** — filtered by the node's output type
([ADR-0006](0006-semantic-stream-types.md)). Pinning a contextual thing to the wall
is the worst of both: it takes permanent width *and* still requires the mouse to
travel there. Bringing it to the cursor loses nothing and gains three things:

1. **Zero pointer travel.** In a drag-heavy tool the cursor is already on the signal.
   The old layout charged ~600 px of round trip for every operation.
2. **The gesture completes itself.** Drag → release → "what do you want to do with
   this?" is one continuous motion. Drag → release → traverse to a sidebar → click is
   two disconnected ones.
3. **The waterfall gets the full width.** Frequency resolution is horizontal;
   ~360 px of sidebar was coming straight out of the thing the tool exists to show.
   Consistent with "chrome recedes; the signal is the hero."

Views as tabs is strictly better than the old "canvas shows the default view for this
node's type": a node usually deserves more than one view at once (a demodulator wants
Time *and* Constellation), and the flowgraph becomes an ordinary tab rather than a
special corner toggle.

## Cost — and the honest answer to it

**Hidden menus are less discoverable than visible ones.** This is the real objection
and it is not hand-waved away by asserting that power users prefer context menus.
Four mitigations, all load-bearing:

1. **Releasing a drag opens the menu automatically.** You never have to *know* to
   right-click; completing the one gesture the tool teaches you opens it. This is the
   on-ramp, and it is why the decision is safe.
2. **The menu is flat, with headers and a search field that appear once the list is
   long enough to need scanning rather than reading.** Below that, typing anything
   summons the search field with what you typed already in it, and `/` summons it
   empty — so the keyboard path never depends on the field being drawn. No submenus —
   [law 3](../08-ui-principles.md#ten-laws) survives intact, and it would not survive
   a nested context menu.
3. **A persistent `+` on the tab bar opens the same menu.** There is always one
   visible entry point for someone who has not discovered the gesture.
4. **Hover reveals verbs.** Hovering an object highlights it and shows its primary
   action, so the interface is browsable without clicking.

Secondary costs: a breadcrumb shows one path, not the whole tree, which is a real
loss for multi-channel monitoring (UC-3) — recovered by the Flow tab and by sibling
menus on each crumb. And context menus need genuine keyboard equivalents, which
[law 8](../08-ui-principles.md#ten-laws) already required.

## Effect on the budgets

The raw interaction count is roughly unchanged. **Pointer travel collapses**, and
that is the actual win — so travel joins the
[friction contract](../08-ui-principles.md#interaction-budget) as a measured metric
alongside interaction count. Counting clicks alone would have scored the old layout
as equal, which is exactly how a worse design survives a review.

## Would change our mind

Watching a newcomer fail to find an operation, on video, at a milestone demo. The
fallback is not restoring the sidebar — it is making the auto-opened menu stickier
(pinnable, or open by default until dismissed).
