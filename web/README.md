# M0 — the toy model

The real client running against a **mock engine in the browser**. No server, no build
step, no GNU Radio. See [ADR-0021](../docs/adr/0021-mock-engine-first.md) for why this
is the first thing built rather than the last.

**Live:** https://livethisdream.github.io/sdr-flex/

Locally:

```bash
cd web && python3 -m http.server 8000    # ES modules need http://, not file://
```

## Deployment

Pages serves the repository from the default branch, so the app is at `/web/` and the
root `index.html` redirects there. `.nojekyll` at the root stops Jekyll from trying to
build `docs/`, which is what usually breaks a branch-based Pages deploy of a repo that
contains markdown.

To publish `web/` as the site root instead, with no redirect: Settings → Pages →
Source → **GitHub Actions**, then uncomment the push trigger in
`.github/workflows/pages.yml`.

## What is real

Everything below is honest DSP on synthesised samples, not a rendering of a
screenshot:

- **The scene** is a deterministic function of sample index — a steady carrier at
  −180 kHz, a wideband hump at +150 kHz, and an OOK burst train at −25 kHz carrying
  `AA AA 3C 69` PWM-coded at a 417 µs symbol period, firing about once a second.
  Nothing is stored, so all history is scrubbable for free.
- **The tuner** is a real frequency-translating FIR decimator. Decimation and taps are
  derived from the box you drag.
- **The spectrum** is a real FFT with selectable size and window.
- **`⟲ auto`** runs real estimators: Otsu for the slice threshold, pulse-length
  clustering for the symbol period. It recovers ~407 µs against a true 417 — the
  difference is the burst's rise time, which is what a real receiver would measure too.
- **The decode** recovers `aa aa 3c 69` end to end.

## Known limits

- **Decimation is capped at 96**, so the narrowest channel off the 480 kS/s source is
  5 kS/s. Work per display frame scales with `bins × decim`, and past this the toy
  would read a million input samples to draw one row. A real engine cascades half-band
  stages instead of running one long filter at the input rate.
- The mixer uses a phasor recurrence rather than `cos`/`sin` per sample — 109 dB SFDR,
  and no measurable magnitude drift over 200 000 samples.

## What is faked, deliberately

- **Latency.** The mock spends the [budget](../docs/08-ui-principles.md#latency-budget)
  on purpose: ~40 ms on hot parameters, ~260 ms on structural changes. A mock that
  answered in microseconds would let us tune the interface against a backend that
  cannot exist.
- No hardware, no ring recorder, no plugins, no external processes, no audio.
  `rtl_433` and the burst detector appear in the menu marked `M4` and do nothing —
  they are there to show the palette is type-filtered, not to pretend they work.

## Try it

1. Drag a box across the burst train at **433.895 MHz** — the menu opens where you
   release. Pick **Tune here**.
2. On the tuner, drag another box or press `/` → **AM envelope**.
3. On that, → **PWM / OOK slicer**. Its threshold and symbol period arrive `⟲ auto`.
4. Switch to the **Bits** tab: `aa aa 3c 69`.

Watch the metrics row at the bottom — interaction count and pointer travel against
their budgets, plus frame rate and jitter.

Other things worth poking: FFT size, window, averaging, colormap and scroll speed in
the strip; drag the color bar to set the dB range; click a cell's colored left edge
to pin a value to `🔒 manual` and hover it to see what auto would have chosen.

## Layout

| | |
|---|---|
| `src/scene.js` | the synthetic RF scene |
| `src/dsp.js` | FFT, windows, FIR design, tuner, envelope, estimators, slicer |
| `src/engine.js` | the engine contract + the mock that implements it |
| `src/waterfall.js` | WebGL2 waterfall, with a 2D fallback |
| `src/views.js` | spectrum trace, time series, bit raster |
| `src/menu.js` `src/strip.js` `src/metrics.js` | contextual menu, cell strip, budgets |
| `src/app.js` | the shell |

The engine is reached only through its async contract, so swapping `MockEngine` for an
HTTP/WebSocket client at M1 should not touch the UI. If it does, ADR-0001 has been
violated somewhere.

## Tests

```
node web/test/detectors.test.mjs
```

No browser, no dependencies. It is the first piece of
[ADR-0025](../docs/adr/0025-golden-capture-conformance.md)'s gate at the size M0 can
carry it: the synthetic scene stands in for the golden capture, and every detector has
to reach the right answer *through its estimator* rather than from parameters the test
handed it — including the negative case, where an estimator pointed at empty spectrum
has to decline instead of guessing.
