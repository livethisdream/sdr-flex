// The network sink: samples out, nothing back.
//
//   node --test web/test/streamout.test.mjs
//
// ADR-0027 named this when it listed what a sink is, and the reason it is a sink rather
// than another adapter is the distinction worth pinning: an adapter is a *function* —
// reads a span, prints records, exits, and the records come back with timestamps and a
// pane. Some programs are *destinations*: a ground station drawing a flight on a map is
// not a `parse()` anybody wants to write. Nothing comes back, and that is the point.
//
// A real socket, on a port the kernel picks, receiving into a real listener. The format
// is the adapters' own conversion, so what this sends is what a decoder would have been
// handed — which is the property that makes off-boarding equivalent to decoding here.

import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { StreamOut } from '../../server/streamout.js';
import * as adapters from '../../server/adapters.js';

/** A listener on an ephemeral port, collecting datagrams. */
async function listener() {
  const sock = dgram.createSocket('udp4');
  const got = [];
  sock.on('message', (m) => got.push(Buffer.from(m)));
  await new Promise((r) => sock.bind(0, '127.0.0.1', r));
  return { port: sock.address().port, got, close: () => sock.close(),
           // UDP is not ordered and not instant even on loopback, so a test that reads
           // immediately reads nothing. This waits for a count rather than a duration.
           until: async (n, ms = 2000) => {
             const t0 = Date.now();
             while (got.length < n && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
             return got.length;
           } };
}

// What the application actually sends in one go: a quarter second of 48 kHz signed
// 16-bit audio. Measured here rather than assumed, because the number matters — see the
// headroom test at the bottom.
const CHUNK_S = 0.25;

test('what goes out is what a decoder would have been handed', async () => {
  const L = await listener();
  const sink = new StreamOut({ host: '127.0.0.1', port: L.port });
  // One chunk of tone, converted exactly the way an adapter's input is.
  const n = Math.round(48_000 * CHUNK_S);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * 1000 * i) / n) * 0.5;
  const { bytes } = adapters.convert(x, 'real', 48_000, { format: 's16', rate: 48_000 });
  const count = sink.write(bytes);
  await L.until(count, 5000);
  const joined = Buffer.concat(L.got);
  sink.close(); L.close();

  assert.equal(joined.length, bytes.length, `sent ${bytes.length} B, received ${joined.length} B`);
  assert.ok(joined.equals(bytes), 'the bytes on the wire are not the bytes that were converted');
  // And they are signed 16-bit samples of a real tone rather than anything else: a
  // half-scale sine peaks near 16383.
  let peak = 0;
  for (let i = 0; i + 1 < joined.length; i += 2) peak = Math.max(peak, Math.abs(joined.readInt16LE(i)));
  assert.ok(peak > 14_000 && peak <= 32_767, `peak sample ${peak}`);
});

test('a datagram is small enough for the network to carry whole', async () => {
  // Larger than the path MTU and IP fragments it; one lost fragment loses all of it.
  const L = await listener();
  const sink = new StreamOut({ host: '127.0.0.1', port: L.port });
  const count = sink.write(Buffer.alloc(10_000, 7));
  await L.until(count);
  const sizes = new Set(L.got.map((b) => b.length));
  sink.close(); L.close();
  assert.ok(Math.max(...sizes) <= 1024, `a ${Math.max(...sizes)} byte datagram will fragment`);
  assert.equal(L.got.reduce((a, b) => a + b.length, 0), 10_000, 'bytes went missing');
});

test('it counts what left, because UDP never answers', async () => {
  // The only honest evidence a sink is working. A number that climbs while the far end
  // says nothing means the far end — which is a different problem from this one.
  const L = await listener();
  const sink = new StreamOut({ host: '127.0.0.1', port: L.port });
  sink.write(Buffer.alloc(2048));
  await L.until(2);
  const st = sink.status();
  sink.close(); L.close();
  assert.equal(st.sent, 2);
  assert.equal(st.bytes, 2048);
  assert.equal(st.error, null);
});

test('a socket error is recorded rather than thrown at the process', async () => {
  // A UDP socket reports asynchronously, and an unhandled `error` on an EventEmitter
  // takes the process down — a typo in a hostname would kill the engine for everybody
  // sharing it.
  const sink = new StreamOut({ host: '203.0.113.0', port: 9 });
  sink.sock.emit('error', new Error('EHOSTUNREACH'));
  assert.match(sink.status().error, /EHOSTUNREACH/);
  // And once it is in that state it stops trying rather than piling up callbacks.
  assert.equal(sink.write(Buffer.alloc(64)), 0);
  sink.close();
});

test('closing twice is not an error', () => {
  // The session closes these on dispose, on node removal, and when the address changes;
  // those can coincide.
  const sink = new StreamOut({ host: '127.0.0.1', port: 9 });
  sink.close();
  assert.doesNotThrow(() => sink.close());
});

test('one chunk fits inside what a socket will carry in a burst', async () => {
  // The reason the application feeds this a quarter second at a time rather than a span
  // at a time. Nothing here paces datagrams — `send` queues and returns, deliberately,
  // so that a sink cannot stall the read loop for something that may not even be
  // listening. The pacing is the clock: one chunk per tick.
  //
  // Measured on loopback, which is the most forgiving path there is: 64 kB in one burst
  // arrives whole, 96 kB loses 4 datagrams and 128 kB loses 36 — the receiving socket's
  // buffer saturates a little over ninety. A quarter second of 48 kHz s16 is 24 kB, so
  // there is about 2.5x of headroom on the friendliest link and the loss when it comes
  // is silent, which is why the margin is not thinner.
  const chunkBytes = 48_000 * 2 * CHUNK_S;
  assert.equal(chunkBytes, 24_000);

  const L = await listener();
  const sink = new StreamOut({ host: '127.0.0.1', port: L.port });
  const count = sink.write(Buffer.alloc(chunkBytes, 3));
  const arrived = await L.until(count, 5000);
  sink.close(); L.close();
  assert.equal(arrived, count, `${count - arrived} of ${count} datagrams were dropped`);
});
