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
- GNU Radio `wfm_rcv_pll`: both flags in both channels, in 0.25 s blocks (30 ms or 1 s margins)
  and in one continuous 16 s pass. Not separated. Cause not yet known: parameters (it assumes
  75 kHz deviation), the block in this version, or the capture.

## What it means

Throughput favors GNU Radio clearly. Interactive latency on the box is mostly inside budget, and
the larger risk is the network to the phone, which any server engine shares. The stock stereo
receiver failed on a real signal, so "reuse GNU Radio" still needs each block checked against a
known answer before it replaces the JS version (ADR-0041: build both and measure).
