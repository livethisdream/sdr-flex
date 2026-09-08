// The WebSocket framing, which is hand-written and therefore the thing most likely to
// be subtly wrong. These drive raw bytes at the server rather than using a client
// library, because a client library only ever produces the frames it produces — and
// the cases that break a parser are the ones nothing normal sends.

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import http from 'node:http';
import { accept } from '../../server/wsserver.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** A server that echoes whatever message it is given, so a test can see what arrived. */
async function echoServer(t) {
  const seen = [];
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    const c = accept(req, socket, head);
    if (!c) return;
    c.on('error', () => {});
    c.on('message', (b) => { seen.push(b); c.send(b); });
    c.on('text', (s) => { seen.push(s); c.sendText(s); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { port: server.address().port, seen };
}

/** Open a raw TCP connection and do the handshake by hand. */
async function raw(port) {
  const key = crypto.randomBytes(16).toString('base64');
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((r) => sock.once('connect', r));
  sock.write(
    `GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  const head = await new Promise((r) => sock.once('data', r));
  const text = head.toString('latin1');
  const expect = crypto.createHash('sha1').update(key + GUID).digest('base64');
  return { sock, text, expect, rest: head.subarray(text.indexOf('\r\n\r\n') + 4) };
}

/** One client frame, masked as the spec requires of a client. */
function clientFrame(opcode, payload, { fin = true } = {}) {
  const mask = crypto.randomBytes(4);
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = 0x80 | len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = (fin ? 0x80 : 0) | opcode;
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

/** Read frames off the wire until one satisfies `want`. */
function readFrame(sock, timeout = 3000) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => reject(new Error('no frame')), timeout);
    const on = (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 2) return;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      clearTimeout(timer); sock.off('data', on);
      resolve({ fin: !!(buf[0] & 0x80), opcode: buf[0] & 0x0f, payload: buf.subarray(off, off + len) });
    };
    sock.on('data', on);
  });
}

test('the handshake matches the RFC 6455 test vector', () => {
  const d = crypto.createHash('sha1').update('dGhlIHNhbXBsZSBub25jZQ==' + GUID).digest('base64');
  assert.equal(d, 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('a real handshake returns 101 and the right accept value', async (t) => {
  const { port } = await echoServer(t);
  const { sock, text, expect } = await raw(port);
  assert.match(text, /^HTTP\/1\.1 101 /);
  assert.match(text, new RegExp(`Sec-WebSocket-Accept: ${expect.replace(/\+/g, '\\+')}`));
  sock.destroy();
});

test('a binary message round trips', async (t) => {
  const { port } = await echoServer(t);
  const { sock } = await raw(port);
  const payload = crypto.randomBytes(300);
  sock.write(clientFrame(0x2, payload));
  const f = await readFrame(sock);
  assert.equal(f.opcode, 0x2);
  assert.deepEqual(f.payload, payload);
  sock.destroy();
});

test('each payload length encoding is read correctly', async (t) => {
  const { port } = await echoServer(t);
  for (const len of [0, 1, 125, 126, 127, 65535, 65536, 200_000]) {
    const { sock } = await raw(port);
    const payload = crypto.randomBytes(len);
    sock.write(clientFrame(0x2, payload));
    const f = await readFrame(sock);
    assert.equal(f.payload.length, len, `length ${len}`);
    assert.deepEqual(f.payload, payload, `contents at length ${len}`);
    sock.destroy();
  }
});

test('a message split across continuation frames is reassembled', async (t) => {
  const { port, seen } = await echoServer(t);
  const { sock } = await raw(port);
  const a = Buffer.from('the first half, '), b = Buffer.from('and the second');
  sock.write(clientFrame(0x1, a, { fin: false }));
  sock.write(clientFrame(0x0, b, { fin: true }));
  const f = await readFrame(sock);
  assert.equal(f.payload.toString(), 'the first half, and the second');
  assert.equal(seen[0], 'the first half, and the second');
  sock.destroy();
});

test('a frame arriving in pieces across TCP reads is still one frame', async (t) => {
  // TCP does not preserve message boundaries, and a parser that assumes it does works
  // perfectly on a loopback and fails on a real network
  const { port } = await echoServer(t);
  const { sock } = await raw(port);
  const payload = crypto.randomBytes(4000);
  const frame = clientFrame(0x2, payload);
  for (let i = 0; i < frame.length; i += 137) {
    sock.write(frame.subarray(i, Math.min(frame.length, i + 137)));
    await new Promise((r) => setTimeout(r, 1));
  }
  const f = await readFrame(sock);
  assert.deepEqual(f.payload, payload);
  sock.destroy();
});

test('two frames in one TCP read are both delivered', async (t) => {
  const { port, seen } = await echoServer(t);
  const { sock } = await raw(port);
  sock.write(Buffer.concat([clientFrame(0x2, Buffer.from('one')), clientFrame(0x2, Buffer.from('two'))]));
  await readFrame(sock);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(seen.map(String), ['one', 'two']);
  sock.destroy();
});

test('a ping is answered with a pong carrying the same payload', async (t) => {
  const { port } = await echoServer(t);
  const { sock } = await raw(port);
  sock.write(clientFrame(0x9, Buffer.from('are you there')));
  const f = await readFrame(sock);
  assert.equal(f.opcode, 0xa);
  assert.equal(f.payload.toString(), 'are you there');
  sock.destroy();
});

test('an unmasked client frame is refused, as the spec requires', async (t) => {
  const { port } = await echoServer(t);
  const { sock } = await raw(port);
  const body = Buffer.from('unmasked');
  sock.write(Buffer.concat([Buffer.from([0x82, body.length]), body]));
  const f = await readFrame(sock);
  assert.equal(f.opcode, 0x8, 'it closes rather than reading it');
  assert.equal(f.payload.readUInt16BE(0), 1002);
  sock.destroy();
});

test('a client hanging up mid-message does not take the server with it', async (t) => {
  const { port } = await echoServer(t);
  const { sock } = await raw(port);
  sock.write(clientFrame(0x2, crypto.randomBytes(50_000)).subarray(0, 40));  // half a frame
  sock.destroy();
  await new Promise((r) => setTimeout(r, 100));

  // still serving
  const second = await raw(port);
  second.sock.write(clientFrame(0x2, Buffer.from('still here')));
  const f = await readFrame(second.sock);
  assert.equal(f.payload.toString(), 'still here');
  second.sock.destroy();
});

test('a non-websocket upgrade is refused without crashing', async (t) => {
  const { port } = await echoServer(t);
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((r) => sock.once('connect', r));
  sock.write('GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  const d = await new Promise((r) => sock.once('data', r));
  assert.match(d.toString(), /400/);
  sock.destroy();
});
