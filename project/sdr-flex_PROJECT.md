# SDR Flex — project note

Where the build actually is, what has been decided in conversation but not yet written
into an ADR, and what is still open. `docs/adr/` records *why* each decision was made
and `docs/06-roadmap.md` records the plan as designed. Neither survives the gap between
one working session and the next, which is what this file is for.

Lives at `project/<repo-name>_PROJECT.md` by convention — same path in every repo, so
it is the first file to read and does not have to be found.

Update it at the end of a session, not the start of the next one.

**Last updated:** 2026-09-11 (decoders checked for real, `Identify`, GNU Radio, local adapters, M17) · branch `claude/sdr-flex-toolkit-planning-c4ghl1`

---

## Where it is

MVP in the browser, the same tool with its engine in a container, and live radio into a
ring recording. Static ES modules, no build step, no dependencies on either side.
32 ADRs.

Run it on a box: see `server/README.md`. Short version, on a tailnet:
`SDRFLEX_HOST_IP=$(tailscale ip -4) docker compose up -d`.

Working end to end:

- Spectrum and waterfall with a resizable split; selection-driven flowgraph
- Tuner / filter / time-constraint blocks; channels lettered, blocks not
- FM, AM, SSB, CW demodulation, each showing the evidence for its auto parameters
- PWM/OOK and NRZ slicers; bytes and events stream types
- Audio as a flow block, not a transport button (ADR-0027)
- Capture open by drag-drop: cf32 / cs16 / cu8 / cs8, SigMF sidecar
- Export: WAV at a decoder's rate, or cf32 with a SigMF sidecar
- Plugin framework: drop a `.js` file, it registers against a stream type (ADR-0028)
- Dark / light / auto theme
- Command palette with `/` search
- Transport loops at the end of a capture by default, which a pinned clip always did
- Wave 2 decoding: a Manchester slicer that derives its own symbol rate, differential
  (NRZ-M/S), and a framer that finds frames at any bit offset and identifies the CRC by
  trying the catalog against them
- The engine over a WebSocket, in a container, reading captures off the box's disk —
  the page picks the server engine when one answers and the in-tab engine otherwise
- Live radio: a capture program writes a ring recording, the engine reads it exactly as
  it reads a file, and you can scrub back into what already went past
- Seven external decoders — rtl_433, multimon-ng, dump1090, direwolf, minimodem, M17, and
  LoRa as a GNU Radio flowgraph — each checked against the real program, not its docs
- `Identify`: one button runs every decoder that could read this stream and says what
  each found, what it declined to try, and what it decoded but refuses to count
- Decoders you add yourself: a directory of manifests in `SDRFLEX_ADAPTERS`, badged
  "yours" in the menu — `docs/10-adding-a-decoder.md` is the contract

Tests: 190 Node tests across `web/test/*.test.mjs` for pure logic, the wire format, the
socket, mock-versus-server parity, and every external decoder against the real program;
plus Playwright suites driving the real DOM. Headless `requestAnimationFrame` is unreliable, so the
browser suites step `app._frame(t)` by hand through `window.sdrflex`.

## Validated against the CTF captures

All seven open. Largest is 360 MB / 104 s / 2 MS/s: 5.5 s to load, 386 MB heap,
0.6 ms/frame p95. Four slots exported and decoded by the author's own decoders.
One challenge ran end to end inside the tool — the NRZ slicer derived the symbol
period from the capture (100% agreement across 6,153 runs) and a dropped-in plugin
returned all superimposed messages in 9 ms.

This is the near-term goal: a playtest toolset that replaces stringing together half
a dozen tools, evolving into a real analysis tool. Not a tool players are asked to use.

---

## The container, as built

All of this is now in the tree and tested; it is written up as
[ADR-0029](../docs/adr/0029-the-client-owns-the-clock.md).

- **Node, not Python.** `engine.js`, `dsp.js` and `capture.js` turned out to be pure —
  no DOM, no browser API — so they run in Node unchanged and the night went into the
  transport contract rather than re-deriving FFTs. The DSP core can move to Python or
  Rust later; the contract is the durable part. `MockEngine` is now the wrong name for
  what the server runs, and renaming it is the moment that happens.
- **The client owns the clock.** The server keeps no playhead; every read carries the
  moment it wants. That is what makes a reconnect lose pixels and nothing else, and it
  is also what makes the parity test possible.
- **The graph is mirrored, not queried**, so the synchronous accessors the paint path
  needs stay synchronous. Every mutating call returns a whole snapshot.
