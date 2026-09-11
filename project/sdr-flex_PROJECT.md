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
- **Bind defaults to the tailnet interface**, falling back to loopback — never to every
  interface. The compose port publish is scoped to one host address so forgetting to
  set it fails closed.

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
- Remainder of decoder wave 2: Manchester, differential, framer, CRC.
- External process adapters.
- The flow rail. Built once, then removed: it complicated the interface without
  earning its space.

---

## Standing rules learned the hard way

- **The session boundary is not a trust boundary.** Recovered flag values were once
  written into a public roadmap file and staged; symlinks naming a private repo path
  were actually committed. `.githooks/pre-commit` now rejects flag-shaped strings in
  staged diffs. It is a backstop, not the control.
- **Measure before adjusting anything visual.** Comparing element rectangles is not
  comparing baselines — a zero-height inline-block probe sits exactly on the baseline
  and is the tool for this. Two rounds were lost to guessing.
- **Auto parameters must show their evidence** (ADR-0017). Twice, an estimator was
  confidently wrong in a way only its own stated reasoning exposed.
