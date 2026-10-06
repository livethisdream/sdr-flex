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

**Step 1, gates on correctness pass; the jitter gate fails, and the step is stopped there.**
`server/gr/engine.js` (`GrEngine`) computes a tuner on a recorded capture with GNU Radio's
`freq_xlating_fir_filter_ccf`, in 0.25 s blocks the session fetches before frames and audio.

- Passing: a known tone comes out at 5000.0 Hz (one bin is 24.4) and 0.014 dB from its level;
  GNU Radio matches the JS tuner sample for sample (shift 0, correlation 1.000000, difference
  5.3e-4 on a 0.5 signal) after an exact alignment of history and mixer phase; adjacent reads
  join exactly; every block is full length, so the 10 ms short block is gone. A tuner block on
  its own: GNU Radio 11.9 ms, JS 18.3 ms.
- Failing: in a session the frame jitter got slightly worse (stereo tab 53.9 ms sd against
  49.5; source spectrum 16.2 against 13.2). The session log shows why: blocks averaged 167 ms
  in place of 11.9, and 504 reads fell back to JS against 77 served from GNU Radio.
- Cause: fetching on the critical path. A frame request awaits its blocks; while it waits,
  playback moves past the window it prepared, so the next reads miss and the JS engine
  computes them on the server's one thread, which in turn delays draining the worker's pipe.
  The worker is fast enough; the way it is asked is not.

**Step 1, resumed and done.** Fetching moved off the critical path: the engine keeps the
worker about a second ahead of the playhead in the background, and a frame or audio call
waits only for blocks that are missing, which in playback is none; a jump waits once. A
worker stopped on purpose now stays stopped and fails what was pending, so a closing session
cannot restart it. Reads before the capture starts (waterfall rows at t <= 0) are counted as
outside rather than as misses.

| frame jitter at the browser, sd | JS engine | GNU Radio tuner |
|---|---|---|
| stereo tab (spectrum + scope) | 49.3 ms | 35.5 / 36.1 ms (two runs) |
| source spectrum | 16.9 ms | 14.8 / 15.1 ms |

p95 on the stereo tab 159 ms -> 118-120 ms; frame rate 20.9 -> 24/s. Real misses 33-37
against 122-126 reads served from GNU Radio (one per node added, when its parameters are
derived, and the reads before the first prefetch). Still far from the 4 ms budget: the FM
and stereo decoders downstream are still the JS engine's, which steps 2 and 3 move. Unit
suite 536 pass (1 needs decoders installed); full image 566 pass, 0 fail.

**Step 2, done 2026-10-06.** The FM demod is GNU Radio's `quadrature_demod_cf`, in one
flowgraph with its tuner, so tuner samples never cross the pipe only to be demodulated. The
deviation is still SDR Flex's estimate (ADR-0044), read from the GNU Radio tuner.

- Alignment: `quadrature_demod_cf` starts with one zero of history, so its first output is
  discarded; fed the tuner from k0-1 it then gives the JS demod's k0. Rms difference 3e-7.
