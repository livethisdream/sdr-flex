# M17 over FM

One M17 stream-mode transmission from `AB1CDE` to `N0CALL` — 4FSK at 4800 symbols per
second, narrowband FM at 2.4 kHz deviation, 96 kS/s complex on 144.800 MHz, the M17
calling channel in region 2.

**Nobody transmitted this, and there is no recorded speech in it.** `fixtures/make.mjs`
feeds a fixed tone pattern to `m17-mod` — M17's own modulator — and FM-modulates the
baseband it produces. The vocoder is happy to encode tones, the link setup frame is what
this fixture is about, and a recording of a person saying something is exactly the kind
of thing ADR-0025 exists to keep out of a repository.

Like the LoRa fixture, the encoder is the decoder's own. The alternative is implementing
M17's convolutional coding, interleaving, scrambling and Golay-protected link setup in
JavaScript in order to test somebody else's M17 decoder — which would mostly test the
reimplementation. Two-sided instead: if either half drifts, the other stops agreeing.

The chain is the whole path a person walks — spectrum, tuner, FM discriminator, decoder —
so this fails if the tuner or the decimator regresses, and it fails the way a user would
see it: a decoder that suddenly says nothing.

On a machine without `m17-mod`, `make.mjs` skips it and this committed capture stands.

License: CC0-1.0.
