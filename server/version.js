// What is this, exactly?
//
// "I rebuilt the image and I do not think it took" is not a question anything here could
// answer. The banner said how many decoders were installed, which is a good functional
// check and a bad identity check: it is the same line before and after a change that has
// nothing to do with decoders.
//
// **The version is a hash of the code, not a number somebody remembers to bump.** There
// is no build step in this project (no bundler, no package version to increment), and a
// number maintained by hand is a number that is wrong exactly when it matters — after
// the change somebody forgot to bump it for. Hashing what is actually on disk cannot
// drift from what is actually running, and it answers the real question: is the code in
// this container the code I think I put there?
//
// A git sha rides along when there is a `.git` to read one from, because a human tracking
// down "which commit is this" wants the commit. It is not the identity: the image has no
// `.git` in it at all (`Dockerfile.full` copies `web`, `server`, `fixtures` and nothing
// else), and a checkout with uncommitted edits has a sha that describes a different tree
// than the one running. The hash is the identity; the sha is a hint.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

// What decides how this behaves. Captures and fixtures are data — a capture added to the
// library is not a different build of the tool — and `node_modules` does not exist here.
const WATCHED = [
  ['server', /\.(js|mjs)$/],
  ['web', /\.(js|mjs|css|html)$/],
];

let cached = null;

/** Every file whose contents are part of what this build *is*, in a stable order. */
function sources() {
  const out = [];
  const walk = (dir, re) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full, re); continue; }
      if (re.test(e.name)) out.push(full);
    }
  };
  for (const [dir, re] of WATCHED) walk(path.join(ROOT, dir), re);
  return out;
}

/** The commit, when there is a checkout to read one out of. Never the identity. */
function git() {
  try {
    const dir = path.join(ROOT, '.git');
    const head = fs.readFileSync(path.join(dir, 'HEAD'), 'utf8').trim();
    const sha = head.startsWith('ref: ')
      ? fs.readFileSync(path.join(dir, head.slice(5)), 'utf8').trim()
      : head;
    return /^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 7) : null;
  } catch {
    // No `.git`, which is the normal case in a container and not a problem.
    return null;
  }
}

/**
 * The stamp. Computed once — the files cannot change under a running server without a
 * restart, because a restart is what deploying them is.
 */
export function version() {
  if (cached) return cached;
  const h = crypto.createHash('sha256');
  const files = sources();
  let newest = 0;
  for (const f of files) {
    try {
      const st = fs.statSync(f);
      if (st.mtimeMs > newest) newest = st.mtimeMs;
      // The path as well as the contents: a file renamed is a different build, and two
      // files whose contents swap places are not the same build as before.
      h.update(path.relative(ROOT, f).replace(/\\/g, '/')).update('\0').update(fs.readFileSync(f));
    } catch { /* a file that vanished mid-walk is not part of this build */ }
  }
  cached = {
    // Twelve hex characters. Long enough that two builds colliding is not a thing that
    // happens, short enough to read out over a call and compare by eye.
    id: h.digest('hex').slice(0, 12),
    files: files.length,
    builtAt: newest ? new Date(newest).toISOString() : null,
    git: git(),
    node: process.version,
  };
  return cached;
}

/** One line for the banner and the same words everywhere else. */
export function versionLine(v = version()) {
  const when = v.builtAt ? v.builtAt.replace('T', ' ').slice(0, 16) + 'Z' : 'unknown date';
  return `build ${v.id} · ${v.files} files · ${when}${v.git ? ` · git ${v.git}` : ''}`;
}
