// Work that outlives the tab.
//
// `resume.js` writes down what is on screen every three seconds and offers it back on
// the next load. That covers the accident — a mis-clicked reload, a crash, a container
// restart — and it is one slot, overwritten continuously, in one browser. Close the tab
// for good and come back on Tuesday and there is nothing to come back to.
//
// A session is the same recipe, **named, listed and kept until somebody deletes it**.
// Nothing here is a new description of a graph: `resume.recipe` already produces one and
// already argues why it is a recipe rather than a snapshot. This module is the part that
// was missing, which is somewhere to put it and a way to find it again.
//
// ## Why a recipe and not a live engine
//
// The other design was the server holding a session open that a client reattaches to.
// It is the wrong one here for a reason that has nothing to do with effort: **this tool
// runs with no server at all.** Open `web/index.html`, or the hosted copy, and the
// engine is in the tab (`?engine=mock`). A session that lives in a server process is a
// feature the primary deployment cannot have. It also inverts ADR-0029 — the client owns
// the clock, and a held session holds a playhead — and it would store derived values,
// which ADR-0017 spends its length arguing against. See ADR-0042.
//
// ## Two stores, one shape
//
// With a box, sessions live on the box, so the work follows you between browsers and
// machines. Without one they live in this browser. The difference is where `list` reads
// from; a session written by one is the same JSON as a session written by the other, so
// exporting from a tab and dropping it on a box is a copy, not a conversion.

import { recipe } from './resume.js';

const STORE = 'sdrflex.sessions.v1';

/** Enough that nobody meets it in a year of use; small enough that the store cannot fill. */
export const MAX_LOCAL = 100;

/**
 * An id that is safe to be a filename and readable when it is one.
 *
 * The server turns an id into a path, so this is the one place a name typed by a person
 * becomes something a filesystem sees. Everything outside `[a-z0-9-]` goes, which takes
 * `..` and `/` with it, and the short suffix means two sessions called "fm" are two
 * sessions rather than one overwriting the other.
 */
export function idFor(name, now = Date.now(), rand = Math.random) {
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 48) || 'session';
  const tail = Math.floor(rand() * 36 ** 4).toString(36).padStart(4, '0');
  return `${slug}-${tail}`;
}

/** The shape the server also validates. Kept here so both ends agree by construction. */
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * What gets written down: the recipe, a name, and when.
 *
 * `nodes` and `source` are lifted out of the recipe so a listing can say what a session
 * is without reading every one of them. They are a copy of what is inside it, which is
 * exactly the kind of thing this codebase avoids elsewhere — but a listing that has to
 * open fifty files to draw fifty lines is a listing that gets slow on a box with a disk,
 * and these two facts are fixed the moment the session is written.
 */
export function make(name, r, { id = null, at = Date.now() } = {}) {
  if (!r) return null;
  const clean = String(name || '').trim().slice(0, 120) || 'untitled';
  return {
    v: 1,
    id: id || idFor(clean, at),
    name: clean,
    at,
    nodes: r.nodes.length,
    source: r.source,
    recipe: r,
  };
}

/** The recipe for what is on screen, named. Null when there is nothing worth keeping. */
export function fromEngine(engine, view, name) {
  return make(name, recipe(engine, view));
}

/**
 * Whether this is worth saving at all, and what to say when it is not.
 *
 * A live radio is the one refusal. `resume.canReplay` already declines to restore one —
 * the samples it was reading are gone and starting the radio again is a different signal
 * wearing the same name — and a list that offers to open something that can never open
 * is worse than a list that would not take it.
 */
export function canSave(r) {
  if (!r) return { ok: false, why: 'there is no chain here to save' };
  const kind = r.source && r.source.kind;
  if (kind === 'live') {
    return { ok: false, why: 'a radio is not a recording — save a ring first, then save that' };
  }
  return { ok: true };
}

/** One line for a menu: what it is, and what it was built on. */
export function describe(rec) {
  const n = rec.nodes === 1 ? '1 node' : `${rec.nodes} nodes`;
  const on = (rec.source && rec.source.label) || 'a capture';
  return `${rec.name} — ${n} on ${on} · ${ago(rec.at)}`;
}