- **`frame` returns the latest answer**, or `{kind:'pending'}` before the first arrives.
  Live views run one round trip behind; the waterfall states its whole prefill plan up
  front and gets 260 rows in five round trips instead of 260.
- **No dependencies, either side.** The WebSocket server is ~150 lines of RFC 6455
  rather than `ws`, so the image is a Node base plus this repo and installs nothing.
- **Plugins stayed in the tab**, as planned. On the server they would be arbitrary code
  running as the server against every capture on the box.
- **Captures stay on the box**: the library is a directory scan, the client names a
  capture by id, and a path outside the directory is refused. Dropping a capture file
  on a remote engine says so and opens the library instead.
- **Bind answers on loopback and the tailnet**, never the LAN and never every
  interface. Binding to *only* the tailnet was the first attempt and locked the server
  out of its own machine — under WSL, with Tailscale inside the distro and the browser
  on Windows, that is the normal arrangement rather than a corner case. The compose
  port publish is still scoped to one host address so forgetting to set it fails closed.

Numbers, measured on loopback:

| | |
|---|---|
| One frame, request to reply | 0.67 ms median (0.35 ms in-process) |
| 64 frames in one batch | 0.36 ms per frame, 256 KB |
| A 260-row waterfall prefill | ~90 ms, five round trips |
| A 256 MB capture, resident | 18 MB — and flat, it does not track file size |

## Hardware, as built

[ADR-0030](../docs/adr/0030-a-radio-is-a-recording.md). A radio is a process writing raw
IQ into a ring on disk; everything below the source reads it as a file, so chains,
detectors, pinned clips and auto-derived parameters all work on live signal unchanged.

- **A driver is a row in a table** — what program to run, how to pass a frequency and a
  rate, what samples come out. RTL-SDR, Pluto, UHD and SoapySDR are four rows. No
  bindings, no native modules, still zero dependencies.
- **A synthetic driver is first-class**: the same scene the in-tab engine draws, at a
  real rate in real time. It is how the live path was tested here, and it is how anyone
  without an SDR can see the tool work.
- **Only the synthetic driver has run.** The RTL-SDR and Pluto command lines have since
  been checked against the real `rtl_sdr`, `iio_attr` and `iio_readdev` binaries — they
  parse and reach the point of looking for hardware — but no radio has been attached.
  Known suspect: the Pluto's channels are commonly 12 bits in a 16-bit word, and this
  reads them as `cs16`, so a real signal about 24 dB quiet means a scale factor is
  needed.
- **A radio needs `Dockerfile.radio`**, not the default image — the default has none of
  the vendor capture programs in it. `SDRFLEX_DOCKERFILE=Dockerfile.radio docker
  compose up -d --build`.
- **A source has a span now, not just a duration.** A ring's past expires, so
  `span()` is `[first, last]`, it rides along on every frame reply, and the playhead is
  clamped into it. Past the head reads return zeros; before the window the ring throws
  rather than inventing silence.
- **Retuning restarts the recording**, because none of these programs retune in flight.
  The readout follows the pointer, the radio follows when it stops.
- **The ring is scratch** — sized up front, deleted with the tab. `SDRFLEX_RINGS` points
  it at a real disk when `/tmp` is a tmpfs.

## Wave 2, as built

- **Manchester** derives its symbol period from the one thing a transition-per-symbol
  line code cannot hide: runs come in exactly two lengths and never a third. It reports
  violations, which is how a wrong rate announces itself.
- **Polarity is not derivable** and is not pretended to be — the two conventions are
  exact inverses, so nothing in the signal distinguishes them. A sync word does, and
  the honest workflow is to try both and see which one finds it.
- **The framer searches bit by bit.** Nothing makes a second packet start a whole
  number of bytes after the first, so a byte-aligned search finds one frame in a
  capture full of them.
- **The CRC is derived, not configured.** Nine variants, both byte orders, against
  every frame; an answer only counts if it validates all of them. Where frames are
  separated by dead air it also works out where each one ends — shortest-wins, because
  most of these CRCs check out as zero once the remainder is appended, so a frame
  trailed by nulls validates at its true length and every pair beyond it.
- **Length search is refused below 16 bits.** Forty trials against an 8-bit CRC finds
  one in almost anything.

## The Pluto, natively

The driver speaks iiod over TCP rather than shelling out to libiio's tools, so a Pluto
needs **nothing installed** — not libiio, not `Dockerfile.radio`, not a Windows
installer. It is not a USB device to claim; it is a USB-ethernet gadget on
`192.168.2.1` with `iiod` on port 30431, and the driver is a socket.

