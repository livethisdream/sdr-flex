# ADR-0043: A recipe is a hier block; a plugin adds a block

**Status:** Accepted 2026-10-06 — builds the saved chain [ADR-0024](0024-composable-decode-chain.md)
decided on, on the engine [ADR-0044](0044-gnu-radio-is-the-engine.md) settled; supersedes the
first draft of this ADR, which treated GNU Radio as an opaque subprocess

## Decision

**A recipe is a GNU Radio hierarchical block: a named arrangement of existing blocks, with the
parameters it chooses to expose. A plugin adds a block GNU Radio does not already have.** The
rule for which one a new capability becomes: if it can be built from blocks that exist, it is a
recipe; if it needs new math or an outside program, it is a plugin.

A recipe is how "all of the knobs or none" works, in three steps rather than two:

| | what a person sees | who sets the parameters |
|---|---|---|
| **None** | a decode, from `Identify` | `Identify` picks the recipe; SDR Flex derives every parameter and shows its evidence |
| **A few** | the recipe as one node | the person, for the parameters the recipe exposes; the rest are derived |
| **All** | the recipe opened up, one node per inner block | the person, for any block, each with its own view |

## What a recipe is

**The file format is GNU Radio Companion's own**: a `.grc` hier block. A recipe saved in SDR
Flex opens in GRC on a desktop, and a hier block built in GRC opens in SDR Flex. That is the
on-ramp the plugin guide asked for ("from prototyped in GRC to a first-class operation"), and it
costs no format of our own.

What GRC has no place for is in the recipe itself, in an **SDR Flex recipe block**
(`grc/sdrflex_recipe.block.yml`, 2026-10-07; this replaced a JSON sidecar beside each `.grc`).
It is a block defined by one YAML file, with no ports and no code: GRC draws it, gives it a
form and checks its fields, and the program GRC generates contains nothing for it. Its fields:

- **kind:** folds into one node, which runs as this hier block in the worker (CW), or expands
  into a chain of SDR Flex nodes, one or more per block (WBFM);
- **input and output as semantic stream types** (ADR-0006): iq, real, stereo, audio;
- **which parameters are derived**, and by which estimator (`offsetHz=strongest-carrier`); a
  parameter not listed is the person's;
- **the history variable**, for a recipe that filters, and **whether it ends in Listen**.

The rest is GRC's own. Parameters are named as SDR Flex's settings are (`offsetHz`,
`widthHz`), so a recipe's parameter is a node's setting with no mapping; `samp_rate` and
`start_index` are filled from the stream. Which SDR Flex steps a GNU Radio block is
(`analog_wfm_rcv_pll` is an FM demod and a stereo decode) is one table in SDR Flex
(`web/src/recipes.js`), not a file per recipe. Opening a recipe in GRC on a desktop needs the
one YAML file copied into a GRC blocks folder; without it GRC reports the block as unknown.

## The palette comes from GNU Radio

GNU Radio ships a machine-readable definition of every block it has: 589 in the image today
(`/usr/share/gnuradio/grc/blocks/*.block.yml`), each with its name, parameters and port types,
and every OOT module installs its own the same way. **SDR Flex builds its operation menu from
those definitions** rather than from a table of its own, mapping GNU Radio port types onto the
semantic stream types and ranking them as ADR-0039 does. An OOT module installed on the box is
in the menu with no change to SDR Flex.

## Building and saving one

**"Save as recipe…" sits in every node's settings.** It saves the branch from a starting node
down to this one as a `.grc` hier block plus its sidecar: the blocks, the connections, the
parameters the person set, and, as derived, the ones SDR Flex derived. The person names it and
picks which parameters to expose.

**Recipes live beside sessions** (ADR-0042), in the same two stores: a directory on the box
(`SDRFLEX_RECIPES`), and the browser's own storage without one. Recipes that ship with the tool
are files in the repository. A decoder pack (ADR-0026) may carry recipes, and its golden capture
then tests the recipe end to end.

## Plugins

A plugin adds a block. There are three kinds, and where each may come from follows from what it
runs:

- **An OOT module** (C++ or Python GNU Radio blocks): installed on the box, the way GNU Radio
  installs anything. It runs in the worker, so it is code on the box, and it is **never uploaded
  through the UI**: the page has no authentication.
- **An external program** (ADR-0013), such as multimon-ng: installed on the box as a pack, as
  today. Opaque, and marked so.
