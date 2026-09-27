# M17 packet mode

One M17 SMS packet from `AB1CDE` to `N0CALL` reading *sdr-flex packet mode fixture* —
4FSK at 4800 symbols per second, narrowband FM at 2.4 kHz deviation, 96 kS/s complex on
144.800 MHz, the M17 calling channel in region 2. A quarter second of quiet in front of
the burst and half a second behind it, which is there on purpose: a span is chosen by
dragging on a spectrum, so it is nearly always wider than the signal in it, and the
symbol sync has to find the burst rather than fit itself to the silence around it.

**M17 has two modes and they are two programs.** Stream mode carries voice and
`m17-demod` reads it (`mobilinkd/m17-cxx-demod`). Packet mode carries SMS and arbitrary
data, and nothing in that build reads it at all — `m17-packet-decode` comes from
`M17-Project/M17_Implementations`, a separate upstream. A capture of one decodes as
nothing under the other, which is why there are two fixtures and two adapters.

**Nobody transmitted this.** `fixtures/make.mjs` runs `m17-packet-encode` — M17's own
packet modulator — and FM-modulates the RRC-shaped baseband it writes. The encoder is
the decoder's sibling, so the check is two-sided: if either half drifts, the other stops
agreeing. Implementing M17's convolutional coding, interleaving, scrambling and
Golay-protected link setup in JavaScript in order to test somebody else's decoder would
mostly test the reimplementation.

**What this fixture is for** is the one thing no other chain in the suite does:
`m17-packet-decode` does not read samples. It reads one float per symbol, already on the
symbol grid, because it correlates for a syncword rather than recovering a clock. So the
chain is spectrum → tuner → FM discriminator → **symbol sync** → decoder, and the node in
the middle is the one being tested. Leave it out and the conversion in front of the
decoder resamples 48 kS/s down to 4800 — which low-passes and decimates, and picks no
sampling instant at all. The decode then fails by finding nothing, which is the failure
this suite exists to catch.

The tuner's own decimation lands this at 32 kS/s rather than 48, so the symbol sync sees
6.67 samples per symbol and not a whole number. That is deliberate and not a wrinkle to
paper over: a tuner picks its decimation from the channel width (ADR-0017), so a
fractional samples-per-symbol is the ordinary case and the matched filter is built for
whatever it is handed.

On a machine without `m17-packet-encode`, `make.mjs` skips it and this committed capture
stands.

License: CC0-1.0.