- **It retunes without restarting**, which no other driver here does. A frequency is an
  attribute write, so the stream keeps running and the ring keeps its history. Every
  process-based driver loses a second of air and everything recorded.
- **Two connections, not one.** A `READBUF` blocks on the server until the buffer fills,
  so a control command down the same socket has its reply eaten by the read already
  waiting. The symptom was a retune reporting an unintelligible answer and a session
  that never recovered. The stream gets one link and everything else the other.
- **The sample format is read off the device, not assumed.** A Pluto declares
  `le:S12/16>>0` — twelve significant bits in a sixteen-bit word — so full scale is
  2048. Reading it as `cs16` fails silently by making every signal 24 dB quiet, which
  looks exactly like a gain problem. There is now a `cs12` format and the driver picks
  it from what the board says.
- **`SDRFLEX_PLUTO_HOST`** points it somewhere other than the default address.
- The process-based driver stays as a second entry for a board in pure USB mode.

**How it was tested, since there is no Pluto here.** The protocol was read off the wire
between libiio's own client and a real `iiod`, not written from memory — which is how
the two framing details that would otherwise be wrong were found: a value reply ends
with a newline after its payload and a `READBUF` reply does not. Then a mock iiod was
built and **validated by libiio's own tools** — `iio_info`, `iio_attr` and `iio_readdev`
all drive it successfully — and only then used to test our client. A mock of a protocol
written from memory tests the memory.

Still unverified against a real board: whether an actual Pluto agrees with all of it.
The first one plugged in is the test.

## Third-party decoders, as built

M4.5, and the roadmap was right that it is the best ratio in the plan.

- **An adapter is a table row** in `server/adapters.js`: what to run, what samples it
  wants on stdin, how to read its output. `rtl_433`, `multimon-ng`, `dump1090`,
  `direwolf`, `minimodem` — five rows.
- **Format negotiation is derived and reported.** The engine resamples and converts the
  span to what the program wants, and the record pane says which, because it changes
  what the decoder sees.
- **These nodes are opaque** (ADR-0013) and the tab is drawn differently for it.
- **Adapters ship with the tool, not dropped in** — an adapter is a command line, so a
  droppable one is code execution on the box. Same line ADR-0029 drew for plugins.

### Every adapter is now checked against the real program

The first four rows were written from documentation. Every one of them was wrong, and
every one of them was wrong in a way that produces *silence* rather than an error —
which is the worst possible failure for a decoder, because silence is also what a
signal it does not recognize looks like:

- `dump1090` is installed as `dump1090-mutability` on Debian and `dump1090-fa` from
  FlightAware. Naming only the upstream binary meant the adapter reported "not
  installed" on every machine that actually had it. `command` is now a list of
  candidates and the menu names whichever one is there.
- `--quiet` on dump1090 does not suppress the banner, it suppresses **stdout** — where
  `--raw` puts the decodes. The shipped arguments asked for output and then turned it off.
- `-` is not stdin to direwolf; getopt eats it and the program is left with no file
  argument at all. The word is `stdin`.
- direwolf opens a sound card unless a config file says otherwise, and exits with
  "Pointless to continue without audio device" on anything headless — which is every
  machine this runs on. The adapter now writes a per-run config (`ADEVICE stdin null`,
  and `AGWPORT 0` / `KISSPORT 0` so a decode does not start listening on 8000 and 8001).
- `-q hd` on direwolf suppresses exactly the decoded lines we run it for.
- multimon-ng prints an AX.25 packet as two lines — a header and then the payload —
  so reading it as plain lines produced one record with no message and one with no sender.

`minimodem` is new, and it is the most CTF-relevant of the five: RTTY, Bell 103/202, and
any N-baud FSK with an arbitrary tone pair. It reads through libsndfile, which refuses
headerless samples on a pipe ("Format not recognised" — its words), so `convert()` grew a `container`
option that puts a WAV header in front. The header can carry a truthful length rather
than the streaming fiction of `0xffffffff`, because the whole span is in hand before the
program starts.

**How they are checked.** `web/test/support/modulate.mjs` holds modulators that are the
*inverse* of the decoders they feed: AX.25 with HDLC bit stuffing, NRZI and a CRC-16/X.25
frame check; Bell 202 as an async serial line; Mode S pulse-position with a correct
24-bit parity; DTMF; Morse. `web/test/adapters.test.mjs` builds a signal, runs the
adapter's own `run()` on it, and asserts the text comes back. The check is two-sided: if
a modulator drifts, the real program stops agreeing with it and says so. A program that
is not installed is skipped, loudly.

