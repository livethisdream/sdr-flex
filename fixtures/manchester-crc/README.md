# Manchester frames with a CRC

**Signal:** synthetic. OOK-modulated Manchester at 500 µs per symbol, a 24-bit
alternating preamble, sync word `2d d4`, an ASCII payload, and a CRC-16/CCITT-FALSE.
Three payloads (`TEMP21`, `TEMP23`, `HUM47`) repeated three times, with dead air between
frames so the framer has to work out where each one ends. Noise on the line.

**License:** CC0-1.0. Drawn by `fixtures/make.mjs` from a fixed seed.

**Why this shape:** it is the ordinary case for a cheap sensor, and it exercises the two
things the tool claims that most decoders do not — deriving the symbol period from the
signal, and identifying the CRC by trying the catalog rather than being told. Dead air
between frames is deliberate: it is what a real capture looks like, and it is what makes
the framer search for where the frame ends rather than assuming the next sync marks it.
