// RFC 6455, the part of it this tool uses.
//
// `ws` is an excellent library and this is about a hundred and fifty lines, which is
// the trade: the client has no build step and no dependencies, and it would be a shame
// for the server to need `npm install` and a lockfile to answer it. The image is then
// a Node base and this repository, and there is no third party in the path between a
// capture on the box and the person looking at it.
//
// What is implemented: the handshake, client-to-server frames including masking and
// continuation, server-to-server-client frames unfragmented, ping/pong, close. What is
// not: extensions (no permessage-deflate — these payloads are float samples and do not
// compress), and subprotocol negotiation. Anything unrecognised closes the socket
// rather than being guessed at.

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

/** The 16 MB an oversized frame would have to exceed before we hang up on it. */
const MAX_MESSAGE = 16 << 20;

export function accept(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key || version !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const digest = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${digest}\r\n\r\n`);
  return new Connection(socket, head);
}

export class Connection extends EventEmitter {
  constructor(socket, head) {
    super();
    this.socket = socket;
    this.open = true;
    this._buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this._frags = [];      // a message split across continuation frames
    this._fragOp = null;

    socket.setNoDelay(true);          // a frame late is a frame wrong
    socket.on('data', (d) => this._feed(d));
    socket.on('close', () => this._done());
    // A socket error is one tab going away, not a fault in the server. EventEmitter
    // throws an unhandled 'error' event, and a thrown error here takes down every
    // other session on the box — so it is reported only if somebody is listening,
    // and is otherwise just the end of this connection.
    socket.on('error', (e) => {
      if (this.listenerCount('error')) this.emit('error', e);
      this._done();
    });
    if (this._buf.length) this._drain();
  }

  _done() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }

  _feed(d) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, d]) : d;
    this._drain();
  }

  _drain() {
    for (;;) {
      const f = this._read();
      if (!f) return;
      this._handle(f);
      if (!this.open) return;
    }
  }

  /** One frame off the head of the buffer, or null if it has not all arrived. */
  _read() {
    const b = this._buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const rsv = b[0] & 0x70;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;

    if (rsv) { this.close(1002, 'reserved bits'); return null; }
    // Every frame from a browser is masked. An unmasked one is a proxy rewriting
    // traffic or something that is not a browser, and the spec says hang up.
    if (!masked) { this.close(1002, 'unmasked frame'); return null; }

    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off); off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      const big = b.readBigUInt64BE(off); off += 8;
      if (big > BigInt(MAX_MESSAGE)) { this.close(1009, 'too large'); return null; }
      len = Number(big);
    }
    if (len > MAX_MESSAGE) { this.close(1009, 'too large'); return null; }
    if (b.length < off + 4 + len) return null;

    const mask = b.subarray(off, off + 4); off += 4;
    const payload = Buffer.allocUnsafe(len);
    b.copy(payload, 0, off, off + len);
    for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];

    this._buf = b.subarray(off + len);
    return { fin, opcode, payload };
  }

  _handle(f) {
    switch (f.opcode) {
      case OP.PING: this._send(OP.PONG, f.payload); return;
      case OP.PONG: return;
      case OP.CLOSE: this.close(1000); return;
      case OP.CONT: {
        if (this._fragOp == null) { this.close(1002, 'continuation with nothing to continue'); return; }
        this._frags.push(f.payload);
        if (!f.fin) return;
        const whole = Buffer.concat(this._frags);
        const op = this._fragOp;
        this._frags = []; this._fragOp = null;
        this._deliver(op, whole);
        return;
      }
      case OP.TEXT: case OP.BIN: {
        if (this._fragOp != null) { this.close(1002, 'interleaved message'); return; }
        if (!f.fin) { this._fragOp = f.opcode; this._frags = [f.payload]; return; }
        this._deliver(f.opcode, f.payload);
        return;
      }
      default: this.close(1002, `opcode ${f.opcode}`);
    }
  }

  _deliver(opcode, payload) {
    if (opcode === OP.TEXT) this.emit('text', payload.toString('utf8'));
    else this.emit('message', payload);
  }

  _send(opcode, payload) {
    if (this.socket.destroyed || !this.socket.writable) return false;
    if (!this.open && opcode !== OP.CLOSE) return false;
    const len = payload.length;
    // Server frames are never masked and never fragmented: we know the whole message
    // before we start writing, so there is nothing to be gained by cutting it up.
    let head;
    if (len < 126) {
      head = Buffer.allocUnsafe(2); head[1] = len;
    } else if (len < 65536) {
      head = Buffer.allocUnsafe(4); head[1] = 126; head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.allocUnsafe(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2);
    }
    head[0] = 0x80 | opcode;
    // The peer can be gone between the check above and the write — a tab closing is
    // exactly that race, and it must cost this connection and nothing else.
    try {
      return this.socket.write(Buffer.concat([head, payload], head.length + len));
    } catch {
      this._done();
      return false;
    }
  }

  /** An ArrayBuffer or Buffer, as one binary message. Returns false if backed up. */
  send(data) {
    const b = data instanceof ArrayBuffer ? Buffer.from(data)
      : Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return this._send(OP.BIN, b);
  }

  sendText(s) { return this._send(OP.TEXT, Buffer.from(s, 'utf8')); }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    const r = Buffer.from(reason, 'utf8');
    const p = Buffer.allocUnsafe(2 + r.length);
    p.writeUInt16BE(code, 0); r.copy(p, 2);
    this._send(OP.CLOSE, p);
    this.open = false;
    try { this.socket.end(); } catch { /* already gone */ }
    this.emit('close');
  }
}