Nothing here is a protocol implementation for the tool to use. It exists so the adapters
can be *tested* rather than assumed.

**The conformance harness is in** (ADR-0025), and it covers native and external chains
alike: `fixtures/<name>/` holds a capture, a `fixture.json` saying what it must produce
and which parameters must be *derived*, and a README with license and provenance. All
captures are synthesized by `fixtures/make.mjs` from fixed seeds — CC0, byte-identical
on regeneration, no question about who transmitted them. A fixture whose program is not
installed skips rather than fails.

Four fixtures now: `rtl433-ook-pwm`, `manchester-crc`, `aprs-afsk1200` (AX.25 over FM —
spectrum, tuner, discriminator, direwolf, so it fails if the tuner or the decimator
regresses) and `adsb-modes` (Mode S straight off the root with no tuner at all, 3 kB).
`needs` in a `fixture.json` now names an *adapter* rather than a binary, since a binary
is not one name.

### The bug the APRS fixture found

Worth recording, because nothing else would have found it and it was silently eating
packets.

`readSpan` walks a capture in 65536-sample chunks so the frame loop can breathe between
them, and each chunk is an independent read that ends at its own moment. A tuner asks
its parent for the filter's length of extra samples ahead of every read, so the *first*
read of any capture reaches back past sample zero — and the source clamped that to zero
rather than padding the front. A clamped read ends *late* by however much was clamped.
So chunk one was shifted and every later chunk was not, and the seam between them
repeated the filter's length in samples.

Sixty-five samples is 0.68 ms: nothing to look at, and most of a symbol at 1200 baud.
The APRS fixture has two frames in it and the graph decoded exactly the one that did not
sit on top of a chunk boundary. No error anywhere, because as far as any single read
knew, nothing had gone wrong. At 96 kS/s a boundary falls every 0.68 s; at 250 kS/s,
every 0.26 s. Any decode of a capture longer than that was affected.

Fixed in `_readIQ`: before the beginning is silence, the same way past the end already
was. `web/test/span.test.mjs` is the regression — a tone whose phase advance is constant,
so a repeat or a gap is a measurable step rather than something to eyeball. Reverting the
fix fails three of its four tests.

## `Identify`, as built

ADR-0031. One button next to the `+` on the tab strip, on any node carrying IQ or audio.
Runs every decoder that could read the stream, eight seconds ending at the playhead (or
the pinned clip), rows filling in as each finishes. Clicking a row that found something
builds the chain — demodulator, then decoder, with the settings that produced the result
— and lands on its records. An audio decoder on IQ is tried behind an FM demod *and* an
AM one, because which is right is the question.

The running of decoders was the easy half. Everything that took work was about the
report being honest, and the first version of it was not:

- **What was not tried is in the report**, with the reason. Not installed, wrong kind of
  stream, or wanting more bandwidth than the capture ever had (`dump1090` wants 2.4 MS/s;
  Mode S is a megabit and cannot be hiding in 96 kHz).
- **An adapter says what "try everything" means for it** — a `sweep` field. multimon-ng
  defaults to three POCSAG rates because a default should be cheap; asked to identify, it
  wants its whole `-a` list. Running with no parameters at all, which is what the first
  version did, quietly asked every decoder for its least capable configuration and then
  reported that AX.25 was not AX.25.
- **A decode with almost nothing in it is not a decode.** multimon-ng's Morse demodulator
  reads a noise blip in an OOK capture as `E`. minimodem locks onto real APRS audio and
  hands back bytes at confidence 3.8 against 4.9 for a genuine Bell 202 decode — so
  confidence does not separate them, and what does is that one is text. Both are shown,
  neither counted, each says why.
- **The window is bounded and stated**, because "nothing in these eight seconds" and
  "nothing in this capture" are different claims.

Cost: 1.8 s for eight seconds at 250 kS/s, 4.8 s at 2.4 MS/s, first row back in about
half that. The [budget](../docs/08-ui-principles.md) asks 3 s; channel rates meet it and
dongle rate does not, and the measured number is in the table rather than the target.

Driven in a real browser against the real server before it was called done — one click,
progressive rows, click through to a built chain, on four fixtures, both themes and at
phone width.

### The bug chasing that cost found

Worth recording twice over, because it was two layers below anything Identify touches and
it was silently wrong in the field.

