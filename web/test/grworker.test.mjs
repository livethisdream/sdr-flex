// The GNU Radio worker in the server (ADR-0044, migration step 0).
//
//   node --test web/test/grworker.test.mjs
//
// Skipped where GNU Radio is not installed; it runs in the image `Dockerfile.full` builds.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { GrWorker } from '../../server/gr/worker.js';

const python = process.env.SDRFLEX_GR_PYTHON || 'python3';
const hasGr = spawnSync(python, ['-c', 'import gnuradio.gr'], { stdio: 'ignore' }).status === 0;

test('the worker starts, says which GNU Radio it is, and does so quickly', { skip: !hasGr && 'GNU Radio is not installed' }, async (t) => {
  const w = new GrWorker();
  t.after(() => w.stop());
  const head = await w.start();
  assert.match(head.gnuradio, /^\d+\.\d+/);
  t.diagnostic(`GNU Radio ${w.version}, up in ${w.startMs.toFixed(0)} ms`);
  assert.ok(w.startMs < 300, `start took ${w.startMs.toFixed(0)} ms; the gate is 300`);
});

test('samples arrive on the data pipe, exactly as many as the reply says', { skip: !hasGr && 'GNU Radio is not installed' }, async (t) => {
  // A known tone is the known answer: its phase has to advance by 2π·hz/rate per sample.
  const w = new GrWorker();
  t.after(() => w.stop());
  const rate = 48_000, hz = 1_000, count = 4_800;
  const { head, bytes } = await w.request({ op: 'tone', hz, rate, count });
  assert.equal(head.bytes, count * 8);
  assert.equal(bytes.length, count * 8);
  const iq = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  let turn = 0;
  for (let i = 1; i < count; i++) {
    const re = iq[i * 2] * iq[(i - 1) * 2] + iq[i * 2 + 1] * iq[(i - 1) * 2 + 1];
    const im = iq[i * 2 + 1] * iq[(i - 1) * 2] - iq[i * 2] * iq[(i - 1) * 2 + 1];
    turn += Math.atan2(im, re);
  }
  const measured = (turn / (count - 1)) * rate / (2 * Math.PI);
  assert.ok(Math.abs(measured - hz) < 0.01, `tone at ${measured} Hz`);
  // Two in a row stay in step: the second reply gets its own bytes, not the tail of the first.
  const again = await w.request({ op: 'tone', hz: 2_000, rate, count: 100 });
  assert.equal(again.bytes.length, 800);
});

test('a worker that dies is replaced, and the session carries on', { skip: !hasGr && 'GNU Radio is not installed' }, async (t) => {
  const w = new GrWorker();
  t.after(() => w.stop());
  await w.start();
  const dead = new Promise((r) => w.proc.once('exit', r));
  w.proc.kill('SIGKILL');
  await dead;
  const { head } = await w.request({ op: 'ping' });
  assert.ok(head.ok);
  assert.equal(w.starts, 2, 'a second worker was started');
});

test('a bad request is an error for that request, not for the worker', { skip: !hasGr && 'GNU Radio is not installed' }, async (t) => {
  const w = new GrWorker();
  t.after(() => w.stop());
  await assert.rejects(w.request({ op: 'no-such-op' }), /KeyError/);
  const { head } = await w.request({ op: 'ping' });
  assert.ok(head.ok);
  assert.equal(w.starts, 1);
});

test('a worker stopped on purpose stays stopped', { skip: !hasGr && 'GNU Radio is not installed' }, async (t) => {
  // A crash restarts it; a session closing must not have its worker started again by
  // whatever was still in flight, such as a prefetch.
  const w = new GrWorker();
  await w.start();
  w.stop();
  await assert.rejects(w.request({ op: 'ping' }), /stopped/);
  assert.equal(w.proc, null);
  assert.equal(w.starts, 1);
});
