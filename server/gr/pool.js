// Several GNU Radio workers for one session, and a queue in front of them with priorities.
//
// One worker answered in arrival order, so after a retune the block a spectrum was waiting on
// (about 12 ms of work) sat behind stereo blocks other views and the prefetch had asked for
// (about 50 ms each). The queue here lets what a frame is waiting on go first, the pool lets
// independent blocks compute at the same time, and one worker is kept for frames alone. Each worker is still one session's alone
// (ADR-0003); a crash in one fails its request and the next starts a replacement.
import { GrWorker } from './worker.js';

export const PRIORITY = { frame: 0, read: 1, prefetch: 2 };

export class GrPool {
  constructor({ size = Number(process.env.SDRFLEX_GR_WORKERS) || 4, log = () => {} } = {}) {
    this.workers = Array.from({ length: Math.max(1, size) }, () => new GrWorker({ log }));
    this.busy = new Set();
    this.queue = [];              // { req, priority, seq, resolve, reject }
    this.seq = 0;
  }

  async start() {
    const heads = await Promise.all(this.workers.map((w) => w.start()));
    this.version = this.workers[0].version;
    this.startMs = Math.max(...this.workers.map((w) => w.startMs));
    return heads[0];
  }

  get starts() { return this.workers.reduce((n, w) => n + w.starts, 0); }

  request(req, priority = PRIORITY.read, key = null) {
    if (this.stopped) return Promise.reject(new Error('GNU Radio worker was stopped'));
    return new Promise((resolve, reject) => {
      this.queue.push({ req, priority, key, seq: this.seq++, resolve, reject });
      this._next();
    });
  }

  /** A queued job something more urgent is now waiting on moves up; a running one is unaffected. */
  raise(key, priority) {
    for (const job of this.queue) if (job.key === key && priority < job.priority) job.priority = priority;
  }

  _next() {
    for (const w of this.workers) {
      if (this.busy.has(w) || !this.queue.length) continue;
      // The first worker is kept for what a view is waiting on. A queue alone could put a
      // retuned spectrum's block first in line and still leave it waiting for whichever ~50 ms
      // stereo block finished first; with a lane of its own it starts at once.
      const reserved = this.workers.length > 1 && w === this.workers[0];
      // Highest priority first, oldest first within it.
      let at = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const a = this.queue[i];
        if (reserved && a.priority !== PRIORITY.frame) continue;
        const b = at < 0 ? null : this.queue[at];
        if (!b || a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) at = i;
      }
      if (at < 0) continue;
      const job = this.queue.splice(at, 1)[0];
      this.busy.add(w);
      w.request(job.req).then(job.resolve, job.reject).finally(() => { this.busy.delete(w); this._next(); });
    }
  }

  stop() {
    this.stopped = true;
    const err = new Error('GNU Radio worker was stopped');
    for (const job of this.queue) job.reject(err);
    this.queue = [];
    for (const w of this.workers) w.stop();
  }
}
