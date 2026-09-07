# Baking In Demods and Decoders

[Reuse](07-reuse.md) says *what* to borrow and why. This says **what gets built, in
what order, and what has to be true before each one counts as done**.

The shape of the answer: a small number of native detectors we own, a composable
bit-level chain borrowed from URH's model, a manifest-per-program adapter layer for the
Unix decoders, and a conformance suite that makes adding the fiftieth one as cheap as
the fifth. Coverage comes from the adapters. Credibility comes from the suite.

---

## The layers, and who owns each

A decode is five steps, and they fail for different reasons. Keeping them as separate
nodes is what makes a half-working chain diagnosable instead of a black box that
returns nothing.

```
iq  ──▶ detect ──▶ real ──▶ recover ──▶ symbols ──▶ interpret ──▶ bits ──▶ frame ──▶ events
        AM/FM/            clock, slice            Manchester,           preamble,
        SSB/CW            threshold               differential,         sync, length,
                                                  invert, NRZ           CRC, endian
```

| Layer | Who writes it | Why |
|---|---|---|
| **detect** (AM, FM, SSB, CW) | Us | Trivial in GR, and we want every stage visible. Borrowing an opaque demod here buys nothing. |
| **recover** (clock, slicer) | Us, over liquid-dsp primitives | This is where analysis actually happens — the thing an analyst adjusts. |
| **interpret** (line codes) | Us, modeled on URH | Five tiny nodes cover most of what the field calls "encodings". |
| **frame** (sync, CRC, fields) | Us | Nobody else's abstraction fits, and it is where annotations attach. |
| **whole protocols** | Borrowed | 250 device decoders is a career, not a milestone. |

The rule that falls out: **we own everything up to a named protocol, and borrow every
named protocol.** `rtl_433` is not competing with our slicer — it is what you reach for
when you do not want to build one.

---

## Wave 1 — the native detectors (M3)

Five operations, one implementation family. Each takes `iq` from a channel and produces
`real`; the tuner ahead of it already did the filtering, so these are detectors, not
"demodulators" in the SDRangel sense that bundles channelizer, AGC, squelch and audio.

| Op | Estimator that ships with it | Evidence it shows |
|---|---|---|
| `core.am_envelope` | *(M0)* Otsu threshold, pulse-length symbol period | "two clean pulse-length clusters" |
| `core.fm_discriminator` | *(M0)* 98th percentile of the instantaneous frequency | "the 98th percentile of the instantaneous frequency" |
| `core.ssb` | *(M0)* sideband from spectral asymmetry about the center | "energy 38 dB higher above center" |
| `core.cw` | *(M0)* carrier offset from the strongest bin, parabolically interpolated | "the strongest bin, 27 dB over the floor" |

Deviation is measured off the discriminator rather than run backwards through Carson's
rule, because Carson needs the modulating frequency and that is the thing you do not
know. The confidence test is the one worth writing down: a modulated carrier's
instantaneous frequency is *bounded* — it stays in a narrow band — while noise sprays
across the whole channel. The tempting test, peak well above the median, is exactly
backwards: a single tone at full deviation gives a ratio of about 1/0.64, because the
mean of |sin| is 2/π, so anything demanding a large ratio rejects the clean signals and
accepts the noise.

Squelch, AGC and audio gain are **parameters of the audio sink**, not of the detector.
Putting them on the detector is what makes SDRangel's demod panels twenty controls deep.

The sink is a **node** — `core.audio`, reached from the same menu as everything else
([ADR-0027](adr/0027-sinks-are-nodes.md)). It was first built as a speaker button on the
transport, on the argument that listening is a subscription like the spectrum view is.
That was wrong: a view renders what a node produced, while a sink consumes it and takes
it out of the graph, which is what a terminal block is. The evidence arrived within a
day — the button crowded the transport until the scrubber was pushed off a phone screen,
which is exactly what happens when something that belongs in the model gets bolted onto
the chrome.

**Done when:** dropping a box on an FM broadcast station and hitting play produces audio
with no other interaction, and the deviation readout says where it got its number.

**Status:** running in the M0 mock, with the sink as a `core.audio` block. Two channels
with a Listen block each is a working mixer, which was never designed — the graph
already expressed it. The scene grew a target for each detector — a keyed
carrier, a two-tone USB signal, and an NBFM tone at ±3 kHz with a slow warble so the
deviation readout visibly moves — and the estimators are asserted against them, including
the negative case: pointed at empty spectrum, FM reports "looks unmodulated" and SSB
reports "both sides look alike — this is a guess" rather than a confident wrong answer.

---

## Wave 2 — the transparent bit chain (M6, pulled early where cheap)

This is the URH model as composable nodes ([ADR-0024](adr/0024-composable-decode-chain.md)).
Each is a handful of lines and each is independently inspectable.

**Recovery** (`real` → `symbols`)

