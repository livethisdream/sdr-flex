// The server: static client, one socket per tab, captures from a directory.
//
// The client and the socket share an origin on purpose. A page served from anywhere
// else has to negotiate CORS, and — the trap that actually bites — a page served over
// HTTPS may not open a `ws://` socket at all, so a perfectly good setup fails with a
// console message about mixed content and no other symptom. Serving both from here
// means there is nothing to configure and nothing to get wrong.
//
// It binds to one address, and that address is not 0.0.0.0 unless someone types it.
// The intended home is a tailnet, where the network is the boundary and there is no
// login: that is a reasonable posture on an interface only your own devices can reach
// and a poor one on a LAN with guests, so the default refuses to guess.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { accept } from './wsserver.js';
import { Session } from './session.js';
import { Library } from './library.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const CONFIG = {
  port: +(process.env.SDRFLEX_PORT || 8722),
  bind: process.env.SDRFLEX_BIND || 'auto',
  webDir: process.env.SDRFLEX_WEB || path.join(HERE, '..', 'web'),
  captureDir: process.env.SDRFLEX_CAPTURES || path.join(HERE, '..', 'captures'),
  quiet: process.env.SDRFLEX_QUIET === '1',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * The Tailscale address, if there is one.
 *
 * Binding to the tailnet interface rather than every interface means a misconfigured
 * home router cannot expose this by accident: the socket is not listening anywhere
 * else to begin with. Falling back to loopback if there is no tailnet is the same
 * reasoning — the safe default is the one that reaches fewest machines.
 */
export function pickAddress(bind, interfaces = os.networkInterfaces()) {
  if (bind && bind !== 'auto') return { host: bind, why: 'SDRFLEX_BIND' };
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      // 100.64.0.0/10 is the CGNAT range Tailscale hands out
      const [o1, o2] = a.address.split('.').map(Number);
      if (o1 === 100 && o2 >= 64 && o2 <= 127) return { host: a.address, why: `tailnet (${name})` };
    }
  }
  return { host: '127.0.0.1', why: 'no tailnet found — loopback only' };
}

function serveStatic(req, res, webDir) {
  const url = new URL(req.url, 'http://x');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const full = path.join(webDir, rel);
  // the client is a directory of static files, and nothing above it is served
  if (!full.startsWith(path.resolve(webDir))) { res.writeHead(403).end('no'); return; }

  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      // the client changes whenever it is redeployed and is small; never cache it
      'cache-control': 'no-cache',
    });
    fs.createReadStream(full).pipe(res);
  });
}

export function createServer({ webDir, captureDir, quiet } = CONFIG) {
  const log = quiet ? () => {} : (...a) => console.log('[sdr-flex]', ...a);
  const library = captureDir && fs.existsSync(captureDir) ? new Library(captureDir) : null;
  if (!library) log(`no capture directory at ${captureDir} — the synthetic scene only`);

  const server = http.createServer((req, res) => serveStatic(req, res, webDir));
  // A malformed request or a client that hangs up mid-header is not news, and is
  // certainly not a reason to stop serving everyone else.
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws') { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    const conn = accept(req, socket, head);
    if (!conn) return;
    conn.on('error', (e) => log(`socket: ${e.message}`));
    log('client connected');
    const s = new Session(conn, { library, log });
    conn.on('close', () => log('client gone'));
    return s;
  });

  return { server, library, log };
}

export function start(cfg = CONFIG) {
  const { server, library, log } = createServer(cfg);
  const { host, why } = pickAddress(cfg.bind);
  server.listen(cfg.port, host, () => {
    log(`http://${host}:${cfg.port}  — bound to ${why}`);
    if (library) {
      const n = library.list().length;
      log(`${n} capture${n === 1 ? '' : 's'} in ${cfg.captureDir}`);
    }
    if (host === '0.0.0.0') {
      // Inside a container this is correct and says nothing about the host: what the
      // host exposes is the port publish, and compose scopes that to one address.
      // Outside one it means every interface on the machine, which is a different
      // thing entirely and worth saying out loud.
      if (fs.existsSync('/.dockerenv')) {
        log('listening on all interfaces inside the container — what the host exposes');
        log('is the port publish, so keep it scoped to the tailnet address');
      } else {
        log('WARNING: bound to every interface on this machine. There is no');
        log('         authentication in front of this. On a tailnet, set SDRFLEX_BIND');
        log('         to the 100.x address instead.');
      }
    }
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) start();
