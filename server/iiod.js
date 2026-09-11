// Talking to a Pluto directly, instead of shelling out to libiio's tools.
//
// A Pluto is not a USB device to claim. It presents a USB-ethernet gadget answering on
// 192.168.2.1, and everything above that is a socket: iiod listens on 30431 and speaks
// a line protocol with binary payloads. So the radio needs no libiio installed, no
// native module, and no `iio_readdev` on the PATH — which is what makes it work on a
// Windows box with nothing installed, in the plain container, and on a phone under
// Termux where none of those packages exist.
//
// The protocol here was not written from memory. It was read off the wire between
// libiio's own client and a real iiod, and the details that matter are the ones that
// would have been wrong if it had been:
//
//   command       →  line, CRLF-terminated
//   reply         →  ASCII integer, LF-terminated. Negative is -errno.
//   value reply   →  <len>\n<payload>\n   ← the trailing LF is load-bearing; without
//                    it the next read starts a byte early and the session desyncs
//   READBUF reply →  <bytes>\n<mask>\n<payload>   ← and this one has no trailing LF
//
// That asymmetry between a value and a buffer is the kind of thing no specification
// mentions and an afternoon of tcpdump tells you in a minute.

import net from 'node:net';

export const IIOD_PORT = 30431;

export class Iiod {
  constructor({ host = '192.168.2.1', port = IIOD_PORT, timeoutMs = 5000 } = {}) {
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.sock = null;
    this._buf = Buffer.alloc(0);
    this._waiters = [];
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const s = net.connect(this.port, this.host);
      this.sock = s;
      s.setNoDelay(true);
      const fail = (e) => reject(new Error(
        e.code === 'ECONNREFUSED'
          ? `nothing is listening on ${this.host}:${this.port} — is the Pluto plugged in and its network interface up?`
          : e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH'
            ? `no route to ${this.host} — the Pluto's USB-ethernet interface is not up on this machine`
            : `${this.host}:${this.port}: ${e.message}`));
      const to = setTimeout(() => { s.destroy(); reject(new Error(`${this.host}:${this.port} did not answer`)); }, this.timeoutMs);
      s.once('error', (e) => { clearTimeout(to); fail(e); });
      s.once('connect', () => {
        clearTimeout(to);
        s.removeListener('error', fail);
        s.on('error', () => this._fail(new Error('connection lost')));
        s.on('close', () => this._fail(new Error('connection closed')));
        s.on('data', (b) => { this._buf = Buffer.concat([this._buf, b]); this._pump(); });
        resolve(this);
      });
    });
  }

  _fail(err) {
    this.closed = true;
    const w = this._waiters.splice(0);
    for (const x of w) x.reject(err);
  }

  /** Each reader states how many bytes it needs; the parser hands them over in order. */
  _pump() {
    for (;;) {
      const w = this._waiters[0];
      if (!w) return;
      const got = w.take(this._buf);
      if (got === null) return;              // needs more
      this._buf = this._buf.subarray(got.used);
      this._waiters.shift();
      w.resolve(got.value);
    }
  }

  _expect(take) {
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error('not connected')); return; }
      this._waiters.push({ take, resolve, reject });
      this._pump();
    });
  }

  /** One LF-terminated line. */
  _line() {
    return this._expect((buf) => {
      const i = buf.indexOf(10);
      if (i < 0) return null;
      return { used: i + 1, value: buf.subarray(0, i).toString('latin1').trim() };
    });
  }

  /** Exactly `n` bytes. */
  _bytes(n) {
    return this._expect((buf) => (buf.length < n ? null : { used: n, value: Buffer.from(buf.subarray(0, n)) }));
  }

  _send(line) {
    if (this.closed || !this.sock) throw new Error('not connected');
    this.sock.write(line + '\r\n');
  }

  /** A reply that is just a number: zero or more on success, -errno on failure. */
  async _status(what) {
    const n = parseInt(await this._line(), 10);
    if (!Number.isFinite(n)) throw new Error(`${what}: unintelligible reply`);
    if (n < 0) throw new Error(`${what}: ${errnoName(-n)}`);
    return n;
  }

  /** `<len>\n<payload>\n`, the shape every value reply takes. */
  async _value(what) {
    const n = await this._status(what);
    const body = await this._bytes(n);
    await this._bytes(1);                    // the trailing LF
    return body.toString('latin1').replace(/\0+$/, '');
  }

  // ── the commands this needs ──────────────────────────────────────────────
  async version() { this._send('VERSION'); return (await this._line()).trim(); }

  async print() { this._send('PRINT'); return this._value('PRINT'); }

  async setTimeout_(ms) { this._send(`TIMEOUT ${Math.round(ms)}`); try { return await this._status('TIMEOUT'); } catch { return 0; } }

  async readAttr(dev, kind, chn, attr) {
    this._send(`READ ${dev} ${kind} ${chn} ${attr}`);
    return this._value(`reading ${chn}/${attr}`);
  }

  async writeAttr(dev, kind, chn, attr, value) {
    const body = Buffer.from(String(value) + '\0', 'latin1');
    this._send(`WRITE ${dev} ${kind} ${chn} ${attr} ${body.length}`);
    this.sock.write(body);
    return this._status(`setting ${chn}/${attr}`);
  }

  /** `mask` is hex, one bit per enabled scan element. */
  async open(dev, samples, mask) {
    this._send(`OPEN ${dev} ${samples} ${mask}`);
    return this._status(`opening ${dev}`);
  }

  async close(dev) {
    this._send(`CLOSE ${dev}`);
    return this._status(`closing ${dev}`);
  }

  /** `<bytes>\n<mask>\n<payload>` — and no trailing newline, unlike a value. */
  async readBuf(dev, bytes) {
    this._send(`READBUF ${dev} ${bytes}`);
    const n = await this._status(`reading from ${dev}`);
    if (n === 0) return Buffer.alloc(0);
    await this._line();                      // the channel mask, which we set ourselves
    return this._bytes(n);
  }

  async exit() {
    try { this._send(''); this._send('EXIT'); } catch { /* already gone */ }
    this.disconnect();
  }

  disconnect() {
    this.closed = true;
    if (this.sock) { try { this.sock.destroy(); } catch { /* gone */ } this.sock = null; }
  }
}

