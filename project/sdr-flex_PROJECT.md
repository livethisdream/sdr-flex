# SDR Flex — project note

Where the build actually is, what has been decided in conversation but not yet written
into an ADR, and what is still open. `docs/adr/` records *why* each decision was made
and `docs/06-roadmap.md` records the plan as designed. Neither survives the gap between
one working session and the next, which is what this file is for.

Lives at `project/<repo-name>_PROJECT.md` by convention — same path in every repo, so
it is the first file to read and does not have to be found.

Update it at the end of a session, not the start of the next one.

**Last updated:** 2026-09-08 (the container, then hardware) · branch `claude/sdr-flex-toolkit-planning-c4ghl1`

---

## Where it is

MVP in the browser, the same tool with its engine in a container, and live radio into a
ring recording. Static ES modules, no build step, no dependencies on either side.
30 ADRs.

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

Tests: four Node suites (`web/test/*.test.mjs`) for pure logic, plus Playwright
suites driving the real DOM. Headless `requestAnimationFrame` is unreliable, so the
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
  `direwolf` — four rows.
- **Format negotiation is derived and reported.** The engine resamples and converts the
  span to what the program wants, and the record pane says which, because it changes
  what the decoder sees.
- **These nodes are opaque** (ADR-0013) and the tab is drawn differently for it.
- **Adapters ship with the tool, not dropped in** — an adapter is a command line, so a
  droppable one is code execution on the box. Same line ADR-0029 drew for plugins.
- **Verified against the real programs.** `rtl_433` and `multimon-ng` are installed in
  the build environment, so the adapter path is tested end to end against actual
  third-party software rather than a mock — the first piece in a while where "tested"
  means that.

**The conformance harness is in** (ADR-0025), and it covers native and external chains
alike: `fixtures/<name>/` holds a capture, a `fixture.json` saying what it must produce
and which parameters must be *derived*, and a README with license and provenance. All
captures are synthesized by `fixtures/make.mjs` from fixed seeds — CC0, byte-identical
on regeneration, no question about who transmitted them. A fixture whose program is not
installed skips rather than fails.

## Wanted later

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
  was written in, so the `Dockerfile` and `docker-compose.yml` are unverified. The
  runtime they describe was verified by running the server with the same environment
  variables and capture directory. First thing to try on a real box.
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
- **`Identify`** — every applicable decoder in parallel over the span, with progressive
  results. Nearly free now that one adapter works, and it is the headline interaction
  M4.5 was aiming at. Deliberately left for its own pass.


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
