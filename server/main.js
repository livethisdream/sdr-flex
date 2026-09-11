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
import { PluginDir } from './plugindir.js';
import * as adapters from './adapters.js';
import { AdapterDir } from './adapterdir.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const CONFIG = {
  port: +(process.env.SDRFLEX_PORT || 8722),
  bind: process.env.SDRFLEX_BIND || 'auto',
  webDir: process.env.SDRFLEX_WEB || path.join(HERE, '..', 'web'),
  captureDir: process.env.SDRFLEX_CAPTURES || path.join(HERE, '..', 'captures'),
  quiet: process.env.SDRFLEX_QUIET === '1',
  // Ring recordings are scratch: sized up front, deleted when the tab goes away. On a
  // box where /tmp is a small tmpfs, sixty seconds of 2.4 MS/s cu8 is 288 MB of RAM,
  // so this is worth being able to point at a disk.
  ringDir: process.env.SDRFLEX_RINGS || os.tmpdir(),
  // Decoders the box offers every tab. The default is the directory in this repository,
  // so what ships with the tool is actually in the tool.
  pluginDir: process.env.SDRFLEX_PLUGINS || path.join(HERE, '..', 'web', 'plugins'),
  // Decoders you added (ADR-0026). Unset by default: an adapter is a command line, so
  // this directory only exists because you said where it is.
  adapterDir: process.env.SDRFLEX_ADAPTERS || null,
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
/**
 * Which addresses to answer on.
 *
 * Always loopback, and the tailnet too if there is one. Binding to *only* the tailnet
 * address was the obvious reading of "do not expose this on the LAN" and it is wrong:
 * it locks out the machine the server is running on. Under WSL, where Tailscale runs
 * inside the distro and the browser is on Windows, that is not a corner case — it is
 * the normal arrangement, and the symptom is a server you cannot reach from your own
 * desktop.
 *
 * Loopback costs nothing. It reaches no other machine by definition, and Windows
 * forwards its own localhost into WSL, so adding it is what makes the browser on the
 * same computer work without opening anything up.
 */
export function pickAddresses(bind, interfaces = os.networkInterfaces()) {
  if (bind && bind !== 'auto') {
    return String(bind).split(',').map((h) => h.trim()).filter(Boolean)
      .map((host) => ({ host, why: 'SDRFLEX_BIND' }));
  }
  const out = [{ host: '127.0.0.1', why: 'this machine' }];
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      // 100.64.0.0/10 is the CGNAT range Tailscale hands out
      const [o1, o2] = a.address.split('.').map(Number);
      if (o1 === 100 && o2 >= 64 && o2 <= 127) out.push({ host: a.address, why: `tailnet (${name})` });
    }
  }
  return out;
}

/** Kept for the single-address question: what one address would this bind to? */
export function pickAddress(bind, interfaces = os.networkInterfaces()) {
  const all = pickAddresses(bind, interfaces);
  return all[all.length - 1];
}

/** Windows forwards its own localhost into the distro, which is worth saying once. */
function underWSL() {
  try { return /microsoft|wsl/i.test(fs.readFileSync('/proc/version', 'utf8')); } catch { return false; }
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

export function createServer({ webDir, captureDir, quiet, ringDir, pluginDir } = CONFIG) {
  const log = quiet ? () => {} : (...a) => console.log('[sdr-flex]', ...a);
  const library = captureDir && fs.existsSync(captureDir) ? new Library(captureDir) : null;
  if (!library) log(`no capture directory at ${captureDir} — the synthetic scene only`);
  const dir = pluginDir === undefined ? CONFIG.pluginDir : pluginDir;
  const plugins = dir && fs.existsSync(dir) ? new PluginDir(dir) : null;

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
    const s = new Session(conn, { library, log, pluginDir: plugins,
                                  ringDir: ringDir || CONFIG.ringDir });
    conn.on('close', () => log('client gone'));
    return s;
  });

  return { server, library, plugins, log };
}

/**
 * Read `SDRFLEX_ADAPTERS` into the table.
 *
 * A pack that clashes with a decoder that ships with the tool is refused rather than
 * allowed to win: silently shadowing `rtl_433` with something else called `rtl_433`
 * would be a very confusing afternoon.
 */
async function loadLocalAdapters(cfg) {
  if (!cfg.adapterDir) return { adapters: [], problems: [] };
  const { adapters: found, problems } = await new AdapterDir(cfg.adapterDir).load();
  const added = [];
  for (const { id, spec } of found) {
    try { adapters.register(id, spec); added.push(id); }
    catch (e) { problems.push({ pack: spec.local.pack, why: e.message }); }
  }
  return { adapters: added, problems };
}

export async function start(cfg = CONFIG) {
  // Decoders the operator added, before anything is probed — they are adapters like any
  // other once they are in the table, and one that fails to load says why rather than
  // simply not appearing.
  const local = await loadLocalAdapters(cfg);

  // Then ask every decoder whether it is here, rather than on somebody's first click.
  // Most answer instantly — a name on PATH — but a GNU Radio flowgraph has to be probed
  // by asking an interpreter to import a module, which is half a second each, and the
  // palette asks for this synchronously.
  const decoders = adapters.warm();
  const hosts = pickAddresses(cfg.bind);
  // One listener per address, sharing one set of handlers. Node binds a server to a
  // single address, and the alternative — 0.0.0.0 — is every interface on the machine,
  // which is the thing this is avoiding.
  const servers = hosts.map(() => createServer(cfg));
  const { library, log } = servers[0];
  let listening = 0;

  const banner = () => {
    if (++listening < servers.length) return;
    for (const { host, why } of hosts) log(`http://${host}:${cfg.port}  — ${why}`);
    if (underWSL() && hosts.some((h) => h.host === '127.0.0.1')) {
      log('under WSL: Windows reaches that first address as http://localhost:' + cfg.port);
    }
    if (library) {
      const n = library.list().length;
      log(`${n} capture${n === 1 ? '' : 's'} in ${cfg.captureDir}`);
    }
    if (cfg.pluginDir && fs.existsSync(cfg.pluginDir)) {
      const n = new PluginDir(cfg.pluginDir).list().length;
      log(`${n} plugin${n === 1 ? '' : 's'} in ${cfg.pluginDir}`);
    }
    const table = adapters.list();
    log(`${decoders} of ${table.length} external decoders installed: ` +
        (table.filter((a) => a.available).map((a) => a.name).join(', ') || 'none'));
    if (cfg.adapterDir) {
      log(`${local.adapters.length} of those are yours, from ${cfg.adapterDir}`);
      for (const p of local.problems) log(`  ${p.pack} did not load: ${p.why}`);
    }
    const host = hosts[0].host;
    if (hosts.some((h) => h.host === '0.0.0.0')) {
      // Inside a container this is correct and says nothing about the host: what the
      // host exposes is the port publish, and compose scopes that to one address.
      // Outside one it means every interface on the machine, which is a different
      // thing entirely and worth saying out loud.
      if (fs.existsSync('/.dockerenv')) {
        log('listening on all interfaces inside the container — what the host exposes');
        log('is the port publish, so keep it scoped to the tailnet address');
      } else {
        log('WARNING: bound to every interface on this machine. There is no');
        log('         authentication in front of this. Leaving SDRFLEX_BIND unset');
        log('         answers on loopback and the tailnet only.');
      }
    }
  };

  servers.forEach((s, i) => s.server.listen(cfg.port, hosts[i].host, banner));
  return servers[0].server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) start();
