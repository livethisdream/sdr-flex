# One list, two kinds of row?

Serve the repository root and open `docs/mockups/menu/`. It borrows
`../../../web/style.css`, so it has to be served from somewhere that can see `web/`.

The gesture discriminator behind "one menu, three gestures" is settled: `openMenu(x, y,
selection)` already exists in `web/src/app.js`, already filters by stream type and by
whether a selection is present, and a third answer is a one-line change.

This toy is for the half that is *not* settled. View parameters are not operations —
every row in the catalog builds a node (`applyOp` → `addNode`), while a colormap sets a
value and rebuilds nothing — so one list holding both means two row types with two
handlers. The question is whether it still reads as one thing.

The rows are real: 22 operations transcribed from `web/src/engine.js` with their stream
types, and the view parameters from `app.js:1018` and `:1029`.

## What building it turned up

View parameters belong to the *view*, not the stream. `app.js` has exactly two
`this.view() === …` blocks: **Spectrum** carries seven parameters, **Time** carries two,
and Bits, Bytes, Events, Flow, Audio, Export and Grid carry none. So the mixed list
only ever occurs on two views, and the node menu never carries parameters at all. The
hard case is `real` on Spectrum, which is a nine-against-nine split.

## The drill

Four treatments, with order held constant so they differ only in how much the seam is
marked — and the fourth is the null, where the parameters are not merged at all but sit
behind one row that opens in place. The target pool is identical across treatments, and
opening that row costs a click the timer charges for; without both of those the medians
would not be comparable.

It measures *finding*, not understanding, and it is a fifteen-minute instrument rather
than a study.

This is an exploration, not a decision. Nothing here has an ADR behind it.
