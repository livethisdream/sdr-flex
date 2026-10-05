# ADR-0044: GNU Radio is the engine; SDR Flex makes it visible

**Status:** Proposed — reaffirms [ADR-0003](0003-gnuradio-in-worker-processes.md), returns
the native engine to the role [ADR-0021](0021-mock-engine-first.md) gave it, and sets the
order for getting there

## Decision

**GNU Radio does the signal processing. SDR Flex is the layer that unifies it and makes it
visible.** The node graph a person builds compiles to a GNU Radio flowgraph running in a
worker process on the box. SDR Flex keeps only what makes that flowgraph usable and
transparent:

- the UI, the graph, and recipes (ADR-0043, to be rewritten so a recipe is a hier block);
- the stream between every pair of blocks, tapped, so every block has a view;
- the derived parameters and the evidence for them (ADR-0017), and `Identify` — the "none
  of the knobs" end of "all of the knobs or none";
- the decoder adapters (ADR-0013) and the decoder packs (ADR-0026);
- the time model: every source is a recording that can be scrubbed and re-run (ADR-0005,
  ADR-0030).

The native JavaScript DSP goes back to the job ADR-0021 gave it: the hosted demo, the
offline mode, and the deterministic fixture for the UI tests. It stops being the engine the
product runs on, and nothing new is added to it.

## How we got here

ADR-0003 settled this in the first week and is still accepted. It considered implementing
DSP natively and rejected it: that "throws away the block ecosystem that is the main reason
to build on GR at all." Then ADR-0021 built a small engine in the browser so the hosted demo
could run with no server, and when the server arrived it ran that same engine, as a shortcut
the project note recorded at the time: "the DSP core can move to Python or Rust later." It
never moved. Every capability since was added to it — the tuner, the demodulators, stereo,
the slicers, OFDM, DSSS — and the project ended up building the basics from the ground up,
which is the one thing it set out not to do.

## What the spike measured

On the GRCon26 signal-ID composite, broadcast FM slot, with GNU Radio 3.10.9.2 on the box
(`spike/gnuradio/RESULTS.md`, branch `gnuradio-engine`). The JS figures are the current
engine on the same slot.

| | GNU Radio | JS engine |
|---|---|---|
| 0.25 s block on demand, persistent worker, as the server sees it | 64 ms (IPC 2.2 ms) | 100-150 ms |
| One flowgraph streaming | 37x real time | about 2x |
| Retune a running chain, to the audio changing | 15-48 ms, one outlier at 220 ms | - |
| Insert a block into a running flowgraph | 9.5 ms | - |
| Worker start plus first block | 208 ms, once | - |

Throughput favors GNU Radio by a wide margin. Restructuring a running flowgraph, which the
roadmap named "the top technical risk in the design," cost 9.5 ms against a 260 ms budget.

**Quality, which is the stronger argument.** GNU Radio's stereo receiver separated a standard
stereo signal by 76 dB. The JS decoder separated it by -4.6 dB: it gives left = right on a
real station. Its tests passed because the test modulator made the same 90° error as the
decoder, and so did the CTF capture it was checked against. The reused block was correct and
the hand-written one was not.

## How it runs

**One worker per session**, as ADR-0003 has it: the server never imports GNU Radio, so one
bad block cannot take down every session. The worker stays up for the session, because
starting one costs about 200 ms.

**Two ways to run the same graph**, chosen by what is asked:

- **Streaming**, for a live radio and for playback: one running flowgraph, parameters changed
  in place (a retune is a setter, not a rebuild), blocks added or removed under lock.
- **On demand**, for everything about the past — scrubbing, a zoom into 40 ms that already
  happened, re-running a chain over a pinned span: the flowgraph runs over a block of samples
  from the recording, with a margin either side, the way the block cache does today. This is
  what keeps ADR-0005 true on top of an engine built to stream forward.