- `core.clock_recovery` — Gardner or M&M over liquid-dsp; `auto` estimates symbol rate
  from pulse-length clustering (already implemented in M0's slicer) and from the
  autocorrelation of the envelope, and reports which agreed.
- `core.threshold` — Otsu, hysteresis, or a manual level; the M0 slicer's threshold
  estimator generalizes here.
- `core.fsk_slice` / `core.psk_slice` — 2-, 4-level and BPSK/QPSK decisions.

**Interpretation** (`symbols` → `bits`)

- `core.manchester` — IEEE or Thomas convention; `auto` picks by counting mid-bit
  transitions and reports the margin.
- `core.differential` — NRZI and plain differential.
- `core.invert`, `core.reverse` — one line each, and between them they rescue a
  surprising fraction of "it almost decodes".

**Framing** (`bits` → `events`)

- `core.framer` — preamble, sync word, length field, endianness, CRC. `auto` searches
  common sync words and brute-forces the standard CRC catalog (the RevEng approach) over
  the aligned bits; when a polynomial checks out across several frames, that is strong
  evidence and the node says so.

Each node is worthless alone and the chain is the product. This is the half of the tool
that `rtl_433` cannot be, and it is the reason to keep both.

**Done when:** an unknown OOK remote, captured cold, reaches a repeating frame with a
verified CRC without anyone typing a number — and every step can be opened and argued
with.

---

## Wave 3 — the adapter layer (M4.5, then M5)

One manifest each ([ADR-0013](adr/0013-external-decoders-as-subprocesses.md),
[shape](07-reuse.md#adapter-shape)). Ordered by coverage per line of manifest.

| # | Program | Buys | Notes |
|---|---|---|---|
| 1 | **rtl_433** | 250+ ISM protocols | cu8 IQ on stdin, JSON lines out. The single best ratio in the project. |
| 2 | **multimon-ng** | POCSAG, FLEX, AFSK, DTMF, EAS, ~15 | raw s16 audio; sits after our own FM detector, which is the first real test that the two halves compose |
| 3 | **dump1090** | ADS-B | wants 2.4 MS/s cu8 — the first adapter whose rate constraint the engine has to honor upstream rather than by resampling |
| 4 | **direwolf** | APRS, AX.25 | KISS over TCP rather than stdout: the first adapter with a socket transport |
| 5 | **dsd / dsd-fme** | DMR, P25, NXDN, D-STAR | audio in, audio + metadata out — the first adapter that returns a *stream* as well as records |
| 6 | **acarsdec**, **redsea**, **AIS** | ACARS, RDS, AIS | after the transports above, these are copies of patterns already proven |

Each entry above names the *new mechanism* it forces, which is the real reason for the
order: by the sixth adapter, adding one is a manifest and a fixture.

Then **gr-satellites** as a single dependency (~100 decoders) and **Identify** over
everything installed.

---

## What "baked in" has to mean

An operation is not shipped because it runs once on the developer's laptop.
[ADR-0025](adr/0025-golden-capture-conformance.md) makes the gate concrete: every demod
and decoder ships with

1. a **golden capture** — a short SigMF file, committed, with a license and a provenance
   note saying where the signal came from;
2. an **expected record set** — the exact output, checked in;
3. a **conformance run** in CI that replays 1 through the operation and diffs against 2;
4. an **estimator assertion** — that `auto`, from the capture alone, lands on parameters
   that produce 2 without help.

Point 4 is the one that matters and the one most projects skip. A decoder that works
only once you have told it the symbol rate, the sync word and the polynomial is a
decoder that works for the person who already knew the answer. The whole premise of
this tool is that the defaults are derived and show their evidence
([ADR-0017](adr/0017-auto-manual-parameters.md)); a decoder that cannot participate in
that is second-class and is marked so in the palette.

**Corpus:** captures live in `fixtures/`, one directory per protocol, capped at a few
hundred kB each — a couple of frames, not a recording session. Anything larger is a
link and a checksum, not a commit.

---

## The order, and why

1. **Wave 1** first, because audio is the thing that makes the tool feel finished, and
   because `real` is the input every adapter after `rtl_433` wants.
2. **rtl_433** immediately after — out of order relative to the plugin system, because
   sixty lines of manifest buy 250 protocols and nothing else in the project has that
   ratio.
3. **Wave 2** next, because it is the answer to rtl_433's failure case, and the failure
   case is the interesting one. It also converts the estimator machinery from a nice
   detail into the product.
4. **The rest of the adapters** last, each chosen for the transport or constraint it
   introduces rather than for the protocol it decodes.

The temptation is to do 4 first, because each adapter is a day and the protocol count
goes up fast. Resist it: a tool that can only run other people's decoders is a launcher,
and the transparent path is the half nobody else has.

---

## Open questions

- **Audio out.** Wave 1 needs a sink and a mixer. Web Audio in the browser client,
  something else for a native client — the protocol has to carry audio as just another
  subscribed stream, or the two clients diverge. Needs a decision before M3 starts.
- **Where estimators run.** Brute-forcing a CRC catalog over a few hundred frames is
  milliseconds; searching sync words over a minute of ring is not. Estimators may need
  to be interruptible jobs with progress, not synchronous calls.
- **Protocol packs.** Whether a decoder, its manifest and its fixtures ship as one
  versioned unit, and how a third party publishes one, is
  [ADR-0026](adr/0026-decoder-packs.md) — deliberately deferred until three adapters
  exist to generalize from.
