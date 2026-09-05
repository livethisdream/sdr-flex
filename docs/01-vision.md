# Vision

## The one-sentence version

Drag a box on a waterfall; get a flowgraph.

## The problem with the current field

Every existing tool sits at one of two poles.

**The appliance pole** (GQRX, most SDR receivers): a fixed pipeline with knobs.
The workflow is obvious and the first five minutes are delightful. Then you hit
the wall — there is exactly one demodulator, it produces exactly audio, and there
is nowhere to put your own code.

**The construction-kit pole** (GNU Radio, SDRangel): arbitrary capability, no
opinion about workflow. You must know the answer before you start. GRC will
happily let you build a QPSK receiver, but it will not help you notice that the
signal is QPSK. You bring the hypothesis; the tool tests it.

Signal analysis is *iterative narrowing*: look broadly, notice something, isolate
it, look again at higher resolution, form a hypothesis, test it, narrow further.
Neither pole supports that loop. The appliance can't narrow past step one; the
construction kit makes every narrowing step a rebuild.

## The bet

**The analysis tree is the user's model. The flowgraph is a compilation target.**

The user thinks: *"this piece of spectrum, during that burst, demodulated this
way, decoded that way."* That is a tree of narrowing operations. It maps cleanly
onto a DSP graph, but the tree is what the human holds in their head, so the tree
is what the UI shows.

The flowgraph still exists — it is real, it is GNU Radio, it can be exported to a
`.grc` and opened in GRC — but it is generated from the tree. See
[ADR-0002](adr/0002-selection-is-the-primitive.md).

## Design principles

1. **The first minute is the whole product.** Open a file or a dongle, see a
   waterfall, immediately. No project setup, no block palette, no sample-rate dialog.

2. **Narrowing is one gesture.** Drag a box in the time-frequency plane. That is
   the only structural gesture the tool requires you to learn. Everything else is
   picking from a list of things valid *right here*.

3. **The tool proposes, the user disposes.** From a selection the engine derives
   filter taps, decimation, and a sensible FFT size. All of it is overridable and
   none of it is required.

4. **Never show an invalid option.** Ports carry semantic types
   (`iq`, `real`, `symbols`, `bits`, `messages`). The palette at any node is filtered
   to operations that accept that node's output type. This is the anti-SDRangel
   decision — no wall of buttons, most of which don't apply.

5. **Every sample knows where it came from.** Center frequency, sample rate,
   absolute time of sample zero, and the full provenance chain travel with every
   stream. A bit you find four levels deep can be highlighted on the top-level
   waterfall. See [ADR-0007](adr/0007-stream-context-and-provenance.md).

6. **Live and recorded are the same thing.** A live source is recorded to a ring
   buffer, so you can always scrub backwards, re-zoom a burst, and re-run the
   chain over it. See [ADR-0005](adr/0005-all-sources-are-time-indexed.md).

7. **The GUI is a client.** Everything the GUI can do, a script can do, over the
   same API. That is how you get reproducibility, batch processing, and headless
   deployment for free — and how the GUI stays replaceable.

## Explicit non-goals (for v1)

- **Not a flowgraph editor.** We render the compiled graph read-only and export
  `.grc`. Two-way graph editing is a v2 conversation at the earliest — round-tripping
  a hand-edited graph back into the tree model is a research project, not a feature.
- **Not a transmitter.** Receive and analyze. TX is a different safety, latency, and
  regulatory surface. Design the plugin model so it isn't precluded; ship none of it.
- **Not a replacement for GRC.** If you know exactly what you're building, GRC is
  a fine tool. We are for the case where you don't know yet.
- **Not real-time-guaranteed.** Best-effort throughput with explicit drop semantics
  on the display path. Anything needing hard deadlines runs as a plugin in the worker.