**Blocks with memory need a longer run-in.** A PLL, a clock recovery loop or an AGC has to lock
before its output means anything, and a 30 ms margin is too short for some of them. Each such
block declares how long it needs, and the on-demand run starts that much earlier.

**Every edge is tapped.** A view of a node reads the stream on that node's output edge, so a
hier block opened up shows each inner block's stream, and an OOT block is visible at its
edges. Inside a compiled block is as far as GNU Radio itself lets anybody see.

## What SDR Flex adds on top

The derived parameters stay SDR Flex's, because GNU Radio blocks take parameters and do not
derive them. The estimators read the tapped streams, set the block's parameters, and show
the evidence, so a person can still have none of the knobs. `Identify` builds speculative
flowgraphs from the same graph description a person builds by hand, so the two paths cannot
drift apart the way they did on the CW slot.

## Getting there

1. **Block by block.** Each JS operation is replaced by a GNU Radio block or hier block only
   after both are run on the same input and the GNU Radio output matches a known answer
   (ADR-0041: build both and measure).
2. **Known answers come from the standard, not from us.** A test signal built by our own
   modulator proves only that the decoder agrees with the modulator. Stereo is the example:
   both were wrong together.
3. **The broadcast chain first**: tuner, FM, stereo. It has the spike behind it and the
   quality case is already made.
4. **The live radio test comes after the engine moves**, not before, so the first real
   station is decoded by the engine we intend to keep.

## Latency, and where it really goes

Inside the box, the spike stays mostly within the 50 ms budget. **The larger cost is the
network to the person.** The Pixel 11 Pro Fold on home Wi-Fi over Tailscale measured 11, 76,
79, 143, 297 and 338 ms round trip, and that hop is outside any engine on the server, this
one or the old one. It gets its own decision: what the client can do without a round trip
(drawing, panning and zooming what it already has), and whether the phone's Wi-Fi power
saving is the cause.

## Consequences

- **The block ecosystem is reachable**, including OOT modules, as transparent nodes rather
  than opaque subprocesses.
- **Hier blocks become the recipe format** (ADR-0043, to be rewritten).
- **GNU Radio becomes a requirement on the box.** `Dockerfile.full` already carries it; the
  slim image can no longer run the engine. The hosted demo is unaffected, because it was
  always the JS engine.
- **Two engines exist for a while.** The parity tests (ADR-0029) become the test of the
  migration: for each operation, the GNU Radio engine against a known answer, and the JS engine
  kept only where it agrees.
- **Work that went into native DSP is not wasted where it is right.** The estimators, the views
  and the time model carry over. The DSP itself is retired as each block moves.

## Alternatives

- **Keep the JS engine and fix it.** No new process, works in the browser. It is the path that
  rebuilt the basics and shipped a stereo decoder that does not work on a real station, and it
  is what ADR-0003 rejected.
- **Wrap GNU Radio flowgraphs as opaque adapters only** (ADR-0032). Reuses GNU Radio, but every
  flowgraph is a black box, which is the opposite of the transparency this tool exists for.
- **The full ADR-0014 relay now** (Rust, shared memory). The right shape at scale, and more
  than the spike needed to show the case. It stays the target for the data plane, and the
  pipe is measured against it.

## Would change our mind

- If the on-demand runs cannot reproduce what streaming produces, so that scrubbing shows a
  different answer than playback, the time model wins and that operation stays native.
- If a block's run-in is too long for scrubbing to stay interactive.
- If the transport between the worker and the server, not the DSP, turns out to dominate.

## Open questions

1. Samples pass through Python in the spike (vector sink to stdout). ADR-0014 says the hot path
   never touches Python. Is a pipe from the worker acceptable as the first step, measured, with
   shared memory as the target?
2. Filter edges: each on-demand block came back about 10 ms short (11,976 frames instead of
   12,500), which contiguous playback has to absorb.
3. The 220 ms retune outlier is unexplained.
4. Which estimators read GNU Radio's taps directly, and which need a block of their own?