- Gates: a 1 kHz tone at 5 kHz deviation comes back at 1000 Hz, -0.053 dB; parity with the JS
  demod 8.6e-7; reading the demod fetches its own blocks and not its tuner's. RDS on the
  signal-ID broadcast slot decodes through GNU Radio's FM (station NUMBERS, radiotext),
  130 blocks at 28.8 ms each, 120 reads served, 1 fallback (the node's own derivation).
- A decoder's whole-capture read (`readSpan`) now prepares each chunk just before reading it.
- Jitter on the stereo tab: 36.6 / 38.5 ms sd, the same as after step 1. Moving FM neither
  helped nor hurt; the stereo decoder and the views it feeds are still the JS engine's on the
  server's one thread, which step 3 moves.
- Open, for step 3: in a live session blocks take about 160 ms against 29 ms alone, and misses
  rise to 41, which points at queueing behind the JS work rather than at GNU Radio.
- Unit suite 536 pass (1 needs decoders installed); full image 569 pass, 0 fail.

**Step 3, done 2026-10-06.** Stereo is GNU Radio's blocks — complex band-pass on the pilot,
`pll_refout_cc`, the PLL squared for 38 kHz, the L-R mix, `fft_filter_fff` low-pass and
decimation, the matrix, `fm_deemph` — arranged as `wfm_rcv_pll` arranges them, but fed by
SDR Flex's FM node and able to decode as mono when the pilot evidence says so. Frame k is
centered on FM sample k*decim, as the JS decoder's is, from the filters' known delays.

- Known answer, from ITU-R BS.450: 66.4 dB of separation on a standard signal (gate 40).
- **The channel is the limit, not the decoder.** A 200 kHz tuner gives 36 dB; 240 kHz gives
  66 dB. Broadcast FM's sidebands reach past 200 kHz, and a narrower channel distorts the
  composite before the decoder sees it. A stereo node could say so with evidence (ADR-0017).
- The PLL locks within 5 ms; blocks start 20 ms early and discard it.
- **The JS decoder and the test modulator are fixed to the standard** (reference -sin 2ψ, sin
  pilot, sin subcarrier). JS separation on a standard signal: -4.6 dB before, 73.3 dB after.
  The drawn-chain test now takes the imaginary part, for which `core.real` gained a `part`
  setting (`real` or `imag`), as GNU Radio has complex_to_real and complex_to_imag.
- The two decoders hear the same tones: within 0.6 dB and 0.1°. Each has one artifact ~35 dB
  down: JS lets some 19 kHz pilot through its low-pass; GNU Radio's PLL, at wfm_rcv_pll's loop
  bandwidth, puts sidebands 50 Hz either side of a tone.
- The signal-ID broadcast slot is not standard (cos pilot, cos subcarrier), so it no longer
  separates in SDR Flex, as it would not in any standard receiver.

| frame jitter on the stereo tab | JS engine | after steps 1-2 | after step 3 |
|---|---|---|---|
| sd | 49.3 ms | 36.1-38.5 ms | 13.3 / 13.5 ms |
| p99 | 169 ms | 147-167 ms | 59.6 / 59.8 ms |
| frames per second | 20.9 | 23.5-24.4 | 33.7 / 34.5 |

The source's own spectrum, which no GNU Radio stage touches, stays at 13.5-15.8 ms: the floor
in this setup. Still above the 4 ms budget. Unit suite 536 pass (1 needs decoders installed);
full image 573 pass, 0 fail.

**Step 4, part A (fix the frame pipeline), done; the 50 ms gate is not met yet.**
Knob to visible was 0.7-2.6 s on both engines, with `setParam` itself taking 2-16 ms: the time
was all in getting a fresh frame. Changes: each live view's frame request travels alone, so a
fast view no longer waits for the slowest one in a batch; each frame prepares only what it reads
(`frameSpan`), nearest the playhead first; a session has a pool of three workers behind a
queue that serves what a frame waits on before what a read needs before the prefetch, and
raises a queued job when a frame starts waiting on it (`server/gr/pool.js`).

| retune to a new frame, ms | JS engine | GNU Radio, before | after A |
|---|---|---|---|
| eight retunes | 49-2919 | 668-1719 | 66-305 (median ~165) |

Server-side, the tuner's own frame now waits 22 ms on average for its block and computes in
0.7 ms. What remains is other frames computing on the server's one thread — a stereo spectrum
up to 257 ms, the source's spectrum up to 110 ms, mostly reads falling back to JS and JS FFTs —
during which nothing else on the server moves. Stereo-tab jitter stays at 14-15 ms sd, 38 frames/s.

**Step 4, option 1 (clear the server's thread), done; the gate is met at the median, not at p95.**
- A waterfall's prefill computes 64 rows per request; that held the server's thread for up to
  250 ms after each retune. Batches now give way every 8 ms.
- Live frame requests are marked `live`; every request carries its moment, so the server had
  been serving live views at the lower priority.
- One worker in the pool (now four) is kept for blocks a live view waits on.
- A frame waits only for the blocks its read touches: a tuner's IQ exactly, anything read
  through the detector cache rounded to its 0.25 s blocks; the margins are fetched behind.

Event-loop delay on the server during the retune test (`monitorEventLoopDelay`, 5 ms resolution):

| | p50 | p95 | p99 | max |
|---|---|---|---|---|
| JS engine | 5.1 ms | 299.9 | 685.8 | 1336.9 |
| GNU Radio engine | 5.1 ms | 5.6-5.9 | 6.8-23.8 | 320-525 (session start) |

Retune to its frame, server side: 10-51 ms with 3 of 16 at 103-125 ms (median ~23 ms); end to
end in the headless browser, which is painting at 39 frames/s meanwhile, 34-171 ms (median ~80).
The remaining spikes look like live stereo views (~50 ms blocks) sharing the reserved lane with
the tuner's (~12 ms). Stereo-tab jitter 14.3 ms sd at 39 frames/s.

On a phone over Wi-Fi the round trip measured earlier (11-338 ms) is larger than all of this,
which no change on the box removes.
