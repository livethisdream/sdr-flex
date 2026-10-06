# Plan: moving the broadcast chain to GNU Radio

Branch `gnuradio-engine`; return point tag `pre-gnuradio-engine` on `main`. Implements
[ADR-0044](../docs/adr/0044-gnu-radio-is-the-engine.md). The server on the box keeps running
`main` until every gate below passes and the merge is approved.

## The seam

`server/session.js` makes the engine in one line (`new Engine(...)`). A `GrEngine` extends it:
it keeps the graph, the protocol and every method the client calls (ADR-0029), and overrides
only the ones that produce samples. Where every operation from the source down to a node has a
GNU Radio block, the worker computes it; anywhere else, the JS engine does, unchanged.
`SDRFLEX_ENGINE=gnuradio` turns it on; unset, nothing changes. The client is not touched.

## Steps

Each step is a commit, and each ends with its gate. A step that fails its gate stops the plan
and comes back as a finding, not a workaround.

**0. The worker in the server.** `server/gr/worker.py`, one per session (ADR-0003), started on
connect and stopped on close, restarted if it dies. Control is JSON lines; samples come back
through GNU Radio's C++ sinks on their own pipe, so no sample passes through Python (ADR-0014).
*Gate:* worker start under 300 ms; a killed worker is restarted and the session carries on.

**1. Source and tuner.** `freq_xlating_fir_filter_ccf` on demand over recorded blocks, with the
grid anchored to the capture as the JS tuner is, and margins that give back exactly the samples
asked for. The display spectrum is computed in the worker too.
*Gates:* a tone at a known offset lands within one bin of where it should, at the right level
(±0.5 dB); two adjacent blocks equal one long run, sample for sample; the 10 ms short block is
gone.

**2. FM demod.** `quadrature_demod_cf`, with the deviation still derived by SDR Flex's estimator
from the tapped stream, evidence shown as today.
*Gates:* a known tone at a known deviation comes back at the right frequency and level; RDS on
the signal-ID broadcast slot still decodes through redsea.

**3. Stereo.** GNU Radio's stereo blocks, against a known answer from the broadcast standard
(ITU-R BS.450), not from our own modulator, which carried the same 90° error as the JS decoder.
*Gates:* at least 40 dB of separation on a standard synthetic signal; the JS decoder is fixed or
retired, not left wrong.

**4. Playback and live.** A streaming flowgraph for audio and for a radio's ring, retuned with
setters; the on-demand path stays for scrubbing. The 220 ms retune outlier is reproduced and
explained here.
*Gates:* knob to audible change under 50 ms at p95 on the box; scrubbing back over a span gives
the same samples playback gave.

## Gates that apply to every step

- **Speed:** a 0.25 s block of the chain so far no slower than the JS engine; streaming at least
  10x real time.
- **Jitter:** frame delivery to a browser measured as in `spike/gnuradio/jitter_baseline.mjs`.
  Baseline today: 13.8 to 49.6 ms (sd), p99 up to 174 ms. Each step reports it; the target is
  the 4 ms budget, and the number after step 4 decides whether the ADR-0014 relay is built.
- **No regressions:** the unit suite, and the conformance suite in the full image with every
  decoder installed.
- **Parity where both run:** for each moved operation, GNU Radio and JS on the same input; where
  they differ, the known answer says which is right.

## Not in this plan

Recipes and the palette from GNU Radio's block definitions (ADR-0043) come after the broadcast
chain proves the engine. So does the first real radio, which is decoded by the engine we keep.
The phone's Wi-Fi latency is a separate investigation.

## Progress

**Step 0, done 2026-10-06.** `server/gr/worker.py` and `server/gr/worker.js`; a session starts
one when `SDRFLEX_ENGINE=gnuradio` and stops it on close. Gates: worker up in 175 ms in a test
and 197 ms in a session (gate 300); a killed worker is replaced and the session carries on; a
known tone arrives intact on the data pipe, written by `file_descriptor_sink`, so no sample
passes through Python. Found on the way: GNU Radio's C++ prints to stdout on its own, which is
the control channel, so the worker keeps a private copy of it and sends fd 1 to stderr. Unit
suite 536 pass (1 needs decoders installed); full image 561 pass, 0 fail.
