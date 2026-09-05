# ADR-0016: Performance envelope — Pluto class now, ~60 MS/s tier later

**Status:** Accepted

## Decision

**v1 design target: ≤ 10 MS/s sustained**, set by PlutoSDR over USB 2.0 and every
dongle below it (RTL-SDR, Airspy, HackRF).

**Named future tier: ~40–61 MS/s** — USRP B205mini (USB 3.0, 61.44 MS/s, ~56 MHz)
and SignalHound BB60C/D (27 MHz IQ streaming, 40 MS/s). Not built now. Not
precluded either: the interfaces below are written rate-agnostic.

## Consequences at the v1 target

**Ring recording is comfortable.** At 10 MS/s:

| Format | Rate | 60 s |
|---|---|---|
| cs16 (default) | 40 MB/s | 2.4 GB |
| cf32 | 80 MB/s | 4.8 GB |

Any NVMe handles this. The ring is on by default and
[ADR-0005](0005-all-sources-are-time-indexed.md) holds unconditionally.

**The ring window is derived from a disk budget, not a fixed duration.** Default
budget 4 GB, one setting, user-adjustable — which yields ~100 s at 10 MS/s and ~25 s
at 40 MS/s without the user doing arithmetic. Consistent with
[UI law 9](../08-ui-principles.md#ten-laws): never ask what can be derived.

**GNU Radio handles the whole path.** At ≤ 10 MS/s, source → first tuner in GR with
VOLK is not close to a bottleneck. No native fast path is needed, which removes a
large chunk of work from M0–M3.

## Consequences at the future tier

Recorded now so they are not designed against by accident:

- **Ring recording becomes conditional.** 40 MS/s cs16 is 160 MB/s; 61.44 MS/s is
  245 MB/s. The ring must be able to record *decimated*, or be switched off, per
  source. The recorder interface therefore takes a rate/format policy from the
  start — it is not hardcoded to full rate.
- **The source→first-tuner path may need to bypass GR's scheduler.** Possible, but
  only once measured. Keeping the first tuner behind the tap boundary
  ([ADR-0004](0004-flowgraph-splitting-at-taps.md)) means this can be swapped without
  touching anything downstream.

## The device abstraction must not assume SoapySDR

This is the part most easily got wrong, and the named future devices force it:

| Device | Reached via |
|---|---|
| RTL-SDR, Airspy, HackRF | SoapySDR / gr-osmosdr |
| **PlutoSDR** | **libiio / gr-iio** — and it is *network-attached* even over USB |
| USRP B205mini | UHD (Soapy wrapper exists, native UHD is better) |
| **SignalHound BB60** | **Vendor SDK (`bb_api`) only** — not a SoapySDR device |

So: **SoapySDR is one source plugin among several, not the source layer.** The source
plugin interface is defined in our own terms (open, set rate/frequency/gain, stream
samples with timestamps, report capabilities) and SoapySDR is an implementation of it.
Baking SoapySDR into the source interface would make the BB60 impossible to add
without refactoring the layer.

Pluto being network-attached is a bonus that falls out of
[ADR-0001](0001-client-server-split.md): the worker can sit next to the radio and the
UI anywhere else, with no special support.

## Would change our mind

Acquiring a B205 or BB60 and finding the tier-2 numbers are needed sooner. The
recorder policy and source interface are the two places that keep that from being a
rewrite; everything else scales by decimating earlier.
