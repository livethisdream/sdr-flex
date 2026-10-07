# ADR-0013: External decoders are first-class subprocess plugins

**Status:** Accepted — implemented for `rtl_433`, `multimon-ng`, `dump1090` and
`direwolf` in `server/adapters.js`; see the note at the end for what the implementation
settled that this record left open

## Decision

`process` is a first-class plugin implementation kind, a peer of `gr_hier` — not an
escape hatch. A manifest declares a command line, the sample format and rate the
program wants on stdin, and how to parse its stdout. The engine derives the
conversion and resampling chain automatically.

Nodes backed by an external process are marked **opaque**: no drill-down, approximate
provenance, visibly distinct in the UI.

## Why

The largest body of proven decoding in this field ships as standalone Unix programs
that already agreed on an interface — samples in, records out. `rtl_433` alone is
250+ ISM protocols. `multimon-ng` is ~15. `dump1090` is ADS-B. `direwolf` is APRS.
`dsd` is four digital voice modes. Each is roughly 20 lines of manifest.

Writing those natively is years of work and would be worse, because these
implementations have absorbed a decade of real-world signal weirdness.

The subprocess boundary also buys two things we would otherwise pay for separately:

- **Isolation** — a segfaulting decoder kills a pipe, not a session (ADR-0003 one
  level down).
- **License separation** — arms-length aggregation rather than derivative linking
  (ADR-0015).

Three benefits, one mechanism, one pipe copy. Every external decoder sits after heavy
decimation (audio rate to a few hundred kS/s), so the copy is single-digit MB/s.

## Cost

- **Opacity.** You cannot see inside `rtl_433`, adjust its slicer, or annotate an
  intermediate stage. This is the exact opposite of URH's value proposition.
- Provenance can only be approximate — `t0` plus an estimated pipeline latency
  (ADR-0007 already admits `approximate`).
- Process supervision, restart policy, zombie reaping, and surfacing a non-zero exit
  code as a legible node error are all now our problem.
- Version drift: a user's `rtl_433` may not match the manifest's assumptions.
  Manifests declare a version constraint and the Plugins panel reports mismatches.

## The resolution, not a compromise

We ship **both paths and label the difference**:

- **External processes for breadth.** Get to a decoded result in one click, across
  enormous protocol coverage.
- **Native/GR chains for depth.** Every stage a node, every parameter adjustable,
  exact provenance — for when you need to *understand* the decode, or when nothing
  exists yet.

"Try `rtl_433` first; build the chain yourself if it doesn't recognize the signal" is
the workflow an analyst actually wants. Offering only the transparent path is URH's
narrowness; offering only the opaque path is a launcher, not an analysis tool.

## Would change our mind

If opaque nodes turn out to confuse users about what the tool can do, the answer is
better UI marking, not removing the capability.

---

## What the implementation settled

Written before there was a server. Building it changed three things worth recording.

**The pipe is simpler than the manifest imagined.** Every one of these programs reads
raw samples from stdin given a format token, and `rtl_433` in particular parses its
input format out of the *filename or pipe spec* — `-r cu8:-`. There is no negotiation
protocol to speak of: the adapter states what the program wants, the engine converts and
resamples to it, and both steps are reported because both change what the decoder sees.
"Why does rtl_433 find nothing here and everything in the same signal saved to a file"
is otherwise a bad afternoon.

**Adapters ship with the tool and are not user-supplied.** This ADR did not say either
way. It has to: an adapter is a command line, so a droppable one is arbitrary code
execution as the server, at the invitation of anything that can reach the port. That is
the same line [ADR-0029](0029-the-client-owns-the-clock.md) drew when it kept dropped
plugins running in the browser. A table in the repository, like the radio drivers.

**Opacity is a flag on the node, not a separate kind of node.** `opaque` is set when the
work happens in somebody else's program, and the tab is drawn differently for it. That
is the whole treatment, and it is enough — the thing a person needs to know is that
there is nothing to drill into, not that a different subsystem produced it.

Two costs this record predicted turned out to be real and are worth confirming: a
decoder's stderr is where it says the useful things, so it needs surfacing when nothing
came back and suppressing when something did; and version drift is live from day one —
the same fixture pins *what this version actually does*, including packet grouping we
would not have guessed.

## Decoders that stream (2026-10-07)

A decoder is run two ways, and it says which it can take.

**As a job**, as above: a span goes in, stdin closes, records come back. Identify, and a
decode of the whole capture while paused, run this way, and every decoder can.

**As a stream**, for a decoder that declares `stream: true`: while the capture plays, the
session keeps one process running per decoder node and feeds it up to the playhead
(`decodeTo`), so it sees one unbroken run of samples. Fed in five-second jobs instead, a decode
was cut wherever a job ended: on the signal-ID capture every fifth second lost a Morse
character, and the flag never read cleanly. A run starts two seconds before the playhead and
starts again after a seek, a jump it cannot feed, or a change to the decoder or anything above
it. Records are stamped with the moment of the capture that had just been fed; a line the
program is still printing is shown as it arrives, and one that never ends (MORSE_CW prints one
for as long as there is Morse) is broken at a space into records. multimon-ng streams; the
others stay jobs until each is checked, and whisper and HD Radio stay jobs for good, because
they need the whole recording before they answer.

**The input is made by GNU Radio either way** (ADR-0044): `server/gr/feed.py` resamples
(rational where the ratio allows it, polyphase otherwise), levels and converts to the format
the program asked for, and for a stream it is piped straight into the program's stdin, so the
resampler's state runs from one feed into the next. The JS resampler is no longer on any
decoder's path. A decoder that is itself a GNU Radio flowgraph (LoRa) will take the same
blocks at its own front, in the worker, rather than through a second process.
