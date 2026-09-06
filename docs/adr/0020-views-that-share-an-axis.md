# ADR-0020: Views that share an axis are one view

**Status:** Accepted
**Refines:** [ADR-0018](0018-contextual-menus-and-view-tabs.md)

## Decision

**Spectrum and waterfall are a single tab**, stacked vertically over **one shared
frequency axis** drawn once, at the bottom.

Generalised: *if two views plot against the same independent variable, they belong in
one pane with that axis shared — not in two tabs.*

```
┌─────────────────────────────────────────────────────────┐
│ Spectrum │ Time │ Constellation │ Bits │ Flow │ +        │
├─────────────────────────────────────────────────────────┤
│      ╱╲        ╱╲                                       │  live trace
│  ╱╲╱  ╲──╱╲──╱  ╲───╲                                   │  + peak hold
│ ─────────────────────────────────────────────────  ▓    │  + color bar →
├───────────────── draggable splitter ──────────────  ▓ ──┤
│ ░░░▒▓█▓▒░░    ░▒▓░                                 ▒    │
│ ░░░▒▓█▓▒░░    ░▒▓░                                 ░    │  waterfall
│ ░░░▒▓█▓▒░░    ░▒▓░                                      │
├─────────────────────────────────────────────────────────┤
│ 433.720    433.820    433.920 MHz    434.020   434.120  │  ONE axis, both panes
└─────────────────────────────────────────────────────────┘
```

## Why

The spectrum is the instantaneous slice; the waterfall is its history. You read them
*together* — a peak in the trace is only meaningful once you can see whether it has
been there for five seconds or five milliseconds. Every serious receiver stacks them,
and it is not a convention, it is the correct information design: same x, different y,
so share the axis and put one above the other.

Splitting them across tabs would have been a real regression:

- **Two axes for one variable** — duplicated chrome, and a chance to disagree.
- **Zoom and pan would need syncing** between tabs, which is a bug factory. Sharing
  one axis makes it structurally impossible for them to drift.
- **A selection box would exist twice.** Drawn on either pane it now spans both,
  because it is one region in one frequency space.
- You would be **switching tabs constantly** during the single most common activity
  in the product.

## Consequences

- **The axis is the object.** Scrolling or pinching it zooms both panes; that is where
  span lives ([ADR-0019](0019-settings-surfaces.md), tier A).
- **The splitter is draggable, and collapses.** "Waterfall only" and "spectrum only"
  are the splitter at its extremes, not separate tabs — fewer tabs, no modes.
- **The color bar sits at the right edge of the waterfall**, its two handles setting
  the dB range for both panes.
- The spectrum pane carries three traces — live, averaged, and peak-hold — because
  peak-hold is what makes a waterfall's history legible in the instantaneous view.

## Where else the rule applies

| Shared axis | One pane |
|---|---|
| Frequency | Spectrum + waterfall |
| Time | Demodulated waveform + bit raster + decoded records, aligned |
| Time | Time series + its spectrogram |
| *(none)* | Constellation, eye diagram — their own tabs, correctly |

The bit-level case matters as much as the spectrum one: seeing a decoded byte line up
under the waveform that produced it is most of what makes URH good, and it falls out
of the same rule.
