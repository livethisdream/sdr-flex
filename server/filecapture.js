// A capture the size of the disk, not the size of the heap.
//
// The browser had to hold the whole file: 360 MB of cu8 became a 360 MB ArrayBuffer in
// the tab, five and a half seconds to load and a third of a gigabyte resident for as
// long as you looked at it. On the server there is no reason to. A display asks for a
// window of a few thousand samples at a time, so this reads a window of the file and
// keeps the last one, and a 40 GB capture costs the same as a 40 MB one.
//
// The contract is `read(start, count)` over an absolute complex sample index, exactly
// as `Capture` and the synthetic scene expose it (ADR-0005), so nothing downstream can
// tell which of the three it is talking to.

import fs from 'node:fs';
import { FORMATS } from '../web/src/capture.js';

/** Bytes to pull per miss. Big enough that scrubbing is not a syscall per row. */
const WINDOW_BYTES = 1 << 22;   // 4 MB

export class FileCapture {
  constructor({ path, format, sampleRate, centerHz, label, meta }) {
    this.path = path;
    this.format = format;
    this.spec = FORMATS[format];
    if (!this.spec) throw new Error(`unknown sample format ${format}`);
    this.sampleRate = sampleRate;
    this.centerHz = centerHz;
    this.label = label;
    this.meta = meta || null;

    this.fd = fs.openSync(path, 'r');
    this.bytes = fs.fstatSync(this.fd).size;
    this.samples = Math.floor(this.bytes / this.spec.bps);
    this.durationS = this.samples / sampleRate;

    this._win = { start: -1, samples: 0, view: null };   // decoded-from window, in bytes
    this._cache = { start: 0, len: 0, data: null };      // converted float window
  }

  close() { if (this.fd != null) { fs.closeSync(this.fd); this.fd = null; } }

  /** Make sure the byte window covers `count` complex samples from `start`. */
  _window(start, count) {
    const w = this._win;
    if (w.view && start >= w.start && start + count <= w.start + w.samples) return w;
    const bps = this.spec.bps;
    const want = Math.max(count, Math.floor(WINDOW_BYTES / bps));
    // reach a little behind as well: the waterfall prefill walks backwards through the
    // file, and a window that only ever extends forwards misses on every single row
    const from = Math.max(0, start - (start > 0 ? Math.floor(want / 4) : 0));
    const n = Math.max(0, Math.min(want, this.samples - from));
    const buf = Buffer.allocUnsafe(n * bps);
    const got = n > 0 ? fs.readSync(this.fd, buf, 0, n * bps, from * bps) : 0;
    w.start = from;
    w.samples = Math.floor(got / bps);
    w.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return w;
  }

  /**
   * `count` complex samples from absolute index `start`, interleaved. Past the end of
   * the file the answer is zeros rather than an error: a display asking for the window
   * around a moment should get silence past the end, not a broken frame.
   */
  read(start, count) {
    if (start < 0) start = 0;
    const c = this._cache;
    if (c.data && start >= c.start && start + count <= c.start + c.len) {
      const off = (start - c.start) * 2;
      return c.data.subarray(off, off + count * 2);
    }
    const len = count + Math.max(count, 1 << 17);
    const data = new Float32Array(len * 2);
    const avail = Math.max(0, Math.min(len, this.samples - start));
    let short = false;
    if (avail > 0) {
      const w = this._window(start, avail);
      const n = Math.max(0, Math.min(avail, w.start + w.samples - start));
      if (n > 0) this.spec.read(w.view, start - w.start, n, data);
      short = n < avail;              // the read came up short of the file's own length
    }
    // Zeros past the end of the file are the right answer; zeros because a read was
    // short are not, and caching them would make one bad read permanent.
    if (short) { c.data = null; } else { c.start = start; c.len = len; c.data = data; }
    return data.subarray(0, count * 2);
  }
}
