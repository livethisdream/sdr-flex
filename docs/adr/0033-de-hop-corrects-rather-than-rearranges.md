# ADR-0033: A de-hopper corrects the signal; it does not rearrange it

**Status:** Accepted — a consequence of [ADR-0005](0005-all-sources-are-time-indexed.md)
that only became visible when something tried to break it

## Decision

**De-hopping mixes each sample by the channel frequency in effect at that moment, and
changes nothing else.** Same length, same sample rate, same time base as its parent. The
dead air between dwells stays dead air.

The obvious alternative — cut each dwell out, drop the retune gaps, stitch what is left
end to end — is wrong twice over, and it is worth writing down which two because both
were implemented before either was noticed.

1. **It invents a time base.** Samples that were milliseconds apart become adjacent, so
   the output's clock is no longer the capture's. Every node in this graph reads a window
   that ends at a moment (ADR-0005), and a node whose seconds mean something different
   from its parent's breaks that for everything downstream of it. The first symptom was
   a payload that decoded with four thousand leading zeros in front of it, because a
   short stream asked for a long window gets right-aligned inside it.

2. **It destroys the symbol clock.** A dwell edge is known only to within one analysis
   step, which at any useful frequency resolution is a symbol or two. Cutting there loses
   a fraction of a symbol at every hop; the clock walks, and the slicer downstream reads
   a payload that decodes to nothing. It is a convincing failure — the preamble comes
   back perfectly and the message is mush.

Correcting in place has neither problem. It also produces something a person can look at:
the de-hopped spectrum is a single channel with gaps where the transmitter was retuning,
which is the truth about the signal rather than a seam hidden inside it.

## Why the hop map and the de-hopper are one capability

Because the analyst's question is one question. "Where did it go" and "what did it say"
have the same answer behind them — the list of dwells — and a tool that answered only the
first would leave the payload on the table, while one that needed the sequence supplied
would be a tool for somebody who already had it.

So the dwells are found once, from the signal, and both nodes read them. The hop map
reports the sequence; the de-hopper follows it and hands the ordinary demodulator and
slicer a signal they already know how to read. Nothing downstream of the de-hopper knows
that any hopping happened, which is the whole point: it is the same FM demod and the same
NRZ slicer that read every other signal in the tool.

Finding the dwells needed three things that are not obvious:

- **Cluster the channels before grouping in time.** Grouping by "the peak has not moved
  much" is the natural first attempt and it fails on any modulated signal, because the
  modulation moves the peak too. An FSK payload with a 2.4 kHz shift split every dwell at
  each bit transition and turned 24 dwells into 65.
- **Detect on the peak-to-median ratio, not the level.** A hopper that dwells back to
  back never goes quiet, so there is no second population for a level threshold to find,
  and Otsu will confidently cut a single population in half — it marked 59% of a
  continuous transmission as noise.
- **Refine every boundary against the instantaneous frequency.** The FFT gives the edge
  to one step; the instantaneous frequency gives it to a few samples, and the difference
  is 650 corrupted samples per capture against seven.

## What this cost elsewhere, which is the interesting part

Making one hard signal work found three bugs that had nothing to do with hopping and
everything to do with every other signal:

- **`otsuThreshold` ranged its histogram between the minimum and the maximum.** Seven bad
  samples in eighteen thousand stretched that range twentyfold, packed the entire signal
  into two bins, and returned a threshold below all of it. Any capture with a click in it
  had the same shape. It now ranges by percentile.
- **`estimateNrzSymbol` assumed the shortest run was one symbol.** A low percentile
  instead of the minimum survives one glitch and not a handful. It now scores every
  candidate period against every run, weighted by length, then refines by total elapsed
  time over total symbols — which is how you measure a clock, and which is three times
  more accurate than the least-squares fit that was the obvious alternative.
- **Auto parameters were derived from a window that could lie outside the medium.** A
  quarter of a second ending at the playhead is right on a long capture; on a 90 ms one
  with the playhead at 50 ms, four fifths of it is before the recording starts, and the
  estimator reports "looks unmodulated" about silence.

None of those would have been found by reading the code, and all three are the kind of
thing that makes a decode quietly worse rather than visibly broken.

## Consequences

- `Hop map` reports the sequence first and then one row per dwell, with the dwell time,
  channel spacing and channel count derived and carrying their evidence (ADR-0017).
- `De-hop` takes a channel parameter, so a hopper you only want one channel of is one
  setting rather than a different tool.
- A hopper with real dead air between dwells shows it as silence. That is honest, and it
  means a payload that genuinely spans the gaps is not recoverable — which is true of the
  signal, not of the tool.
- `fixtures/fhss-6ch` carries a payload that runs continuously across the dwells, and the
  suite checks the control: the same chain without de-hopping first recovers nothing.
