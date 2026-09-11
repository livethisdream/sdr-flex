# rtl_433 over OOK PWM

**Signal:** synthetic. 250 µs pulse is a zero, 500 µs is a one, 250 µs gap between
pulses, 6 ms between packets. Two 24-bit words (`b33566`, `caa699`) repeated four times,
with a little noise on the line.

**License:** CC0-1.0. Nobody transmitted this; `fixtures/make.mjs` drew it, deterministic
from a fixed seed, so a regenerated capture is byte-identical.

**Why this shape:** it is what a large part of the ISM band looks like, and it is the
shape rtl_433's own flex decoder describes directly. Using the flex decoder rather than
a named protocol means the fixture tests *the adapter* — conversion, resampling, the
pipe, the JSON parse — rather than testing whether one particular sensor's protocol is
implemented in whatever rtl_433 version happens to be installed.

**Expected:** one record, whose `codes` include `{24}4cca99` and `{24}3559a6` — the
complement of the transmitted words, which is rtl_433's polarity convention for this
modulation, not an error.