`resample()` scaled its cutoff with the ratio and did not scale the kernel's width. So
2.4 MS/s → 250 kS/s — which is exactly what `rtl_433` gets handed off a dongle-rate
capture — built a sinc stretched nine and a half times and then truncated it after three
zero crossings. That is not a low-pass filter. A 200 kHz tone came back at 50 kHz down
only 31 dB: **everything the radio heard between about 125 and 250 kHz was folding into
the band the decoder was reading**, and nothing said so.

Fixed by making the support stretch with the cutoff and precomputing the kernel on a grid
of fractional offsets — which also made it four times faster, since the old one was
evaluating three transcendentals per tap per output. `Identify` over eight seconds at
2.4 MS/s went 17 s → 4.8 s on the back of it.

This may well be the real answer to "if i just pick rtl433 from the spectrum view, i get
no decodes", which was put down to the flex spec at the time.

## GNU Radio, as built

ADR-0032. **A flowgraph is a program**, so it is an adapter: samples in on stdin, records
out on stdout, the same contract rtl_433 already satisfies. That needed one new idea and
two small ones.

- **`module`** — for every other adapter "is it installed" is a name on PATH. For a
  flowgraph the command is an interpreter, which is always there, and what has to exist
  is a module inside it. `available()` asks the interpreter to import it. Without that the
  palette offers a decoder that cannot run.
- **The interpreter is a candidate list**, like a binary is. GNU Radio builds its bindings
  against one CPython and this box has five: the bindings are for 3.12, `python3` is 3.11,
  and `python3 flowgraph.py` fails with ModuleNotFoundError.
- **`wants` may be a function of the parameters.** LoRa is sampled at a whole multiple of
  its bandwidth, so the bandwidth decides what the decoder is fed. A static `wants`
  starved every setting but the default.

Flowgraphs are written by hand in `server/flowgraphs/`, not exported from GNU Radio
Companion — a `.grc` export carries a GUI, a throttle and a live sample-rate variable,
none of which belong in a job that reads a span and exits. They print one JSON object per
record, which the `jsonl` parser already reads.

**Measured, in this container:**

- GNU Radio 3.10.9.2 installs from the Ubuntu archive. No source build.
- `gr-lora_sdr` clones, builds, installs and imports in about four minutes, first try.
- A flowgraph reading 200k samples off the pipe: 0.18 s, no X11, no temp file.
- LoRa over the fixture through the adapter: 9 frames in 240 ms. `Identify` ranks it
  first in 874 ms.

`fixtures/lora-sf7` is generated by gr-lora_sdr's own transmitter rather than by
`make.mjs` — a LoRa frame is CSS wrapped in whitening, Hamming, interleaving, a Gray map,
a header and a CRC, and writing that in JavaScript would mostly test our reimplementation
of LoRa. Two-sided instead: if either half drifts the other stops agreeing. It regenerates
byte-identically (checked), it is 176 kB, and the control is that the same capture read at
SF9 returns nothing.

### gr-tempest: builds fine, is not a decoder

Worth writing down because it changes how TEMPEST gets done. `gr-tempest` clones and
builds clean against the same GNU Radio. Its blocks import and its chain produces framed
output with correct line structure — the 800-of-1024 visible region is clearly distinct
from the blanking. But **no picture came out**, and chasing it found the reason:

- `normalize_flow` diverges to ±1e34 on short runs; `fine_sampling_synchronization`
  returns NaN on a clean signal.
- More to the point, its examples expose **five to seven live operator knobs** —
  `harmonic`, `epsilon_channel`, `horizontal_offset`, `lines_offset`, `inverted` — that a
  person turns until the picture locks. Even the "automatic" example keeps five.

gr-tempest is an interactive instrument, not a run-once decoder. It fits the adapter shape
only if those knobs become adapter parameters — which the parameter strip can already
draw, and which would make this tool the GUI gr-tempest is missing. Not done. The
alternative is the native raster fold, which was tried far enough to show structure and
not a picture.

## M17, as built

The third adapter shape, and the one that forced a change to the contract.

`m17-cxx-demod` builds in a couple of minutes from source — not packaged anywhere, but
it needs only libcodec2 and boost. It is a plain CLI, so no GNU Radio involved. M17 is
4FSK on the **discriminator output** rather than on IQ, so it goes after an FM demod, the
way direwolf does. The record is the link setup frame: source and destination callsigns,
stream type, channel access number, CRC.

