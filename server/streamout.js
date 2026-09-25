// The network sink: samples out, nothing back.
//
// ADR-0027 named this when it listed what a sink is — "the audio sink, and later the
// file writer, the network sink, the recorder" — and the reason it is a sink rather
// than another adapter is the distinction that decides the whole design:
//
//   An adapter is a **function**. It reads a span, prints records, exits, and the
//   records come back into the tool with timestamps, a pane, `Identify`, and a golden
//   capture pinning what it returns.
//
//   Some programs are **destinations**. A ground station drawing a drone's flight on a
//   map, a live Wireshark capture, a decoder somebody else maintains and you would
//   rather not write a parser for. Nothing comes back, and that is not a shortcoming —
//   their own display is the point.
//
// So this is the GQRX arrangement, deliberately: 48 kHz signed 16-bit mono to a UDP
// port. That is the convention the receiving end already knows, and it is why this
// takes a *format* rather than inventing a framing.
//
// **UDP, and what that means.** Datagrams arrive whole or not at all, with no ordering
// and no retry. For audio into a decoder that is the right trade — a lost packet is a
// click, where a stalled TCP stream is a decoder that silently falls behind the clock
// forever. For bytes it means the far end must tolerate a gap, which every protocol
// that is sent over the air already does. Nothing here retries, and the note says how
// many datagrams went out so a silence can be told from a sink that is not running.

import dgram from 'node:dgram';

// A datagram larger than the path MTU is fragmented by IP, and one lost fragment loses
// the whole thing — so the useful size is under a typical 1500-byte Ethernet MTU with
// room for the headers. 1024 is the round number under that and is what the GQRX-facing
// tools expect to see.
const MAX_PAYLOAD = 1024;

export class StreamOut {
  constructor({ host, port, log = () => {} }) {
    this.host = host;
    this.port = port;
    this.log = log;
    this.sent = 0;          // datagrams
    this.bytes = 0;
    this.error = null;
    this.sock = dgram.createSocket('udp4');
    // A UDP socket's errors arrive here rather than on a call, and an unhandled one on
    // an EventEmitter takes the process down — which would mean a typo in a hostname
    // killing the engine for everybody sharing it.
    this.sock.on('error', (e) => { this.error = e.message; });
  }

  /**
   * Send a buffer, cut into datagrams the network will carry whole.
   *
   * Nothing waits for it. `send` on a connectionless socket queues and returns, and a
   * sink that blocked the read loop would make the playhead stutter for the benefit of
   * something that is not even guaranteed to be listening.
   */
  write(buf) {
    if (this.error) return 0;
    let n = 0;
    for (let at = 0; at < buf.length; at += MAX_PAYLOAD) {
      const part = buf.subarray(at, Math.min(buf.length, at + MAX_PAYLOAD));
      this.sock.send(part, this.port, this.host, (e) => { if (e) this.error = e.message; });
      n++;
    }
    this.sent += n;
    this.bytes += buf.length;
    return n;
  }

  close() {
    try { this.sock.close(); } catch { /* already gone */ }
    this.sock = null;
  }

  status() {
    return { host: this.host, port: this.port, sent: this.sent, bytes: this.bytes,
             error: this.error };
  }
}