- **A JS plugin** (ADR-0028): a decoder that runs in the browser on bytes or records. These stay
  importable from the UI, through an **Import plugin…** entry, since a phone cannot drop a file.
  **Keep on the box** is a second, explicit step that shares it with every tab.

**A `.grc` file is code, too.** GRC allows Python expressions in parameters and embedded Python
blocks. So a recipe imported through the UI is accepted only if every block in it is already
installed and every parameter is a literal or one of its own exposed parameters. Anything else is
installed on the box by file, like an OOT module.

## CW, the first recipe

CW is the case that started this: a narrow channel filter on the carrier, a product detector
whose oscillator puts the carrier at the pitch, and a band-pass around it, with multimon-ng on
MORSE_CW as an optional last step. Built from GNU Radio blocks as a hier block, with the carrier
offset derived by the existing estimator and the pitch exposed.

**As built (2026-10-07):** `recipes/cw.grc` is the hier block: a mixer that moves the carrier to
zero, `fir_filter_ccf` with `firdes.low_pass` (Hann, half the filter's width), a mixer up to the
pitch, the real part, a gain. `recipes/cw.recipe.json` is its sidecar: which node parameter fills
each block parameter, which the stream fills (the sample rate; the capture sample the first
input is, which the mixers reference their phase to so blocks join without a click), and the
variable naming how much history its filter needs. The worker compiles it with `grcc`, the same
compile GRC does, and runs it on the tuner. multimon-ng after it already starts on MORSE_CW.

Two things differ from the plan above, both on purpose:

- **The folded node keeps the op id `core.cw`.** It is the recipe's "a few knobs" step: offset
  (derived, with its evidence), pitch, filter width, gain. Keeping the id means every saved
  session loads and opens the same chain, with no translation table to maintain. The menu calls
  it "CW (Morse)".
- **The JS CW demod stays, as the recipe's mirror,** for the in-tab engine and as the fallback a
  missed block falls back to. Its filter is GNU Radio's design ported tap for tap, and
  `web/test/grcw.test.mjs` holds the two to the same taps and the same samples, so they cannot
  drift. It retires with the rest of the JS engine (ADR-0044), not before.

From a 20 kHz box, the width a finger draws on a 500 kHz spectrum, the signal-ID capture's Morse
went from no decode to a clean one; noise away from the pitch is 30 dB down.

## WBFM broadcast, the first chain (2026-10-07)

`recipes/wbfm.grc` is GNU Radio's `analog_wfm_rcv_pll` between an IQ input and left and right
outputs, with `widthHz` 240 kHz, `deviationHz` 75 kHz and `deemphasisUs` 75 as its parameters.
Picked from the menu over a drawn box, it builds a 240 kHz channel there, an FM demod and a
stereo decode given those settings, and Listen; every node carries the recipe, and its tabs
fold into one, "WBFM broadcast · 3 steps", which opens into the steps when tapped again. It is
ranked just after `Tune here` in the menu, ahead of any one demodulator.

## Consequences

- **The block ecosystem and GRC are both on-ramps,** in both directions.
- **Identify and a person build from the same recipes,** so the two paths cannot drift.
- **Recipes are only as good as the blocks they use.** A step that does not exist is a plugin
  first.
- **More nodes on screen** when a recipe is opened, which the "a few" step exists to avoid: folded
  is the default.

## Alternatives

- **A recipe format of our own** (the first draft of this ADR). Simpler to start and invisible to
  GRC, so every recipe would be ours to maintain alone.
- **Bundled node kinds like `core.cw`.** Rejected by ADR-0024.
- **Hier blocks as opaque subprocesses** (ADR-0032). Reuses GNU Radio and hides exactly what this
  tool exists to show.

## Would change our mind

- If most useful recipes need logic between blocks, they are programs, and the right shape is a
  block (a plugin), not a recipe.
- If GRC's format cannot carry what the sidecar needs without fighting it, the sidecar becomes the
  format and GRC an export.

## Settled with the decision

1. **On a phone, an opened recipe folds into one tab** with the recipe's name, opened like the
   folded path; its blocks are one tap away rather than a row of tabs.
2. **A saved recipe pins the versions of the OOT modules it uses**, as a pack pins the program
   it drives, so a recipe that worked keeps meaning the same thing.
3. **Only the operator overwrites a recipe on the box, by file**, for now. The page saves new
   recipes and never replaces one; that changes when the page has authentication.
