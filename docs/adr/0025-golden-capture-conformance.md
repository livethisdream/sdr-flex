# ADR-0025: A demod or decoder ships with a golden capture, or it does not ship

**Status:** Accepted

## Decision

Every demodulator and every decoder — native or external — ships with four things, and
CI enforces all four:

1. A **golden capture**: a short SigMF file, committed, with its license and a note
   saying where the signal came from.
2. An **expected record set**: the exact output, committed next to it.
3. A **conformance run**: replay 1 through the operation, diff against 2.
4. An **estimator assertion**: `auto`, given only the capture, lands on parameters that
   produce 2 — nobody hands it the symbol rate.

An operation that cannot pass 4 still ships, but is **marked in the palette as needing
its parameters set**, and says which ones.

## Why

The coverage strategy (ADR-0013) means the number of decoders grows faster than anyone's
ability to test them by hand. Fifty adapters tested by launching the app fifty times is
not a strategy, and the failure mode is silent: an upstream release changes a flag, one
adapter stops producing records, and nobody notices until a user reports that this tool
is unreliable. For a tool whose whole pitch is "wraps the things that already work", that
report is fatal.

Point 4 is the one that carries the design. The premise of the tool is that defaults are
derived and show their evidence (ADR-0017); a decoder that only works once you have told
it the symbol rate, the sync word and the polynomial works for the person who already
knew the answer. Asserting the estimator — not just the decoder — is what keeps the
premise true as coverage grows, and it is the check most projects skip.

Fixtures also make the adapters cheap in the way the strategy claims. The second time
someone adds a decoder, the work is a manifest and a capture, because the harness that
replays and diffs already exists.

## Cost

- **Corpus size.** Captures live in `fixtures/`, one directory per protocol, capped at a
  few hundred kB — a couple of frames, not a recording session. Anything larger is a link
  and a checksum.
- **Provenance care.** Captures are signals somebody transmitted; each needs a license
  and a source note, and anything identifying gets excluded rather than trimmed.
- **External binaries in CI.** The suite needs `rtl_433`, `multimon-ng` and friends
  installed, pinned by version. Their absence must skip loudly, never pass quietly.
- Upstream version drift will break conformance runs, on purpose. That is the alarm
  working.

## Alternatives

- **Unit tests over synthetic signals.** Cheap, and they test our own assumptions rather
  than the signal. The M0 scene generator is exactly this, and it is useful — but a
  decoder that only works on the signal we generated is not evidence of anything.
- **Manual acceptance.** Works to about five decoders.

## Would change our mind

If capture licensing turns out to be an obstacle for a protocol worth having, that
protocol can ship with a synthetic capture, clearly labeled as synthetic — a weaker
guarantee, honestly marked, rather than none.
