# ADR-0043: A recipe arranges operations; a plugin adds one

**Status:** Proposed — builds the saved chain [ADR-0024](0024-composable-decode-chain.md)
decided on and never built, in the format [ADR-0042](0042-a-session-is-a-recipe-somewhere-durable.md)
already uses for sessions

## Decision

**A plugin adds an operation the graph could not do before. A recipe arranges operations
that already exist.** The rule for which one a new capability becomes: if it can be built
from existing nodes, it is a recipe; if it needs new math or an outside program, it is a
plugin.

- A **recipe** is data, not code: a short chain of operations, the settings a person chose
  for them, and which settings are left to be derived. Applied to a stream, it expands into
  ordinary nodes, each with its own view and its own evidence (ADR-0017).
- A **plugin** is one node. It is a JS module (ADR-0028), an external program (ADR-0013),
  or a GNU Radio flowgraph run as a program (ADR-0032). The last two are opaque.
- The two compose. A recipe may end in a plugin node: the CW recipe below ends in
  multimon-ng.
- Recipes can be **built from the graph and saved**, shipped with the tool, and carried in
  a decoder pack. Plugins can be **imported from the UI** when they run in the browser,
  and only installed on the box when they run on it.

## Why now

Three things surfaced together on the GRCon26 signal-ID CW slot.

1. **`core.cw` is a bundle.** It mixes a carrier to an audible pitch, which is exactly what
   `core.ssb` does with its oscillator set accordingly. Two copies of the same mixer had the
   same bug twice (each restarted its phase on every read), and only one of them was about to
   get the narrow filter CW needs. ADR-0024 ruled this shape out — "a protocol we own is a
   saved chain of these nodes, not a new node kind" — but there was no way to save a chain,
   so a node kind was the only way to ship one.
2. **The transparent route is gone.** The plugin guide names `gr_hier` as "the default for
   transparent chains". That assumed a GNU Radio engine. M1 was built as a Node engine over
   a WebSocket instead, so a GNU Radio block can only run as a subprocess, and a subprocess is
   opaque (ADR-0013). A chain of native nodes is now the only way to compose something a
   person can see inside.
3. **The automatic and manual paths drifted.** Identify built its chains one way and a
   person built them another, and the same decoder answered differently depending on who
   added it. One description of a chain, read by both, is the fix that cannot drift.

## What a recipe is

The session recipe of ADR-0042, rooted at a stream type rather than at a capture:

```json
{
  "recipe": 1,
  "name": "CW (Morse)",
  "version": "1.0.0",
  "in": "iq",
  "steps": [
    { "op": "core.tuner", "place": { "derive": "strongest-carrier" }, "params": { "widthHz": 500 } },
    { "op": "core.ssb", "params": { "sideband": "usb", "bfoHz": -700 } },
    { "op": "ext.multimon", "params": { "modes": "MORSE_CW" }, "optional": true }
  ]
}
```

- **`in`** is the stream type it applies to, so the palette offers it where it fits
  (ADR-0006), the same test an operation passes.
- **Steps are a chain** by default. A step may name an earlier one in `from` to branch, which
  a stereo-plus-RDS recipe needs.
- **A setting is either kept or derived.** A value written in `params` is applied as a manual
  setting. Anything absent is derived on the signal it lands on, with evidence, exactly as if
  the node had been added by hand. Nothing derived is stored, for the reason ADR-0042 gives.
- **Placement is relative.** A tuner in a recipe never stores an absolute frequency. It is
  placed relative to the node it lands on, either at a fixed offset and width or by a named
  rule (`strongest-carrier`) that the tuner knows how to evaluate and to explain.
- **`optional`** steps are offered and not added unless asked: the CW recipe is useful for
  listening without the decoder.
- **Settings are the node's own.** The SSB step sets `bfoHz`, the oscillator, to −700 so the
  carrier the tuner centered lands at +700 Hz. A recipe cannot invent a setting a node does not
  have; a friendlier name, such as a `pitch` on the SSB node, is a change to the node.

## Building and saving one