**The contract change:** `m17-demod` writes decoded *voice* to stdout and its records to
**stderr**. Every other adapter is the other way around. So a row may now say
`recordsOn: 'stderr'`, and the engine stops accumulating stdout — it counts the bytes and
hands the count to the parser. That is not tidiness: a few seconds of 8 kHz audio coerced
into a JavaScript string is wrong, and on a long capture it is a way to run the server out
of memory.

**The gap this exposes, stated rather than hidden:** the voice is real and the node does
not carry it. The record says how many seconds there were, which is better than dropping
it silently, but carrying decoded audio back into the graph is a real missing feature and
not a small one. An adapter produces records today.

`fixtures/m17-lsf` is `m17-mod`'s own output, FM-modulated — same reasoning as LoRa, since
the alternative is implementing M17's convolutional coding, interleaving, scrambling and
Golay-protected link setup in JavaScript to test somebody else's M17 decoder. The vocoder
input is a tone pattern, not speech: ADR-0025 exists to keep recordings of people out of
the repository. Controls: noise decodes to nothing without erroring, and the chain runs
spectrum → tuner → discriminator → decoder, so it fails the way a user would see it.

`Identify` finds it behind the FM demod and ranks it first, in 862 ms.

## Local adapters, as built

ADR-0026, which had been Proposed since the beginning and deferred "until three adapters
exist to generalize from". Six existed, so the condition was met — and the format came out
*smaller* than the sketch, because the six had already answered the open questions instead
of leaving them open.

`SDRFLEX_ADAPTERS` names a directory; one subdirectory per decoder, each holding
`adapter.json` (or `adapter.mjs` when it needs functions), optionally a flowgraph and a
golden capture. Read at startup, reported at startup, one bad pack does not take the
others with it. Badged **yours** rather than **ext** in the menu, and a local adapter
cannot take an id that ships with the tool.

Every field in the format was demanded by a real adapter rather than imagined: several
candidate binary names (dump1090), a module inside an interpreter (any flowgraph), a
container in front of the samples (minimodem), a config file written per run (direwolf),
a rate that follows a parameter (LoRa), and a flag omitted along with its value (rtl_433's
`-R`, where "no protocol" is not "all protocols").

Two things the ADR expected did **not** survive:

- **The transport field.** It was expected because direwolf was supposed to need KISS over
  TCP. It does not — it reads stdin and writes stdout like everything else, once it is
  given a config file. No transport field, and none until something needs one.
- **The version pin.** Checking one means parsing `--version` for six programs that each
  format it differently, to produce a warning nobody can act on, since the user has
  whatever their distribution gave them. The conformance fixture in the pack replaces it:
  it answers whether *this* version of *this* program still produces the expected records,
  which is what a version pin was a proxy for.

**The trust line, unchanged where it matters.** An adapter is a command line, so anything
that can write to that directory can run programs on the box — the loader refuses a
world-writable one, and that is the control. It is a directory on the box and *not* a drop
target in the browser; dropped code still runs in the tab and never on the server
(ADR-0029). The capture and plugin directories already sat at exactly this trust level.

Verified end to end: a pack wrapping minimodem at Baudot RTTY 45.45 decoded a signal built
by our own FSK modulator, through the real server, and showed up badged "yours" in a real
browser.

Also this pass: American spelling fixed throughout, including in files that predate the
house rule.

## Wanted later

- **The CTF's remaining modulations.** The 2026 challenge list is NBFM, WBFM, USB/LSB, CW,
  FHSS, OFDM, FSK, M17, AFSK1200, APRS, ADS-B, BBC (gr-bbc), the AOL handshake, CDMA,
  FLEX/POCSAG, LoRa and TEMPEST (gr-tempest). Covered and verified: AFSK1200/APRS, ADS-B,
  FLEX/POCSAG, CW, FSK, LoRa, M17. Have a node but never tested against a real signal of that
  kind: NBFM, USB/LSB, WBFM — and WBFM has no de-emphasis, so broadcast audio will sound
  wrong. Nothing at all: BBC, TEMPEST, CDMA, OFDM, FHSS, the AOL handshake.
- **Fold a signal into a grid.** FHSS (time × channel), OFDM (symbol × subcarrier) and
  TEMPEST (line × frame) are one operation: estimate a period, fold at it, render. The
  period auto-derived, showing its evidence (ADR-0017). FHSS then needs de-hopping —
  follow the hop list, retune per hop, concatenate — and the existing demod and slicer
  chain decodes the payload, so the hop sequence and the bits come out of one capability.
  What the author wants from each: FHSS the sequence *and* the bits, OFDM a time/frequency
  grid used as a battleship board, TEMPEST the image, CDMA the bits.
