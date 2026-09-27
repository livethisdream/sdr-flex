// The build stamp, and the check that compares it with what is running.
//
// This exists because "I rebuilt it and I do not think it took" happened, and the answer
// took three wrong guesses to find. The check is now the thing that answers it, so the
// check has to be right about the cases it is for: the running build matches, the running
// build does not match, and the server is old enough not to have a /version at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { version, versionLine } from '../../server/version.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A server that answers /version however the case wants, on a port nobody chose. */
async function stub(handler) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

function run(url) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['check-build.mjs', url], { cwd: ROOT },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout + stderr }));
  });
}

test('the stamp is a hash of the code, and says what went into it', () => {
  const v = version();
  assert.match(v.id, /^[0-9a-f]{12}$/);
  assert.ok(v.files > 20, `expected a real file count, got ${v.files}`);
  assert.equal(version().id, v.id, 'computed twice, the same both times');
  assert.match(versionLine(v), /^build [0-9a-f]{12} · \d+ files · /);
});

test('a date it could not determine does not become a wrong date', () => {
  assert.match(versionLine({ id: 'a'.repeat(12), files: 3, builtAt: null, git: null }),
               /unknown date/);
  // The sha is a hint, so it is simply absent rather than faked when there is no checkout.
  assert.ok(!versionLine({ id: 'b'.repeat(12), files: 3, builtAt: null, git: null }).includes('git'));
});

test('the same id running as on disk is the answer the check exists to give', async () => {
  const v = version();
  const s = await stub((req, res) => {
    assert.equal(req.url, '/version');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...v, line: versionLine(v) }));
  });
  const { code, out } = await run(s.url);
  s.close();
  assert.equal(code, 0, out);
  assert.match(out, /the running build is this checkout/);
});

test('a different id running is a rebuild that did not take, and says what to run', async () => {
  const s = await stub((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'deadbeefcafe', files: 1, builtAt: null, git: null,
                             line: 'build deadbeefcafe' }));
  });
  const { code, out } = await run(s.url);
  s.close();
  assert.equal(code, 1, out);
  assert.match(out, /the rebuild did not take/);
  // Not "restart the container": the build is the thing that failed, and the one line
  // that says so is buried in a ten-minute log unless you go and look for it.
  assert.match(out, /docker compose build/);
});

test('no /version at all is itself the diagnosis, not a failure to check', async () => {
  const s = await stub((req, res) => { res.writeHead(404); res.end('not found'); });
  const { code, out } = await run(s.url);
  s.close();
  assert.equal(code, 2, out);
  assert.match(out, /older than the version stamp/);
});

test('nothing listening is reported as nothing listening', async () => {
  // Port 1 on loopback: privileged, unbound, and refuses immediately rather than hanging.
  const { code, out } = await run('http://127.0.0.1:1');
  assert.equal(code, 2, out);
  assert.match(out, /nothing answered/);
});