/**
 * The context, out of the XML the device describes itself with.
 *
 * Parsed with regular expressions rather than a DOM, which is normally the wrong
 * instinct — but this is a single flat document generated by one program, with no
 * namespaces, no nesting beyond two levels and no text content, and the alternative is
 * a dependency on a machine where the whole point is that nothing is installed.
 */
export function parseContext(xml) {
  const devices = [];
  const devRe = /<device\s+([^>]*?)\/?>([\s\S]*?)<\/device>/g;
  let m;
  while ((m = devRe.exec(xml))) {
    const attrs = attrsOf(m[1]);
    const body = m[2];
    const channels = [];
    const chRe = /<channel\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/channel>)/g;
    let c;
    while ((c = chRe.exec(body))) {
      const ca = attrsOf(c[1]);
      const cbody = c[2] || '';
      const scan = /<scan-element\s+([^>]*?)\/?>/.exec(cbody);
      channels.push({
        id: ca.id, name: ca.name || null, type: ca.type,
        attributes: [...cbody.matchAll(/<attribute\s+([^>]*?)\/?>/g)].map((a) => attrsOf(a[1]).name),
        scan: scan ? { index: +attrsOf(scan[1]).index, format: decode(attrsOf(scan[1]).format) } : null,
      });
    }
    devices.push({ id: attrs.id, name: attrs.name || null, channels });
  }
  return { devices };
}

function attrsOf(s) {
  const out = {};
  for (const m of s.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

const ENT = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" };
function decode(s) { return String(s || '').replace(/&(lt|gt|amp|quot|apos);/g, (x) => ENT[x]); }

/**
 * A scan element's format, e.g. `le:S12/16>>0`: signed, twelve significant bits carried
 * in a sixteen-bit word, no shift.
 *
 * Worth reading rather than assuming, because the Pluto's twelve-bits-in-sixteen is
 * exactly the case where assuming sixteen leaves every signal twenty-four decibels
 * quiet and looking like a gain problem.
 */
export function parseFormat(fmt) {
  const m = /^(le|be):([SU])(\d+)\/(\d+)(?:>>(\d+))?$/.exec(String(fmt || '').trim());
  if (!m) return { littleEndian: true, signed: true, bits: 16, storage: 16, shift: 0, scale: 1 / 32768 };
  const bits = +m[3], storage = +m[4];
  return {
    littleEndian: m[1] === 'le',
    signed: m[2] === 'S',
    bits, storage, shift: +(m[5] || 0),
    // full scale is the largest magnitude the significant bits can hold
    scale: 1 / (m[2] === 'S' ? (1 << (bits - 1)) : (1 << bits)),
  };
}

const ERRNO = {
  1: 'not permitted', 2: 'no such attribute or device', 5: 'I/O error', 6: 'no such device',
  9: 'bad file descriptor', 11: 'try again', 12: 'out of memory', 13: 'permission denied',
  16: 'device busy', 19: 'no such device', 22: 'invalid argument', 25: 'not a tty',
  32: 'broken pipe', 38: 'not supported by this device', 110: 'timed out',
};
function errnoName(n) { return ERRNO[n] ? `${ERRNO[n]} (${n})` : `error ${n}`; }
