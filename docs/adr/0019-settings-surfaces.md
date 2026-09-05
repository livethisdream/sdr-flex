# ADR-0019: Settings have four homes, and none of them is a left pane

**Status:** Accepted

## The question

Where do settings live?

## The trap

"Settings" is not one thing. In a tool like this it is at least four, with completely
different lifetimes and completely different requirements:

| | Changes | Must you see the signal while changing it? |
|---|---|---|
| Node parameters — center, width, symbol period, threshold | constantly | **Yes** |
| View parameters — FFT size, window, colormap, dB range, raster columns | often | **Yes** |
| Device parameters — gain, PPM, bias-T, antenna port | occasionally | **Yes**, for gain |
| App preferences — theme, keybindings, plugin paths, disk budget | almost never | No |

Giving all four one home is how you get Sceptre's nested menus: a category tree grows
because unrelated things were forced to share a surface. So they don't share one.

## The discriminator

> **If you must see the signal change as you change it, the setting goes on the object
> or in the strip. If not, it can go where the signal isn't.**

That single test assigns every setting in the product, and it is the reason a left
pane is the wrong answer — it would be a fifth persistent surface holding things that
mostly don't need to be persistent, and it would take back the width
[ADR-0018](0018-contextual-menus-and-view-tabs.md) just bought for the waterfall.

## The four homes

### A · On the object — no panel at all

The setting is a property of a visible thing, so it is adjusted by manipulating that
thing. No chrome whatsoever:

- **dB range / contrast** → drag the ends of the colour bar
- **frequency span** → scroll or pinch on the frequency axis
- **time span, waterfall speed** → scroll on the time axis
- **selection bounds** → drag the box edges
- **position in time** → drag the playhead

This is the same instinct as putting the operation menu at the cursor: the control
belongs where its effect is.

### B · The inspector strip — adjust while watching

The bottom strip already holds node parameters. It gains a second segment for the
**active view's** parameters, because those genuinely belong to the view rather than
the node — the same node's Spectrum tab and Waterfall tab want different settings,
and the strip changes with the tab, which is correct.

```
┌────────────────────────────────────────────────────────────────────┐
│ PWM D  symbol 417 µs ⟲  threshold 0.42 🔒  ┊  BITS  8 col  MSB  hex │
│ ╰──────────── node ────────────────────╯     ╰──── view ──────────╯ │
└────────────────────────────────────────────────────────────────────┘
```

Device parameters are node parameters — select the source node and the strip shows
gain, PPM, bias-T. No special case.

**The strip expands rather than scrolling into uselessness.** A node with fifteen
parameters gets a chevron; clicking it grows the strip into a panel overlaying the
lower third of the canvas. Transient, dismissable, and the *same object* growing —
so nobody learns a second location.

### C · A view tab — when you don't need to see the signal

Reached exactly like Spectrum or Waterfall, costing no chrome and offering the whole
canvas: **Flow**, **Plugins** (what loaded, what didn't, why), **Annotations**,
**Project**. These are surfaces, not panels.

### D · A preferences overlay — rare, deliberate, outside the loop

Theme, keybindings, plugin paths, ring disk budget, audio output device, default
colormap. A large centred overlay is right here, and it does **not** violate
[law 2](../08-ui-principles.md#ten-laws): that law forbids modals *in the analysis
loop*, and configuring the tool is the act of deliberately stepping out of it.

## The one hard case

You are four levels deep in the tree, the waterfall is clipping, and the gain control
belongs to the source node you are not looking at.

Answer: the **rig bar carries live source health**, including a clip indicator, and
clicking it moves the breadcrumb to the source. One click, no permanent chrome, and
it is already where the eye goes to ask "is my radio okay?" — the bar shows the
device, frequency, rate, ring fill and frame rate.

The rejected alternative is pinning a gain control to every screen forever to serve a
case that arises a few times a session.

## Cost

- Four homes is more to learn than one. Mitigated by the discriminator being
  *behavioural* rather than categorical: things you tune while watching are always
  within reach of what you are watching, and everything else is a tab away. Users
  never have to know the taxonomy, only that reflex.
- View settings living in the strip means the strip's contents change when you switch
  tabs, which could feel unstable. Mitigated by the node segment staying put — only
  the segment after the divider changes.
- Direct manipulation (tier A) is undiscoverable without hover affordances. The
  colour bar, axes and playhead all get a cursor change and a hover highlight; they
  are also all listed in the preferences overlay's keyboard reference.

## Would change our mind

If the expanded strip turns out to be where people live rather than where they visit,
that is evidence the node model exposes too many parameters at once — the fix is
better defaults and more `auto` ([ADR-0017](0017-auto-manual-parameters.md)), not a
permanent pane.
