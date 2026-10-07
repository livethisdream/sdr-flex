# GNU Radio as the engine: spike results, 2026-10-05

GNU Radio 3.10.9.2 in the `Dockerfile.full` image, 24 cores. Capture: the GRCon26 signal-ID
composite, broadcast FM slot at -140 kHz (500 kS/s complex). Chain: `freq_xlating_fir_filter_ccf`
(decimate by 2) -> `analog.wfm_rcv_pll` (FM, pilot PLL, stereo, 75 us de-emphasis, 50 kS/s out).
The JS numbers are the current engine on the same slot.

## Speed

| | GNU Radio | JS engine |
|---|---|---|
| 0.25 s block on demand, fresh flowgraph (`bench.py`) | 55 ms median, 634 ms first | 100-150 ms |
| same, persistent worker, as Node sees it (`drive.mjs`) | 64 ms median (IPC 2.2 ms), 94 ms max | 100-150 ms |
| worker start + first block | 208 ms, once | - |
| 16 s as sequential 0.25 s blocks | 4.0x real time | ~2x |
| one flowgraph streaming | 37x real time | - |
| add a block to a running flowgraph (lock/unlock) | 9.5 ms | - |

## Latency

- Retune on a running chain to 90% of the audible level change: 15, 32, 48, 24, 220, 33 ms
  (includes a 10 ms level meter). The 220 ms outlier is unexplained.
- The phone (Pixel 11 Pro Fold) over Tailscale on home Wi-Fi: 11, 76, 79, 143, 297, 338 ms round
  trip. This hop is outside any engine on the server and can exceed the 50 ms budget by itself.
- Each 0.25 s block came back 11,976 frames, not 12,500: the filter edges cost ~10 ms per block,
  which contiguous playback would have to absorb.

## Quality

Whisper on 16 s of left and right (flag 6 is spoken on the left, flag 7 on the right):

- JS engine: left "Flag 6 is Mike, Delta, Zulu, Hotel, Bravo"; right "flag seven is delta uniform
  golf alpha". Separated.
- GNU Radio `wfm_rcv_pll`: both flags in both channels, in 0.25 s blocks and in one continuous
  16 s pass.

**Cause, found: the capture is not standard, and the JS decoder matches the capture.** The
broadcast standard (ITU-R BS.450) puts the 38 kHz subcarrier in phase with sin(2θ) for a pilot
sin(θ). sigid transmits a cos(θ) pilot and a cos(2θ) subcarrier, which is 90° off; GNU Radio's
reference then lands in quadrature with L-R and recovers none of it. The JS decoder references
cos(2ψ), the capture's convention, and so do the test suite's own modulator and its tests.
Measured on a synthetic 400 Hz / 3 kHz L/R signal (`stereo_convention.py`, `.mjs`):

| decoder | standard (sin/sin) | sigid (cos/cos) |
|---|---|---|
| GNU Radio `wfm_rcv_pll` | 76.2 dB | -4.7 dB |
| SDR Flex JS `stereoDecode` | -4.6 dB | 73.4 dB |

GNU Radio's block is right. The JS decoder would give left = right on a real station, and the
CTF's broadcast slot would not separate in a standard receiver.

## What it means

Throughput favors GNU Radio clearly. Interactive latency on the box is mostly inside budget, and
the larger risk is the network to the phone, which any server engine shares. On quality the
reused block was the correct one and the hand-written one was not: its tests were written
against a signal with the same mistake. Every block still gets checked against a known answer
(ADR-0041), and the known answer has to come from the standard, not from our own modulator.
