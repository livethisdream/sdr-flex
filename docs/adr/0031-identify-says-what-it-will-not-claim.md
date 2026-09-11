# ADR-0031: `Identify` is a heuristic, so it is built around what it will not claim

**Status:** Accepted — implements [ADR-0017](0017-auto-manual-parameters.md)'s decoder
tier, over the adapters of [ADR-0013](0013-external-decoders-as-subprocesses.md)

## Decision

**One action on an ordinary node runs every decoder that could read the stream in front
of it, and reports what each one found.** It is `⟲ auto` for the question "what is
this": you should not have to know a 433 MHz burst is OOK PWM before the tool will tell
you anything about it. Its result is an ordinary node — picking a row builds the chain
that produced it — so a shortcut through the analyst product is not a second mode.

The mechanics that matter are all about the report being *readable*, not about running
the decoders, which is the easy half.

1. **What was not tried is part of the answer.** A decoder that is not installed, that
   takes the wrong kind of stream, or that wants bandwidth the capture never had is
   listed with the reason in plain words. "Nothing decoded this" and "nothing that could
   decode this was tried" are opposite answers and an empty list cannot tell them apart.

2. **An adapter says what "try everything" means for it.** multimon-ng defaults to three
   POCSAG rates because a default should be cheap; a speculative pass wants its whole
   `-a` list and should pay the CPU. Only the adapter knows that, so it is a field in
   the adapter table (`sweep`) rather than a rule in the planner. Running with no
   parameters, which is what the first version did, quietly asked every decoder for its
   least capable configuration — and then reported that AX.25 was not AX.25.

3. **A decode with almost nothing in it is not a decode.** Given OOK bursts and told to
   try everything, multimon-ng's Morse demodulator returns `E` — one dit, which is what
   a single noise blip looks like to it. A modem given any audio at all reports a
   carrier, a plausible bit rate and a respectable confidence, and hands back bytes: on
   real APRS audio minimodem scored 3.8 against 4.9 for a genuine Bell 202 decode, so
   confidence does not separate them. Both are shown, neither is counted, and each says
   why: "too little to be a message", "locked on but the bytes are not text".

4. **The window is bounded and stated.** Eight seconds ending at the playhead, or the
   pinned clip if there is one. Not the whole capture: this runs eight decoders rather
   than one, and eight resamples of a hundred seconds is minutes of waiting for an
   answer the first eight seconds would have given. The window is in the header because
   "nothing in these eight seconds" and "nothing in this capture" are different claims.

5. **One span read, one demodulation per way of demodulating, and narrow first.** An
   audio decoder wants 48 kHz at most, so the IQ is decimated once and shared — which is
   what the chain being proposed would do anyway. Doing it per decoder at full rate took
   seventeen seconds and most of a gigabyte on eight seconds of dongle-rate capture.

6. **Results arrive as they land**, on the per-call progress channel the waterfall and
   the exporter already use, and the panel draws the plan before any of them answers.
   A list that only grows reads as "nothing found" for the first second.

## Why

**Why a heuristic is allowed here at all.** Everywhere else this tool refuses to guess:
a parameter shows the evidence for its value, a decoder you cannot see inside is drawn
differently, a measurement is kept apart from a modulation guess. `Identify` is a guess
by construction — it is eight decoders asked "is it you?" — and the reason that is
acceptable is that it is *cheap and falsifiable*. Each row either produced text you can
read or it did not, and the next action is one click away in either case. The danger is
not that it guesses; it is that it guesses **and sounds certain**.

Which is why most of the decisions above are refusals. A ranked list with a false
positive at the top is worse than no list, because it sends you somewhere. The three
rules that cost the most to implement — the sweep settings, the thin-result tier, the
non-text rejection — exist only to keep the headline honest, and the first version of
this had none of them and confidently reported that a Manchester capture was Morse.

**Why the plan is a separate pure module.** `web/src/identify.js` takes adapter
descriptors and a stream and returns two lists. It runs no subprocess and reads no
samples, which means the skip reasons are testable without installing anything, and it
means the client can draw the plan without asking the server. It works on the
descriptors rather than the adapter table because the client must never reach into the
server's module ([ADR-0029](0029-the-client-owns-the-clock.md)).

**Why not rank by confidence.** Every one of these programs reports something like a
confidence and none of them is comparable to another's. rtl_433's is a CRC, direwolf's
is an audio level, minimodem's is a correlation — and minimodem's, measured on the one
false positive we have a golden fixture for, was three quarters of a true decode's.
Records found, with a floor under what counts as a record, is a cruder measure that
survives contact with five programs that were never designed to be compared.

**What this does not do yet.** It tries the external decoders. It does not try the
native chain — a Manchester slicer and a CRC search over the catalog is the obvious
next tier, and the fixture that is currently a clean negative
(`fixtures/manchester-crc`) is exactly the case it would catch. The report shape has
room for it: a row is a chain, not a decoder.

## Consequences

- A negative result is now worth something: eight decoders and 250-odd rtl_433 protocols
  ruled out in one action, with the ones that were not tried named.
- Adapters gained a `sweep` field, and the report carries the settings each row ran
  with, so a row is reproducible by clicking it.
- The cost is bounded by the window rather than by the capture, and measured:
  1.8 s for eight seconds at 250 kS/s, 4.8 s at 2.4 MS/s. The
  [budget](../08-ui-principles.md#interaction-budget) asks for 3 s and channel rates
  meet it; full dongle rate does not, and the number is written down rather than rounded.
- Finding this cost led to a real bug two layers down: the resampler's kernel width did
  not scale with the decimation ratio, so 2.4 MS/s → 250 kS/s was folding everything
  between about 125 and 250 kHz back into the band rtl_433 reads, 31 dB down. Fixed, and
  the fix is also four times faster. That one was never going to be found by reading.