- **An adapter cannot hand audio back to the graph.** M17 decodes voice and the node
  throws it away, saying how much there was. Every decoder that produces audio rather than
  records — M17, and anything vocoded — is half-connected until this exists. It wants an
  adapter whose `out` is `real` or `audio`, samples read back off stdout, and a rate
  declared the way `wants` declares the input rate.
- **CDMA is unscoped.** Despreading needs the PN code. If it is a standard m-sequence or
  Gold code it can be searched the way the framer searches the CRC catalog; if it is
  arbitrary, that is a different problem. Waiting on how the challenge is generated.

- **SoapySDR, for the long tail of hardware.** The `rx_sdr` process driver already
  covers whatever SoapySDR knows about, so this is not a coverage gap — it is the same
  question the Pluto answered, one level up, and the answer is probably different.
  SoapySDR is a C++ plugin host with no wire protocol, so "native" there would mean a
  binding rather than a socket, and a binding is exactly the dependency this project
  keeps declining. The likely shape: native drivers where a board has a protocol worth
  speaking (anything AD936x now is), and `rx_sdr` for everything else. Worth revisiting
  when a board turns up that `rx_sdr` handles badly.

## Open, needs a decision

- **No real radio has ever been attached.** The first one plugged into the box is the
  real test of the driver table.
- **For a Pluto on a Windows machine, the shortest path is running the server on
  Windows** — the Pluto is a network device on `192.168.2.1`, and Windows is already
  the machine that can reach it. WSL sits behind its own NAT and needs a port forward
  (or usbipd) first; mirrored networking also works but changes networking for every
  distro on the machine and is not worth reaching for. Written up in
  `server/README.md`.
- **The image has never been built.** There is no Docker daemon in the environment this
  was written in, so `Dockerfile`, `Dockerfile.radio`, `Dockerfile.decoders` and
  `docker-compose.yml` are unverified. The runtime they describe was verified by running
  the server with the same environment variables and capture directory, and the five
  decoder package names were verified on Ubuntu 24.04 (all five installed and driven).
  First thing to try on a real box.
- **`Dockerfile.decoders` is the image for working on recordings** — the five external
  decoders and no radio programs. `Dockerfile.radio` now carries both, because a radio
  with nothing to decode what it hears is half a tool.
- **History rewrite.** A commit in pushed history contains a symlink target naming a
  private repository path. The symlinks were removed in a follow-up commit and are
  gitignored, but the string remains in history. Not yet decided whether to rewrite.
- **Challenge names** appear in code comments and one test fixture in this public
  repo. Not yet decided whether to scrub them.
- **The `view` group label** on the parameter bar may want a more generic name, since
  its contents change with context.

## Loose ends

- ~~Plugins do not survive a reload.~~ Fixed: the box serves every `.js` in
  `SDRFLEX_PLUGINS` (default `web/plugins`, so `bbc.js` is finally live) to every tab,
  and a file dropped on the window is kept in that browser. Both still *run* in the
  tab, never on the server.
- That plugin has no ADR-0025 conformance fixture.
- `web/test/plugin.mjs` (Playwright) depends on capture files that were removed in the
  security cleanup, so it fails for that reason rather than a regression. Needs
  re-pointing at a fixture that can live in a public repo.
- One capture in the set is 0.1 s long, which the author believes is a packaging bug
  on their side.
- The remote engine has no reconnect. If the socket drops the page says so and keeps
  showing its last frames, but recovering means a reload.
- `readSpan` on a long channel still builds the whole span in the tab's memory. The
  server chunks it over the wire, but export is the one path that still wants all of it
  at once.
- The live window only refreshes while the client is asking for frames. The app does
  that sixty times a second in every view, so it does not matter in practice — but a
  backgrounded tab's idea of where history starts goes stale.
- "Promote this ring to a permanent capture" does not exist, and is the obvious next
  thing to want the first time you hear something interesting go past.
- One radio per session. Two tabs are two radios, and on one dongle the second fails
  with whatever the driver says about a busy device.

## Deferred on purpose

