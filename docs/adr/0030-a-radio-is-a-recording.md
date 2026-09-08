# ADR-0030: A radio is a recording; only its start moves

**Status:** Accepted — implements [ADR-0005](0005-all-sources-are-time-indexed.md), and
resolves its collision with [ADR-0029](0029-the-client-owns-the-clock.md)

## Decision

A live source is a process writing raw IQ into a **ring recording on disk**, which the
engine then reads exactly as it reads a file. Nothing below the source knows the
difference — the same `read(start, count)` over an absolute sample index, the same
frames, the same chains, the same auto-derived parameters.

Three things follow, and the third is the only genuinely new idea:

1. **A driver is a command, not a binding.** Each one is a row in a table: what program
   to run, how to pass it a frequency and a rate, what samples come out. `rtl_sdr`,
   `iio_readdev`, `uhd_rx_cfile`, `rx_sdr` — every SDR toolchain already ships a
   program that writes interleaved IQ to stdout. No native modules, no `npm install`,
   and adding a radio is a table entry rather than a port.
2. **Retuning restarts the recording.** None of those programs can be retuned in
   flight, so a new center frequency is a new medium. The readout follows the pointer
   immediately and the radio follows once it stops, because a scrub fires forty times
   on the way to a frequency.
3. **A source now has a span, not just a duration.** A file's history is permanent and
   its future does not exist. A ring's future does not exist *and its past expires*.
   So `span()` returns `[first, last]`, the client is told both on every frame reply,
   and the playhead is clamped into that window.

The asymmetry at the two edges is deliberate and not symmetric:

- **Past the head, reads return zeros.** That is the future, and a display asking for
  the window around "now" should get silence, exactly as it does at the end of a file.
- **Before the window, the ring throws.** Those samples existed and are gone.
  Returning zeros would draw a confident picture of a signal that was never like that.
  The radio above it clamps to the oldest surviving sample, because a display can lose
  that race by a few milliseconds honestly — but the storage layer refuses to guess.

## Why

**Why a ring at all.** This is ADR-0005's reasoning and it has not changed: GQRX is
live-only so you can never look at what just happened, URH is file-only so it cannot be
used at the antenna, and the split is an artifact of ingest rather than anything
inherent. Recording is what lets you scrub back into a burst that already passed, draw
a time box on a live signal, and re-run a modified chain over history without
recapturing. Drawing a time box in particular is *only* possible this way — selection
needs the display frozen, and a frozen stream is a still image with no history behind
it, while a frozen medium keeps every past sample addressable.

**Why processes rather than libraries.** The roadmap is explicit that the source
interface must be defined in our own terms rather than being SoapySDR's interface with
our names on it, because a layer you did not choose erodes into the layer you cannot
leave. A pipe costs nothing at these rates — 2.4 MS/s of cu8 is 4.8 MB/s on the same
machine — and it keeps the whole project at zero dependencies. When a pipe stops being
enough, the answer is another row in the table, not a different architecture.

**Why the client is told the window rather than computing it.** ADR-0029 gave the
client the clock, which works because a file's moments all exist. A ring's do not: real
time moves the floor, and nothing the client does causes it. Two numbers ride along on
every frame reply, thirty times a second, for free. It is the one piece of state the
client genuinely cannot derive.

**Why a synthetic driver is first-class.** The live path has behavior that only appears
after a while — the ring wrapping, a moment expiring under a scrub, a chain running
while its source moves. A generator paced to real time exercises all of it on a machine
with nothing plugged in, and lets anyone see what the tool does without owning an SDR.
It is paced rather than run flat out precisely because a source that fills a
sixty-second ring in half a second tests none of the timing.

## Costs

- **Disk or RAM for the ring.** Sixty seconds of 2.4 MS/s cu8 is 288 MB. It is
  allocated up front at full size, so it fails immediately rather than at 3 a.m. when
  the volume fills. `SDRFLEX_RINGS` points it at a real disk when `/tmp` is a tmpfs.
- **Retuning loses history**, and there is no way around it short of a driver that can
  retune in flight. Said out loud in the UI rather than hidden.
- **A ring is scratch.** It is deleted when the tab goes away. "Promote this ring to a
  permanent capture" is a feature this makes obvious and does not yet build.
- **Every driver but the synthetic one is untested against real hardware.** The command
  lines are written from the documented interfaces of programs that are not installed
  here. They are the part most likely to be wrong, and they are wrong in the cheapest
  possible way: a string in a table.
- **One radio per session.** Two tabs are two radios, and on one dongle the second
  fails with whatever the driver says about a busy device.

## What would change our minds

- **A driver that can retune without restarting** — `rx_sdr` with a control socket, or
  libiio used directly rather than through `iio_readdev`. That would make the frequency
  knob genuinely continuous and is worth a special case when it arrives.
- **Rates where a pipe stops keeping up.** Above roughly 20 MS/s the copy through
  stdout starts to matter and a shared-memory or direct-binding source earns its
  complexity. Handle it as another `kind`, not by abandoning the table.
- **Wanting to keep what you just heard.** The moment "promote the ring to a capture"
  exists, the ring stops being scratch and retention becomes a user-visible policy
  rather than an implementation detail.
