# SDR Flex

**Read `project/sdr-flex_PROJECT.md` first.** It is the running project note: where the
build actually is, what was decided in conversation but not yet written into an ADR,
what is still open, and what is deferred on purpose. Update it at the end of a session,
not the start of the next one.

Then, as needed:

- `docs/adr/` — why each decision was made. 30 of them; they are the design.
- `docs/06-roadmap.md` — the plan as designed, with its sequencing rationale.
- `docs/08-ui-principles.md` — before changing anything visual.

## House rules

- **American spelling** in code, comments, docs and UI.
- No build step in the web client. Plain ES modules, static hosting.
- **Never commit recorded captures, flag values, or paths naming a private repository.**
  `.githooks/pre-commit` rejects flag-shaped strings; it is a backstop, not the control.
  The one exception is `fixtures/`, which ADR-0025 requires: those captures are
  *synthesized* by `fixtures/make.mjs` from fixed seeds, carry a license and a
  provenance note, and are capped at a few hundred kB. Nobody transmitted them, so
  there is nothing in one that could have been overheard. A capture off the air does
  not go in the repository — it goes in the capture directory, which is gitignored.
- Measure before adjusting anything visual. Element rectangles are not baselines.
- Every auto-derived parameter shows the evidence for its value (ADR-0017).

## Running it

- In a browser: serve `web/` statically, or open `web/index.html`.
- With the engine on a box: `node server/main.js`, or see `server/README.md`.
  `node seed-captures.mjs` first puts the shipped fixtures where the library looks,
  so a first run has something to open.
- With no SDR to hand: open a radio and pick "Synthetic signal" — a real process,
  paced to real time, which is how the live path is tested.
- `?engine=mock` forces the in-tab engine. The browser tests rely on this.

## Tests

- `node --test "web/test/*.test.mjs"` — pure logic, the wire format, the socket, and mock-versus-
  server parity. No browser needed.
- The Playwright suites drive the real DOM. Headless `requestAnimationFrame` is
  unreliable, so they step `app._frame(t)` by hand through `window.sdrflex`.
