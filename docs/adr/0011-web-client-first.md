# ADR-0011: Web client first, WebGL rendering, native shell later

**Status:** Accepted

## Decision

The reference client is a web application: TypeScript, React, WebGL2 for all
signal rendering. A native desktop experience comes later as a Tauri shell around the
same client, not as a separate UI.

## Why

- **Zero-install for the common case.** The engine is already a server (ADR-0001);
  pointing a browser at it is the shortest path from "I have a dongle" to "I see a
  waterfall." GNU Radio's install burden is the field's biggest onboarding tax and we
  should not add to it.
- **Remote by default.** The radio is often not on the machine you're sitting at.
- **The UI talent pool and iteration speed are both much larger on the web.** For a
  project whose entire premise is "beautiful, intuitive GUI," that matters more than
  it would elsewhere.
- One codebase covers browser and desktop.

WebGL2 rather than canvas2D is not optional: a 2048-bin waterfall at 60 fps is
~120 Mpixel/s of texture update; canvas2D cannot do it, and this is the single most
visible surface in the product.

## Cost

- Direct hardware access (USB) needs the server or the Tauri shell — fine, since the
  server owns hardware anyway.
- Browser audio has latency and autoplay constraints.
- WebGL2 rather than WebGPU for now, because WebGPU's availability is still uneven;
  the renderer should be abstracted enough to swap.

## Would change our mind

Nothing for the reference client. A third-party native client (Qt, egui) is a
legitimate thing for someone to build against the API — that's what ADR-0001 is for.
