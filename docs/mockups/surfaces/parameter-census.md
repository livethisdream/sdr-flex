# What is actually in the bottom bars

The proposal has been "the strip splits three ways and the bottom is left holding only
the transport." That was asserted from the seven Spectrum parameters, which are the ones
visible in a screenshot. Counting the rest changes it.

Counted off `web/src/app.js` — the node parameter meta table at ~915–990, and the two
`this.view() === …` blocks at 1003–1042.

## The census

| | num | enum | text | read-only | open-ended |
|---|---|---|---|---|---|
| **Node parameters** — what a block holds | 20 | 11 | **2** | `out` | a plugin's own knobs (`paramMeta`) |
| **View parameters** — Spectrum and Time | 5 | 6 | — | — | — |

The two text fields are `syncHex` and `code`, and the code says why each is typed rather
than picked: *"A sync word is typed, not slid to"*, and for a spreading code, *"there are
six hundred and seventy-odd codes in the catalog and a menu of them is not a menu."*

The open-ended column is the sharp one. An adapter's parameters arrive with the node,
because the client has no table of somebody else's decoder's knobs — and `shorten()`
exists precisely because an `rtl_433` flex spec is sixty characters and *"would be the
entire bar."*

## Where each kind lands

| kind | count | home | settled? |
|---|---|---|---|
| view enum — colormap, window, FFT size | 6 | the menu, on a bare click | yes, that is what the menu toy tests |
| view num with a natural increment — zoom, dB range | — | already on the object: wheel, color bar | already true |
| view num without one — averaging, speed | 5 | the menu | yes |
| node num, on a view that draws | ~20 | on the object — a threshold is a line on the waveform | **unbuilt** |
| node enum — CRC, bit order, polarity | 11 | the menu | yes |
| node text — sync word, spreading code | 2 | the summoned card | yes — `.poptext input` already exists for this |
| read-only — `out` | 1 | the summoned card | yes |
| a plugin's own knobs | open | the summoned card | yes, and it is better there than on a bar |

## What that does to the conclusion

**The strip can still die, and for a reason better than the one first given.** The two
cases that looked like they had no home — typed fields and a plugin's arbitrary knobs —
are the two the *bar was already failing*. `shorten()` is a bar truncating a value that
has to be read somewhere else anyway. A summoned card is a panel, it can hold an input,
and the app already styles one.

So the bottom is the transport and nothing else. But the claim now rests on the
**~20 node numeric parameters** finding a home on the object, and that is still the one
thing in this whole study that has been described and never built. On Spectrum and Time
there is something to draw them on. On Bits, Bytes and Events there is not, and those are
exactly the views whose nodes carry the slicer and framer knobs.

That is the next thing to build, and it is not a layout question any more — it is
whether a slicer threshold can be a line you drag on the waveform that produced it.
