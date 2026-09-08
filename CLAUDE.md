# SDR Flex

**Read `project/sdr-flex_PROJECT.md` first.** It is the running project note: where the
build actually is, what was decided in conversation but not yet written into an ADR,
what is still open, and what is deferred on purpose. Update it at the end of a session,
not the start of the next one.

Then, as needed:

- `docs/adr/` — why each decision was made. 28 of them; they are the design.
- `docs/06-roadmap.md` — the plan as designed, with its sequencing rationale.
- `docs/08-ui-principles.md` — before changing anything visual.

## House rules

- **American spelling** in code, comments, docs and UI.
- No build step in the web client. Plain ES modules, static hosting.
- **Never commit capture files, flag values, or paths naming a private repository.**
  `.githooks/pre-commit` rejects flag-shaped strings; it is a backstop, not the control.
- Measure before adjusting anything visual. Element rectangles are not baselines.
- Every auto-derived parameter shows the evidence for its value (ADR-0017).
