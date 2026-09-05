# ADR-0006: Semantic stream types drive the palette

**Status:** Accepted

## Decision

Ports are typed with **semantic** types, not machine types. Not `complex float32` but
`iq(sample_rate, center_hz, t0)`; not `uint8` but `bits` or `symbols(rate, alphabet)`.
The palette at any node is the set of operations whose declared input type and
constraints match that node's output type — computed server-side.

Types: `iq`, `real`, `symbols`, `bits`, `bytes`, `events`, `image`.

## Why

- **This is the anti-SDRangel decision.** The reason its UI overwhelms is that every
  capability is always visible whether or not it applies. If the tool knows a node
  emits `bits`, it can offer four things instead of two hundred, and all four work.
- It's what lets a plugin author write **zero UI code** (see [plugins](../04-plugins.md)).
  The manifest's type declaration is the placement logic.
- It catches whole categories of user error before they become confusing silence:
  you cannot attach an FM demodulator to a bitstream.

## Cost

- Real blocks are messier than a type lattice. Some genuinely don't know their output
  type until they run.
- Types will need to evolve, and every plugin manifest references them, so changes
  are semi-public API.

## Mitigation

`out_type: dynamic` — a block may report its type at runtime. Its palette entry shows
after first run rather than before. Used sparingly; it degrades the experience, so it
should feel like an escape hatch rather than a default.

## Would change our mind

If `dynamic` becomes common rather than rare, the type system is too narrow and needs
richer parameterization — not removal.
