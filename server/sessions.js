// Sessions on the box: a directory of JSON, and nothing else.
//
// The same reasoning as `library.js` — no database, no import step, no state that can
// disagree with the disk. A session is a few kilobytes of recipe (`web/src/resume.js`),
// one file each, and the listing is a directory scan.
//
// **Where they go is not arbitrary.** They live inside the capture directory, because
// that is the directory somebody mounted. A sessions directory alongside the source tree
// is a sessions directory inside the image, and the first `docker compose up --build`
// after a week's work would delete exactly the thing this feature exists to keep. The
// library's scan only picks up files with sample extensions and skips anything that is
// not a file, so a subdirectory of JSON is invisible to it.
//
// **This is the first thing the server writes on behalf of a client**, which is worth
// saying out loud given there is no authentication in front of it (see `main.js` on
// binding). Three rules keep that small: an id has to match `ID_RE` before it becomes a
// path, the only thing ever written is one `.json` per id inside this one directory, and
// a body larger than `MAX_BYTES` is refused unread.

import fs from 'node:fs';
import path from 'node:path';
import { ID_RE } from '../web/src/sessions.js';

/** A recipe is kilobytes. A megabyte is already a hundred times more than one can be. */
export const MAX_BYTES = 1 << 20;

export class SessionStore {
  constructor(root) {
    this.root = root;
  }

  /**
   * The directory, made on the first write rather than at startup.
   *
   * A box that never saves a session should not grow an empty directory in the place
   * people keep their captures.
   */
  _ensure() {
    fs.mkdirSync(this.root, { recursive: true });
    return this.root;
  }

  _path(id) {
    if (!ID_RE.test(String(id || ''))) throw new Error('that is not a session id');
    return path.join(this.root, `${id}.json`);
  }

  /** Every session, newest first, without the recipes. */
  list() {
    let names;
    try { names = fs.readdirSync(this.root); } catch { return []; }
    const out = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (!ID_RE.test(id)) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(this.root, name), 'utf8'));
        if (!rec || rec.v !== 1) continue;
        const { recipe: _r, ...rest } = rec;
        out.push({ ...rest, id });
      } catch { /* a file somebody edited by hand is not a reason to lose the rest */ }
    }
    return out.sort((a, b) => (b.at || 0) - (a.at || 0));
  }

  read(id) {
    try { return JSON.parse(fs.readFileSync(this._path(id), 'utf8')); }
    catch { return null; }
  }

  /**
   * Write one, atomically.
   *
   * Through a temporary file and a rename, because the failure otherwise is the worst
   * one this feature can have: a full disk or a container stopped mid-write leaves a
   * half-written session where a whole one used to be, and the listing still shows it.
   * A rename either happens or does not.
   */
  write(id, rec) {
    if (!rec || rec.v !== 1 || !rec.recipe || !Array.isArray(rec.recipe.nodes)) {
      throw new Error('that is not a session');
    }
    const full = this._path(id);
    this._ensure();
    const saved = { ...rec, id, at: rec.at || Date.now() };
    const tmp = `${full}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(saved));
    fs.renameSync(tmp, full);
    return saved;
  }

  remove(id) {
    try { fs.unlinkSync(this._path(id)); return true; }
    catch { return false; }
  }
}
