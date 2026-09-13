# ADR-0035: A spreading code is generated, not tabulated — and the search says what it skipped

**Status:** Accepted

## Decision

**The code library is generators, not tables.** m-sequences come from running every
candidate LFSR and keeping the ones with a full period; Gold sets come from decimating a
preferred pair; Walsh rows come from the Hadamard recursion. Six hundred and seventy-odd
codes, about eleven milliseconds, no numbers typed in.

**Despreading is one node that produces bytes**, not a despreader followed by a slicer.
With the code known, the sign of one correlation over one code period *is* one bit;
splitting it would put a node in the chain whose input is one sample per symbol, which
is not a waveform and has nothing to slice. This is the one place [ADR-0024](0024-composable-decode-chain.md)'s
single-purpose rule folds two stages together, and the reason is that they were never
two stages.

## Why generate

Three reasons, in the order they matter.

**A table can be wrong and never say so.** A generator that produces a sequence of period
2^n−1 is either primitive or it is not, and the test is three lines — the suite asserts
that every m-sequence has an off-peak autocorrelation of *exactly* −1, which is the
property that defines one. It also checks the count of primitive polynomials at each
degree against Euler's totient of 2^n−1 over n, which is a fact about finite fields
rather than a restatement of the code.

**The generator knows why a code is what it is.** So a hit reports `x^7 + x^4 + 1` rather
than "code 47". The polynomial is the thing somebody writes down; a row number in a table
they do not have is not an answer.

**There are a lot of them.** Every primitive polynomial of degree 11 is 176 codes, and
nobody is typing those in.

## The order the unknowns have to be solved in

A spread signal has three: chip rate, chip phase, and which code. They are not
independent, and the order is forced.

1. **Chip rate, from the transitions.** It needs nothing else — the polarity of
   `Re(x[i]·conj(x[i-1]))` is a ±1 waveform following the chips, and the NRZ symbol
   estimator already reads exactly that shape. The chip phase falls out of the same
   transitions as the circular mean of where they landed.
2. **Carrier offset, by squaring.** `(±1 · e^{jφ})²` is `e^{j2φ}` either way, so the data
   disappears and what remains is a tone at twice the offset.
3. **The code, by correlation over chips.**

Step 2 cannot be skipped or deferred, and this is the finding worth recording: **a
correlation across a code period is a coherent integration across it.** At 900 Hz and 60
kchip/s a 127-chip integration spans two full rotations and sums to nothing. The right
code then scores no better than any wrong one, and the search reports — quite correctly,
and quite uselessly — that this is not a code it knows. The first implementation did
exactly this. `web/test/dsss.test.mjs` keeps it as an assertion rather than a memory.

Doing it over *chips* rather than samples is what makes the search finish: through the
transform it is three passes of N log N per candidate with the data's transform shared
across every code of the same length, against L² per code per period done directly.
Five hundred and fifty-seven codes in about a second.

## Peak against its own sidelobes, not against a scale

The obvious score — correlation as a fraction of a perfect match — does not compare
across lengths. A Barker 7 correlates with noise at 1/√7, which is 0.38, and next to a
noisy 127-chip hit at 0.35 it wins and is wrong.

So the statistic is **peak against the same code's own other offsets**. A wrong code has
no offset it prefers, so its peak sits about where its average does; a right code peaks
by roughly √L. That means the same thing for a 7-chip word and a 1023-chip one.

It has one precondition, found the hard way: **a candidate has to fit several times over
or it is not tried.** The best of 2047 noisy numbers is always a big one — a length-2047
m-sequence measured over two periods scored 6 against a capture of something else
entirely and beat the code that was actually there.

## What it will not claim

Following [ADR-0031](0031-identify-says-what-it-will-not-claim.md), the report is built
around the two things a search usually leaves out.

**Walsh rows are in the catalog and out of the sweep.** H(2n) is built from H(n), so row
*i* of Walsh-32 repeated twice **is** row *i* of Walsh-64. A correlator handed a Walsh-32
signal matches a Walsh-64 row about as well, and which one wins depends on the data bits
rather than on the code. There is no measurement that separates them. This is not a
reason to drop Walsh — it is how IS-95 separates users, and it works there because it
sits on top of a PN sequence that supplies the timing, which is to say the ambiguity is
resolved by already knowing where the code starts. A search is exactly the case where you
do not. So: name one and it is used, sweep and it is not, and the report says which.

**Codes too long to repeat in the span are named rather than silently dropped**, with how
many periods were available and how many were needed.

**The polarity is a coin and is labeled as one.** BPSK does not say which sign is a one.
`auto` picks whichever reads as printable text and reports the margin it chose on; it is
the same weak test the external decoder runner uses, where it is grounds to *refuse* a
result rather than accept one, and here it decides between two otherwise identical
candidates.

## The limit, stated rather than implied

Twenty-one decibels of processing gain sounds like it should read a signal well under the
noise. It does not, and the reason is structural: **the chip timing is estimated before
any despreading and has no gain behind it.** Below about 0 dB per chip the timing goes
first and everything follows. The suite records the measured limit — clean decodes at
+6 dB and +2 dB per chip, nothing at −4 dB — as an assertion, so it is a number that can
change on purpose rather than a claim nobody checked.

Fixing it properly means a joint acquisition search over code, timing and frequency
together, which is a different and much larger machine. That is a real gap and it is
written here rather than left for somebody to discover.

## Consequences

- `Despread (DSSS)` appears in the palette under **Decode** on any IQ node, next to
  rtl_433 and LoRa.
- Its output is bytes, so the ordinary framer reads it and nothing downstream knows where
  the bytes came from — which `fixtures/dsss-m127` asserts by ending its chain in
  `core.framer`.
- `chipRate`, `code`, `offsetHz` and `invert` all arrive derived and carrying their
  evidence (ADR-0017), and `code` also carries what was not tried.
- Pinning a code by name skips the search: `m127/0x48`, `gold63/17`, `walsh32/13`,
  `barker11`. That is also the only way to use a Walsh row.
- A code is found, or it is not. There is no partial answer — but a correlator always
  produces *something*, so the bytes come back either way and the evidence for them is
  the peak, which is flat when there is nothing there.
