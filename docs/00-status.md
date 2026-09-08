# Status

Running note: where the build actually is, what has been decided in conversation but
not yet written into an ADR, and what is still open. The ADRs record *why* a thing is
the way it is; the roadmap records the plan as designed. Neither survives the gap
between one working session and the next, which is what this file is for.

Update this at the end of a session, not the start of the next one.

**Last updated:** 2026-09-08 · branch `claude/sdr-flex-toolkit-planning-c4ghl1`

---

## Where it is

MVP, running in the browser with no build step. Static ES modules, mock engine,
~4,300 lines. 28 ADRs.

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

## Decided in conversation, not yet an ADR

- **Containerized engine is the next substantive step**, scoped smaller than M1: an
  engine speaking the same async contract over WebSocket, browser swaps `MockEngine`
  for a thin client, no UI changes. Acceptance test is the largest capture behaving
  identically with a one-import diff.
- **Deployment target is a home server on a Tailscale tailnet.** The container serves
  the static client itself so the page and the WebSocket share an origin — this avoids
  both CORS and the mixed-content rule that blocks `ws://` from an `https://` page.
  `tailscale serve` if real TLS is wanted. **Never `tailscale funnel`** — that is the
  public internet, and captures with flags live on that box. Bind to the Tailscale
  interface, not `0.0.0.0`. No auth in the app; the tailnet is the boundary.
- **The point of the server is heap, not convenience.** The capture stays on the
  server's disk; the tab pulls only the spectrum rows and spans it draws.

## Open, needs a decision

- **Node or Python for the engine.** Recommended Node: `engine.js` and `dsp.js` lift
  over nearly as-is, so the effort goes into the transport contract rather than
  re-deriving FFTs, and the DSP core can be swapped to Python later when GNU Radio
  integration is a real requirement. Python first means reimplementing all the DSP
  before the contract is proven. **Not yet confirmed.**
- **Where plugins run** once there is a server. They are browser JS today. Proposal is
  to keep them browser-side for the first server pass and revisit deliberately.
- **Server-side file opening.** Drag-drop stops being the primary path once the
  captures live on the box; pointing at a path on the server is a new capability, not
  a port. Probably belongs in the same pass.
- **History rewrite.** A commit in pushed history contains a symlink target naming a
  private repository path. The symlinks were removed in a follow-up commit and are
  gitignored, but the string remains in history. Not yet decided whether to rewrite.
- **Challenge names** appear in code comments and one test fixture in this public
  repo. Not yet decided whether to scrub them.
- **The `view` group label** on the parameter bar may want a more generic name, since
  its contents change with context.

## Loose ends

- Plugins do not survive a reload. `web/plugins/bbc.js` sits in the repo and nothing
  loads it at startup.
- That plugin has no ADR-0025 conformance fixture.
- `web/test/plugin.mjs` (Playwright) depends on capture files that were removed in the
  security cleanup, so it fails for that reason rather than a regression. Needs
  re-pointing at a fixture that can live in a public repo.
- One capture in the set is 0.1 s long, which the author believes is a packaging bug
  on their side.

## Deferred on purpose

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