export function ago(at, now = Date.now()) {
  const s = Math.max(0, (now - at) / 1000);
  if (s < 90) return 'just now';
  const m = s / 60;
  if (m < 90) return `${Math.round(m)} min ago`;
  const h = m / 60;
  if (h < 36) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

// ── in this browser ─────────────────────────────────────────────────────────

/**
 * Sessions in `localStorage`, for the tab with no server behind it.
 *
 * One key holding the lot rather than a key each. They are a few kilobytes apiece, a
 * listing wants all of them anyway, and one key is one thing to clear and one thing that
 * can be exported by hand from a console.
 */
export class LocalStore {
  constructor(storage = null) {
    this._s = storage;
    this.where = 'this browser';
  }

  _store() {
    if (this._s) return this._s;
    try { return globalThis.localStorage || null; } catch { return null; }
  }

  _all() {
    try {
      const raw = JSON.parse(this._store()?.getItem(STORE) || 'null');
      return Array.isArray(raw) ? raw.filter((r) => r && r.v === 1 && r.recipe) : [];
    } catch { return []; }
  }

  _write(all) {
    try { this._store()?.setItem(STORE, JSON.stringify(all)); return true; }
    catch { return false; }
  }

  /** Newest first, without the recipes — the same shape the server's listing returns. */
  async list() {
    return this._all().map(({ recipe: _r, ...rest }) => rest).sort((a, b) => b.at - a.at);
  }

  async load(id) {
    return this._all().find((r) => r.id === id) || null;
  }

  async save(rec) {
    const all = this._all().filter((r) => r.id !== rec.id);
    all.unshift(rec);
    all.sort((a, b) => b.at - a.at);
    // Oldest first out of the door, and only ever to make room.
    if (!this._write(all.slice(0, MAX_LOCAL))) {
      throw new Error('this browser would not store that — its storage is full');
    }
    return rec;
  }

  async remove(id) {
    this._write(this._all().filter((r) => r.id !== id));
    return true;
  }
}

// ── on the box ──────────────────────────────────────────────────────────────

/**
 * Sessions on the server, over HTTP rather than over the socket.
 *
 * The socket's dispatch table is deliberately the set of calls `MockEngine` already had
 * — that is the whole point of the exercise recorded at the top of `server/session.js`,
 * and it is only meaningful if the calls do not grow to make it true. A session is a
 * document, not a graph operation, so it goes over the thing that already serves
 * documents. It also means a session can be backed up with `curl`, which is the same
 * reason `/version` is there.
 */
export class HttpStore {
  constructor(base = '', fetchFn = null) {
    this.base = base;
    this._fetch = fetchFn;
    this.where = 'the box';
  }

  async _call(path, opts = {}) {
    const f = this._fetch || globalThis.fetch;
    if (!f) throw new Error('this browser cannot reach the box');
    const res = await f(`${this.base}/sessions${path}`, opts);
    if (res.status === 404 && opts.method === 'GET') return null;
    if (!res.ok) throw new Error(await res.text().catch(() => `the box said ${res.status}`));
    return res.status === 204 ? true : res.json();
  }

  async list() { return (await this._call('', { method: 'GET' }))?.sessions || []; }

  async load(id) { return this._call(`/${encodeURIComponent(id)}`, { method: 'GET' }); }

  async save(rec) {
    return this._call(`/${encodeURIComponent(rec.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rec),
    });
  }

  async remove(id) {
    await this._call(`/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return true;
  }
}

/**
 * Which store this page has.
 *
 * The box says so in `hello` rather than being probed for it. A probe would have to tell
 * "no session directory" apart from "not a box at all", and on a static host the answer
 * to `GET /sessions` is a 404 page rather than a 404 — which parses as neither.
 */
export function storeFor({ sessions = false, base = '' } = {}) {
  return sessions ? new HttpStore(base) : new LocalStore();
}
