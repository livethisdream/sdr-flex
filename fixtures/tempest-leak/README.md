# The same screen, the way a receiver actually gets it

40 × 72 pixels visible, 3.77 samples a pixel, **196.04 samples a line** — fractional on
purpose — 84 lines a frame, 6 frames. 8 MS/s complex on 300 MHz. The screen has `SDR`
on it.

`tempest-raster` next door is the clean case, built to show the mechanism: one sample a
pixel, a whole number of them a line, three identical frames. This one is built to show
what the mechanism has to survive, and every difference is something no real capture
avoids.

**What leaks is a harmonic of the pixel clock, not the clock.** A monitor radiates
whichever harmonic the cabling happens to resonate at, and that is above any receiver's
sample rate, so it folds back into the passband. Folded, it correlates with itself far
better than the picture correlates with itself — on the 20 MS/s capture this fixture
imitates, 0.71 against 0.37 — and a period search that does not deal with it finds the
pixel clock rather than the line. Here the 13th harmonic folds to a little over two
samples a cycle, against a line of 196: a ratio of about 1:90, where the real capture's
was 1:164.

**A line is a fractional number of samples.** Nothing locks the monitor's clock to the
radio's, so the ratio is whatever it is, and a period rounded to the nearest sample
shears the picture a little further with every line.

**The frames walk, and not in a straight line.** Same reason one level up: by the sixth
frame the picture is a couple of samples from where the first one was, and a clock that is
not disciplined to anything does not get there evenly. The steady part of that is absorbed
by measuring the line period across a whole frame, which is the same error seen from
further away. The rest is what aligning the frames before stacking them is for.

**What this fixture does *not* show is as much the point as what it does.** On the real
leak, aligning the frames was worth ninety times the horizontal detail. Here it is worth
about half: what folds back into the passband is near two samples a cycle, so the column
correlation used to measure the alignment has a peak every two samples, and picking the
wrong one is worse than not having looked. Both cases are real and neither is knowable in
advance, which is why the node builds the stack both ways and keeps the sharper — see
ADR-0041. This fixture is the half of that decision that would otherwise never be tested,
because the capture that motivated it cannot be committed.

Still synthetic, and for two reasons rather than one. ADR-0025 is about provenance and
licensing; a real TEMPEST capture is also, by definition, a picture of somebody's actual
screen, which is the last thing that belongs in a public repository.

**And the limit, stated rather than discovered later.** The search smooths over a quarter
of the shortest line it will consider, which is what removes the folded harmonic. A
harmonic that folds to within roughly twenty times the line rate is not separable that way
and will still win — it is, at that point, indistinguishable from the line's own twentieth
harmonic. Nor does any of this find a moving picture: the frame period is found by the
frame repeating, and a frame that is never the same twice does not repeat. The node says
so rather than averaging the difference into a grey smear, which is tested next door.

License: CC0-1.0.
