# ADR-0015: Licensing posture

**Status:** Accepted — Option B

## The constraint

The dependencies we most want are copyleft:

| Dependency | License | Consequence of linking |
|---|---|---|
| **GNU Radio** | GPL-3.0 | Anything linking it is GPL-3 |
| gr-satellites and most OOT modules | GPL-3.0 | Same |
| SDRangel | GPL-3.0 | Same (and not linkable anyway — see [reuse](../07-reuse.md)) |
| URH | GPL-3.0 | Same |
| rtl_433 | GPL-2.0-or-later | **Subprocess: no obligation on us** |
| multimon-ng | GPL-2.0 | **Subprocess: no obligation on us** |
| dump1090-fa | GPL-2.0 | **Subprocess: no obligation on us** |
| SoapySDR | Boost | Permissive |
| liquid-dsp | MIT | Permissive |

The GNU Radio dependency is load-bearing and it is GPL-3. Any process that links it is
GPL-3. That is not negotiable and should not be litigated.

## What the architecture already buys us

The process boundaries chosen for other reasons (ADR-0003, ADR-0013) happen to be
license boundaries too:

```
 client (web)          ── separate process, network protocol
 control-plane server  ── Python, no GR import (ADR-0003)
 data-plane relay      ── Rust, reads rings, no GR import (ADR-0014)
 ────────────────────────── GPL-3 boundary ──────────────────────────
 DSP workers           ── link GNU Radio → GPL-3
 external decoders     ── separate programs, arms-length aggregation
```

This is a genuine, defensible separation, not a fig leaf: the workers are separate
programs communicating over a documented IPC protocol, and the external decoders are
unmodified third-party binaries invoked over pipes.

## Options

**A. GPL-3 the whole thing.** Simplest, no boundaries to defend, aligns with the
community whose work we are building on, and forecloses a proprietary fork of our
own work. Cost: closes off a proprietary commercial product built on this codebase.

**B. Permissive core (Apache-2.0), GPL-3 workers.** Server, relay, client, plugin
SDK, and protocol are Apache-2.0; only the GR-linking worker is GPL-3. Preserves
the option of commercial/proprietary derivatives and third-party permissive clients.
Cost: the boundary must be maintained forever and defended in every code review
— one convenience import of `gnuradio` into the server erases it.

**C. Dual-license / open-core.** Explicitly not recommended. The tools this project
is reacting against include one whose problem is that it is "too expensive."
Adopting the same posture undercuts the pitch.

## Decision

**Option B: permissive core, GPL-3 workers.**

- **Apache-2.0** — control-plane server, Rust data-plane relay, web client, plugin
  SDK, wire protocol, plugin manifest schema, all documentation.
- **GPL-3.0** — the DSP worker, which links GNU Radio, and any GR-linking plugin.
- **Unmodified third-party binaries** (`rtl_433`, `multimon-ng`, …) keep their own
  licenses; we invoke them over pipes and ship none of their code.

### Enforcing the boundary

The boundary is worth nothing if it erodes by accident, so it is enforced, not
merely documented:

1. **A CI test asserts that the control-plane and relay packages never import
   `gnuradio`, `gr_*`, or any GPL OOT module.** It fails the build, not a review.
2. SPDX headers on every file; a CI check that the header matches the directory's
   declared license.
3. `LICENSING.md` states the boundary in one paragraph, and every PR that moves code
   across it must say so in the description.

The one failure mode is a convenience `import gnuradio` in the server for something
that "just needs a filter design helper." Rule: if the control plane needs DSP math,
it gets it from `scipy` or `liquid-dsp`, never from GR.

## Why B over A

B costs almost nothing *right now*
because the boundary already exists for technical reasons, and it keeps options open
before anyone knows what this becomes. If maintaining it ever creates real friction,
collapsing to A is a one-commit change; going the other direction is not.

**License the **protocol and plugin manifest schema** permissively and
document them as a stable public interface.** Third parties should be able to write a
client or a plugin under any license they like. That is what makes ADR-0001 worth
anything, and Apache-2.0's patent grant makes it the right choice over MIT for a
protocol other people are meant to implement.

## Not legal advice

This records engineering intent. Get an actual opinion before shipping anything
commercial.
