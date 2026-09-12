# A screen leaking

96 × 64 pixels visible, 120 samples a line, 72 lines a frame, three frames, amplitude
modulated. 200 kS/s complex on 300 MHz. The screen has `SDR` on it.

**Nobody transmitted this, and it is not a picture of anybody's monitor.** That second
part matters more than usual here: a real TEMPEST capture is, by definition, a picture of
somebody's actual screen, which is the last thing that belongs in a public repository —
ADR-0025 is about provenance and licensing, and this is the case where it is also about
not publishing what was on someone's desk.

Nothing about the resolution is recorded where the analyzer can read it. The blanking
intervals — where the beam is flying back and nothing is drawn — are the only structure
in the signal, and they are what makes the line period findable at all.

The picture is deliberately readable. A raster folded at a period that is wrong by a
fraction of a sample shears a little more with every line, so a fixture with text on it
fails where you can see it rather than as a number that has quietly moved.

**A caveat worth stating plainly.** This proves the mechanism, not that it will read a
real leak. A genuine TEMPEST capture has an unknown pixel clock, a harmonic rather than a
baseband carrier, interlace, and a receiver that is not synchronized to any of it —
which is why `gr-tempest` exposes five live knobs a person turns until the picture locks.
This fixture is the case where all of that is already right.

License: CC0-1.0.