- **WebUSB.** Discussed and deliberately postponed. It is real — RTL-SDR has working
  prior art in a browser — but it fights the architecture twice over: samples would
  arrive in the tab with the engine on the box, and a tab has nowhere to write the ring
  that ADR-0005 depends on. Worth building later as a *second* mode ("laptop, dongle,
  no server"), RTL-only, not as the way in. Chrome and Edge only, and needs a secure
  context, so it would force the `tailscale serve` TLS setup.

- Slot-map overlay — until the CTF has been played blind.
- **`Identify` over the native chain.** The external decoders are in (ADR-0031); a
  Manchester slicer and a CRC search over the catalog is the obvious next tier, and
  `fixtures/manchester-crc` is exactly the case it would catch — it is currently a clean
  negative, which is the right answer today and the wrong one once this exists. The
  report shape already has room: a row is a chain, not a decoder.


- The flow rail. Built once, then removed: it complicated the interface without
  earning its space.

- **Run it on an unfolded foldable, on the device itself.** Wanted; not planned yet.

  Some of this already works and is worth separating from the part that does not.
  Browsing to the box from a phone works today over the tailnet, and the in-tab engine
  is a complete tool with no server at all — so a phone can already open the tool, drop
  a capture on it, and decode. What is new is two things.

  **The screen is a shape nothing here was designed for.** The layout is responsive and
  has been tested at 320, 390, 420, 1000 and 1100 px — all of them wide-and-short or
  narrow-and-tall. An unfolded Pixel Fold is close to *square* and large, which is a
  third case: the spectrum-over-waterfall split assumes vertical room is the scarce
  thing, and the dock assumes horizontal room is. Neither assumption holds. There is
  also the fold seam itself (`env(fold-*)`, the viewport-segments API) and the
  fold/unfold transition, which is a live resize across a hinge rather than a rotation.

  **With a Pluto, the hard part of "locally" disappears.** This was written first around
  an RTL-SDR, which was the wrong radio to reason from. An RTL dongle on a phone is a
  USB device somebody has to claim: Android's permission model, `/dev/bus/usb` under
  Termux, WebUSB as the alternative — all of it awkward.

  A Pluto is not a USB device to claim. It presents a USB-ethernet gadget answering on
  `192.168.2.1`, and libiio talks to it over TCP on port 30431. The phone does not have
  to open a device; it has to bring up a network interface, which is the kernel's job
  rather than an app's. Everything above that is a socket.

  That makes the shape of it:

  - **Node under Termux, a Pluto on the USB-C port, and no native code at all.** The
    server already has no dependencies and no build step, which is exactly what runs
    under Termux.
  - **A browser alone still cannot do it**, and that is the sharp edge worth knowing: a
    page cannot open a raw TCP socket, so the in-tab engine can never speak to a Pluto
    however good the phone is. Something has to hold the socket, and on the phone that
    is Node.
  - **The unknown is Android, not us.** Whether the Pixel Fold brings up a USB-ethernet
    interface for the Pluto in host mode, and whether an app can route to `192.168.2.x`
    while cellular or Wi-Fi is also up. That is the first thing to try, and it needs no
    code: `iio_info -u ip:192.168.2.1`, or just a TCP connect to port 30431.

  This also settles the WebUSB question above rather than changing it: with a Pluto
  there is nothing for WebUSB to do. It stays relevant only for RTL-style dongles,
  which is a smaller prize than it looked.


---

## Standing rules learned the hard way

- **A pane that reads a node after an await is reading the wrong node.** A snapshot
  replaces every object, so results land on the replacement. The tell is that the
  *first* run of something shows nothing and the second shows everything — because by
  then the render happened to pick up the object the previous call wrote to.
- **A stream type with nothing downstream is a dead end a person will find in five
  minutes.** `bits` had only Export for months. Check what consumes each kind.

- **A control loop that works better with more noise is not a control loop.** An
  early-late gate went into the Manchester slicer to fix erratic decoding; the fault
  was actually the phase search choosing between two inequivalent grids at random.
  Measure the thing you added against the thing you think it fixed.
- **Node identity is not node identity once there is a server.** A snapshot replaces
  every object, so `this.node() !== n` is always true afterwards. Compare ids, and keep
  client-only `_` state across a swap.

- **The session boundary is not a trust boundary.** Recovered flag values were once
  written into a public roadmap file and staged; symlinks naming a private repo path
  were actually committed. `.githooks/pre-commit` now rejects flag-shaped strings in
  staged diffs. It is a backstop, not the control.
- **Measure before adjusting anything visual.** Comparing element rectangles is not
  comparing baselines — a zero-height inline-block probe sits exactly on the baseline
  and is the tool for this. Two rounds were lost to guessing.
- **Auto parameters must show their evidence** (ADR-0017). Twice, an estimator was
  confidently wrong in a way only its own stated reasoning exposed.
