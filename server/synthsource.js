#!/usr/bin/env node
// A radio that is not a radio.
//
// It emits the same synthetic scene the in-tab engine has always drawn, as cf32 on
// stdout, paced to real time — so it is a radio as far as everything upstream of it is
// concerned. That buys two things worth having:
//
//   - The live path can be built and tested on a machine with nothing plugged into it,
//     including the parts that only happen after a while: the ring wrapping, scrubbing
//     back to a moment that has expired, a chain still running while its source moves.
//   - Anyone can see what the tool does without owning an SDR.
//
// It is paced rather than emitted as fast as possible on purpose. A generator running
// flat out fills a sixty-second ring in half a second and every timing question the
// live path has to answer disappears — which is exactly the wrong way to test it.

import * as scene from '../web/src/scene.js';

const sampleRate = Math.max(8000, Math.round(+process.argv[2] || 480_000));
const CHUNK = Math.max(1024, Math.round(sampleRate / 50));   // about 20 ms of audio-free time

let produced = 0;
const started = Date.now();

function tick() {
  // Catch up to wall-clock time rather than emitting a fixed amount per timer: timers
  // fire late under load, and a source that quietly runs slow makes every timing bug
  // downstream look like something else.
  const due = Math.floor((Date.now() - started) / 1000 * sampleRate);
  let owed = Math.min(due - produced, sampleRate);     // never burst more than a second
  while (owed > 0) {
    const n = Math.min(owed, CHUNK);
    const iq = scene.read(produced, n);                // interleaved Float32, a view
    const buf = Buffer.from(iq.buffer, iq.byteOffset, n * 2 * 4);
    if (!process.stdout.write(buf)) {
      // The reader is behind. Stop producing rather than growing a buffer forever —
      // a radio that cannot be kept up with drops samples, and so does this.
      produced += n;
      process.stdout.once('drain', tick);
      return;
    }
    produced += n;
    owed -= n;
  }
  setTimeout(tick, 10);
}

process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); });
tick();
