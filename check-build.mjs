// Is the thing running the thing I built?
//
// Three separate things have to line up, and when a rebuild "does not take" it is
// always one of them rather than the one people reach for:
//
//   1. the checkout is current      — `git pull` was the missing step, twice
//   2. the build succeeded          — `docker compose up -d --build` leaves the running
//                                     container alone when the build fails, so a failed
//                                     build and a build that did nothing look identical
//   3. the container was replaced   — an image that rebuilt to the same bytes does not
//                                     recreate anything, which is correct and confusing
//
// This checks all three and says which one is wrong. Run it on the host, in the checkout
// that `docker compose` builds from:
//
//   node check-build.mjs
//   node check-build.mjs http://box:8722
//
// Exit 0 when the running build is this checkout, 1 when it is not, 2 when it could not
// be reached and there is therefore nothing to compare.

import { execFileSync } from 'node:child_process';
import { version, versionLine } from './server/version.js';

const base = (process.argv[2] || process.env.SDRFLEX_URL || 'http://127.0.0.1:8722')
  .replace(/\/+$/, '');

const sh = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
};

let bad = false;
const say = (ok, line) => { if (!ok) bad = true; console.log(`${ok ? '  ok  ' : ' NOT  '}${line}`); };

// ── 1. the checkout ──────────────────────────────────────────────────────────────────
const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
const head = sh('git', ['rev-parse', '--short', 'HEAD']);
const dirty = sh('git', ['status', '--porcelain']);
console.log(`\ncheckout  ${process.cwd()}`);
console.log(`          ${branch || '(not a git checkout)'} at ${head || '?'}${dirty ? ' (uncommitted edits)' : ''}`);

if (branch && branch !== 'HEAD') {
  // Only what is already fetched: this must not reach the network, because a check that
  // hangs on a dead remote is a check nobody runs.
  const up = sh('git', ['rev-parse', '--short', `${branch}@{upstream}`]);
  if (up) {
    const behind = sh('git', ['rev-list', '--count', `HEAD..${branch}@{upstream}`]);
    say(behind === '0', behind === '0'
      ? `up to date with its upstream as of the last fetch`
      : `${behind} commit(s) behind ${up} — run \`git fetch && git pull\` first`);
  } else {
    console.log(`        (no upstream branch, so there is nothing to be behind)`);
  }
}

// ── 2. what this checkout would build ────────────────────────────────────────────────
const want = version();
console.log(`\nthis checkout is  ${versionLine(want)}`);

// ── 3. what is answering ─────────────────────────────────────────────────────────────
let got = null, why = null;
try {
  const r = await fetch(`${base}/version`, { signal: AbortSignal.timeout(4000) });
  if (r.status === 404) {
    why = 'the server answered, but has no /version at all — it is older than the version '
        + 'stamp itself (before 09-19), so the build has not been replaced in days';
  } else if (!r.ok) {
    why = `the server answered ${r.status}`;
  } else {
    got = await r.json();
  }
} catch (e) {
  why = `nothing answered at ${base} (${e.message}) — is it up, and is the port published `
      + 'on an address this machine can reach? SDRFLEX_HOST_IP defaults to loopback.';
}

if (got) console.log(`running          ${got.line || got.id}`);

// ── the docker side, when there is one ───────────────────────────────────────────────
const started = sh('docker', ['inspect', '-f', '{{.State.StartedAt}}', 'sdr-flex']);
if (started) {
  const hours = (Date.now() - Date.parse(started)) / 3.6e6;
  const img = sh('docker', ['inspect', '-f', '{{.Image}}', 'sdr-flex']);
  console.log(`\ncontainer sdr-flex started ${started} (${hours.toFixed(1)} h ago)`
            + `${img ? `, image ${img.replace('sha256:', '').slice(0, 12)}` : ''}`);
}

console.log('');
if (!got) {
  console.log(` NOT  ${why}`);
  process.exit(2);
}

say(got.id === want.id, got.id === want.id
  ? `the running build is this checkout (${want.id})`
  : `the running build is ${got.id}, this checkout is ${want.id} — the rebuild did not take`);

if (got.id !== want.id) {
  console.log(`
The build is what to look at, not the container. Run it on its own so the error is the
last thing on screen instead of a line somewhere in a ten-minute log:

    SDRFLEX_DOCKERFILE=Dockerfile.full docker compose build 2>&1 | tail -40

If that succeeds, \`docker compose up -d\` replaces the container. If it fails, the
container you are talking to is the old one and always was — that is the whole bug.`);
}

process.exit(bad ? 1 : 0);
