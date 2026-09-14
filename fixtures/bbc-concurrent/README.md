# BBC concurrent codes, two messages superimposed

Two 16-byte messages encoded independently and OR'd into one 1024-byte codeword, sent as
OOK NRZ at 600 µs a bit — about 1.67 kbit/s — on 433.92 MHz, sampled at 20 kS/s.

BBC (Baird, Bahn, Collins) is a keyless jam-resistant code. Each message bit is folded
into a rolling hash, the "glowworm", whose output picks one cell of a large sparse bit
field to mark. An n-bit message sets n marks and nothing else. Decoding replays that walk
as a depth-first search: a prefix is plausible only if the cell it names is marked, so
wrong branches die immediately.

**The channel is asymmetric, and that is the whole idea.** A mark can be added — by
noise, or by a jammer — and never removed. So superimposing two encoded messages is a
bitwise OR, and both of them still decode out of the result. That is the "concurrent"
part, and it is what this fixture exists to pin: a decoder that returns the first message
and stops looks completely healthy against any single-message test.

308 marks are set here out of 8192 cells — 3.8% density.

## Why it is so slow

Two constraints met in the middle.

The AM detector's post-detection filter is fixed at 40 µs, so a symbol has to be several
times longer than that or the edges smear together. And 8,192 chips of codeword is a lot
of symbols, so the capture has to stay small enough to commit. Twenty kS/s with a 600 µs
symbol gives a two-sample filter against a twelve-sample symbol, and 196 kB.

Plain NRZ rather than Manchester for the same reason — it halves the transitions and so
halves the capture. The usual objection is that a 96%-zero codeword is two hundred idle
bit periods at a stretch with no clock in them, and it does not bite: the NRZ symbol
estimator scores every run as a whole number of symbols rather than assuming the shortest
run is one.

## Something measured while building it

Run this same chain at 500 µs instead and the slicer hands back a codeword with **23
marks added and none dropped** — and both messages still decode. That is not the fixture
being lucky. It is the channel model the code was designed for, visible in a slicer's
ordinary noise rather than in a jammer.

## Provenance

The encoder is `encode()` in `web/plugins/bbc.js`, so this regenerates byte for byte from
`fixtures/make.mjs` with nothing installed. It has been checked against the reference
implementation — [xeno00/gr-bbc](https://github.com/xeno00/gr-bbc), whose pure-Python
codec imports nothing from GNU Radio — and produces identical codewords byte for byte;
`web/test/bbc.test.mjs` runs that comparison when `SDRFLEX_GRBBC` points at a checkout
and skips it loudly otherwise. The glowworm is pinned against upstream's published check
value for the hash of the empty string, which needs no checkout at all.

The algorithm is Baird, Bahn and Collins'; the GNU Radio implementation is James
Morrison's and is GPL-3.0-or-later. Nothing of it is vendored here — `bbc.js` is an
independent port and these bytes are its output.

**Nobody transmitted this.** Generated from a fixed seed.

License: CC0-1.0.
