// The server's handle on one GNU Radio worker (ADR-0044).
//
// Requests go out as JSON lines and come back in order, one reply each. A reply that carries
// samples says how many bytes, and those are read from a second pipe the worker's flowgraphs
// write to directly — fd 3 in the worker — so no sample passes through its Python (ADR-0014).
// If the worker dies, whatever was waiting fails and the next request starts a new one: a
// crash in GNU Radio costs a request, not the session (ADR-0003).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export class GrWorker {
  constructor({ python = process.env.SDRFLEX_GR_PYTHON || 'python3', log = () => {} } = {}) {
    this.python = python;
    this.log = log;
    this.proc = null;
    this.starts = 0;
  }

  /** Start it if it is not running; resolves when it has answered a ping. */
  async start() {
    if (this.proc) return this.ready;
    const t0 = performance.now();
    const proc = spawn(this.python, [path.join(HERE, 'worker.py')], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, SDRFLEX_GR_DATA_FD: '3', PYTHONUNBUFFERED: '1' },
    });
    this.proc = proc;
    this.starts++;
    this.pending = [];                    // { resolve, reject, head?, need }
    this.ctl = '';
    this.data = [];
    this.dataLen = 0;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (s) => { this.ctl += s; this._pump(); });
    proc.stdio[3].on('data', (b) => { this.data.push(b); this.dataLen += b.length; this._pump(); });
    proc.stderr.on('data', (b) => {
      // GNU Radio's own logging is chatty and not ours to repeat; anything else is.
      const s = String(b).trim();
      if (s && !/^(gr::log|\[INFO)/.test(s)) this.log(`gr worker: ${s.split('\n')[0]}`);
    });
    proc.on('exit', (code, signal) => {
      if (this.proc !== proc) return;
      this.proc = null;
      const err = new Error(`GNU Radio worker exited (${signal || code})`);
      for (const p of this.pending) p.reject(err);
      this.pending = [];
    });
    this.ready = this._send({ op: 'ping' }).then((r) => {
      this.version = r.head.gnuradio;
      this.startMs = performance.now() - t0;
      return r.head;
    });
    return this.ready;
  }

  /** One request; resolves to `{ head, bytes }`, `bytes` a Buffer when the reply carries samples. */
  async request(req) {
    if (!this.proc) await this.start();
    else await this.ready;
    return this._send(req);
  }

  _send(req) {
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject, head: null });
      this.proc.stdin.write(JSON.stringify(req) + '\n');
    });
  }

  _pump() {
    for (;;) {
      const p = this.pending[0];
      if (!p) return;
      if (!p.head) {
        const nl = this.ctl.indexOf('\n');
        if (nl < 0) return;
        p.head = JSON.parse(this.ctl.slice(0, nl));
        this.ctl = this.ctl.slice(nl + 1);
      }
      const need = p.head.bytes || 0;
      if (this.dataLen < need) return;
      let bytes = null;
      if (need) {
        const all = Buffer.concat(this.data, this.dataLen);
        bytes = all.subarray(0, need);
        const rest = all.subarray(need);
        this.data = rest.length ? [rest] : [];
        this.dataLen = rest.length;
      }
      this.pending.shift();
      if (p.head.ok === false) p.reject(new Error(p.head.error));
      else p.resolve({ head: p.head, bytes });
    }
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    if (proc) { proc.stdin.end(); proc.kill(); }
  }
}