**"Save as recipe…" sits in every node's settings**, next to rename. It saves the path from
a starting node (the one it was applied to, or one the person picks) down to this node.
Manual settings are kept, derived ones are dropped, absolute frequencies become relative, and
the person names it. That is the whole feature: a person who has built a chain that works has
already written the recipe.

**Recipes live where sessions live**, in the same two stores with the same shape: a
directory on the box when there is one (`SDRFLEX_RECIPES`, by default beside the sessions
directory), and the browser's own storage when there is not. Recipes that ship with the tool
are files in `web/recipes/`, so the hosted copy has them too. A decoder pack (ADR-0026) may
carry recipes, and its golden capture then tests the recipe end to end.

## How one appears

Applied, a recipe is its nodes. Each is an ordinary node that can be opened, tuned, renamed
or removed. The first node is labeled with the recipe's name (`A · CW (Morse)`), so the chain
says where it came from.

**On a phone, a recipe's nodes fold into one tab** with the recipe's name, opened like the
folded path (the drop-down that shows every entry). Three tabs for one idea is the cost
ADR-0024 accepted on a desktop and a phone cannot afford.

## Importing plugins

- **Browser plugins (JS) are importable from the UI**, which they are today only by dropping
  a file on the window. A phone cannot drop a file, so an **Import plugin…** entry joins the
  source chip's menu and opens a file picker. The plugin is kept in this browser, as today.
  **Keep on the box** is a second, explicit step that writes it to the plugins directory, so
  every tab that connects receives it. That is a statement of trust: it will run in other
  people's browsers. It still never runs on the server (ADR-0029).
- **Process and flowgraph plugins are not importable from the UI.** A manifest is a command
  line, so an upload would let anyone who can reach the page run programs on the box, and the
  page has no authentication. They are installed by copying a pack into `SDRFLEX_ADAPTERS`,
  as today. The UI lists what is installed, whether each program was found, and whether its
  golden capture passes.

## CW, the first recipe

`core.cw` leaves the menu and becomes the shipped recipe above: a 500 Hz tuner on the
carrier (the CW filter, drawn as a box that can be dragged), an SSB demod with its oscillator
set so the carrier sounds at the pitch, and multimon-ng on MORSE_CW when asked. Sessions that
contain a `core.cw` node still load. The carrier and pitch lines move to the tuner and the SSB
node.

## Consequences

- **No new DSP for anything existing nodes can already do.** A new capability starts as a
  question about which bucket it is in.
- **Identify can read the same recipes.** Its chains become recipe steps evaluated
  speculatively, so the manual and automatic paths cannot drift. That is a second phase, not
  part of the first build.
- **A recipe is only as good as the nodes it uses.** If a recipe needs a step that does not
  exist, that step is a plugin or a new core operation, and the recipe waits for it.
- **`.grc` export (M5) gets easier.** Native nodes map to GNU Radio blocks one by one; a plugin
  stays a single leaf.
- **More nodes on screen**, which the folding on a phone exists to absorb.

## Alternatives

- **Keep bundled node kinds like `core.cw`.** Fastest for one case, and it is the shape that
  duplicated the mixer and its bug. Rejected by ADR-0024 already.
- **Write each recipe as a JS plugin.** One node, any logic. Opaque in the way the tool exists
  to avoid, and it runs only in the browser, so it could not reach a server-side decoder.
- **Wait for a GNU Radio engine and use `gr_hier`.** Transparent in principle, and not on any
  roadmap since M1 went to Node.

## Would change our mind

- If most recipes turn out to need logic between steps (conditions, loops), they are programs,
  and the right shape is a plugin kind rather than a richer recipe format.
- If folding a recipe into one tab still leaves a phone unusable, recipes need a summary view
  of their own rather than their nodes.
- If a GNU Radio engine returns, `gr_hier` could become a second transparent route, and this
  decision should be revisited.

## Open questions

1. Should a recipe be able to set a view (for example, a stereo recipe opening on `both`), or
   only operations?
2. Should a saved recipe pin the versions of the plugins it uses, as packs pin program versions?
3. Who can overwrite a recipe on the box: anyone with the page, or only the operator, by file?
