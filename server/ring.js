// The ring recording, which is what makes a radio a medium.
//
// ADR-0005 is the decision this file implements: every source is a time-indexed,
// randomly-addressable medium, and a live source becomes one by being written down as
// it arrives. That is the difference between this and GQRX — you can scrub back into
// what just went past, draw a time box on it, and re-run a chain over history without
// recapturing. None of that works on a stream; all of it works on a file.
//
// So the ring is a file of fixed size that wraps. Absolute sample index `i` lives at
// slot `i % samples`, forever, and the window currently on disk is the last `samples`
// of whatever has been written. Downstream code addresses samples by absolute index
// and never learns that the storage is circular — except at one edge, which matters:
// asking for something that has already been overwritten is an error, not zeros. A
// file's past is permanent and its future does not exist; a ring's past expires. That
// asymmetry is real and pretending otherwise would silently show the wrong signal.

import fs from 'node:fs';
import { FORMATS } from '../web/src/capture.js';

export class Ring {
  /**
   * @param path      where to keep it
   * @param format    one of capture.js's FORMATS — what the radio emits
   * @param seconds   how much history to keep
   */
  constructor({ path, format, sampleRate, centerHz, seconds = 60, label = 'radio' }) {
    this.path = path;
    this.format = format;
    this.spec = FORMATS[format];
    if (!this.spec) throw new Error(`unknown sample format ${format}`);
    this.sampleRate = sampleRate;
    this.centerHz = centerHz;
    this.label = label;
    this.live = true;

    this.samples = Math.max(1, Math.floor(seconds * sampleRate));
    this.bytes = this.samples * this.spec.bps;
    this.head = 0;              // absolute index one past the newest sample written
    this.dropped = 0;           // samples the writer could not keep up with

    // Allocated up front at full size. A ring that grows is a ring that fragments the
    // disk and surprises you at 3 a.m. when the volume fills; better to fail now.
    this.fd = fs.openSync(path, 'w+');
    fs.ftruncateSync(this.fd, this.bytes);

    this._cache = { start: 0, len: 0, data: null };
  }

  close() {
    if (this.fd == null) return;
    fs.closeSync(this.fd);
    this.fd = null;
    try { fs.unlinkSync(this.path); } catch { /* already gone */ }
  }

  /** The absolute sample indices still on disk, as [first, onePastLast). */
  window() {
    return [Math.max(0, this.head - this.samples), this.head];
  }

  /** The same, in seconds since the recording started. */
  windowS() {
    const [a, b] = this.window();
    return [a / this.sampleRate, b / this.sampleRate];
  }

  get durationS() { return this.head / this.sampleRate; }

  /**
   * Append raw bytes from the radio.
   *
   * Partial samples at the end of a chunk are kept and prepended to the next one: a
   * pipe hands over whatever happened to be in the buffer, and a two-byte cu8 sample
   * split across two reads would otherwise swap I and Q for the rest of the recording.
   */
  write(buf) {
    const bps = this.spec.bps;
    if (this._tail) { buf = Buffer.concat([this._tail, buf]); this._tail = null; }
    const whole = Math.floor(buf.length / bps);
    if (whole * bps < buf.length) this._tail = Buffer.from(buf.subarray(whole * bps));
    if (whole === 0) return 0;

    let off = 0, left = whole;
    while (left > 0) {
      const slot = (this.head + off) % this.samples;
      const run = Math.min(left, this.samples - slot);       // up to the wrap point
      fs.writeSync(this.fd, buf, (off) * bps, run * bps, slot * bps);
      off += run;
      left -= run;
    }
    this.head += whole;
    this._cache.data = null;      // history just moved under anything cached
    return whole;
  }

  /**
   * `count` complex samples from absolute index `start`, interleaved float.
   *
   * Past the head the answer is zeros — that is the future, and a display asking for
   * the window around "now" should get silence rather than a broken frame, exactly as
   * a file's end behaves. Before the window it throws, because those samples existed
   * and are gone, and returning zeros there would draw a confident picture of a signal
   * that was never like that.
   */
  read(start, count) {
    if (start < 0) start = 0;
    const [first] = this.window();
    if (start < first) {
      throw new RangeError(
        `those samples have scrolled out of the ring (asked for ${(start / this.sampleRate).toFixed(2)}s, ` +
        `which is older than ${(first / this.sampleRate).toFixed(2)}s)`);
    }

    const c = this._cache;
    if (c.data && start >= c.start && start + count <= c.start + c.len) {
      const off = (start - c.start) * 2;
      return c.data.subarray(off, off + count * 2);
    }

    const len = count + Math.max(count, 1 << 16);
    const data = new Float32Array(len * 2);
    const avail = Math.max(0, Math.min(len, this.head - start));
    if (avail > 0) {
      const bps = this.spec.bps;
      const bytes = Buffer.allocUnsafe(avail * bps);
      let off = 0, left = avail;
      while (left > 0) {
        const slot = (start + off) % this.samples;
        const run = Math.min(left, this.samples - slot);
        fs.readSync(this.fd, bytes, off * bps, run * bps, slot * bps);
        off += run;
        left -= run;
      }
      this.spec.read(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 0, avail, data);
    }
    c.start = start; c.len = len; c.data = data;
    return data.subarray(0, count * 2);
  }
}
