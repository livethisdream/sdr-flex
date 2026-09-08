// The acceptance test for moving the engine off the tab.
//
// Two engines, the same graph built by the same calls, and the same numbers out. If
// this passes, the interface designed against the in-tab mock carried a real backend
// without changing, which was the entire question. Node 22 ships a WebSocket, so the
// client engine runs here with no browser in the way — the code under test is exactly
// the file the browser loads.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockEngine } from '../src/engine.js';
import { RemoteEngine } from '../src/remote.js';
import { Capture } from '../src/capture.js';
import { createServer } from '../../server/main.js';

const RATE = 200_000, CENTER = 433_900_000, TONE = 12_000, SAMPLES = 200_000;

/** A capture on disk, so both engines read the same samples — one via fs, one via RAM. */
function writeCapture(dir) {
  const bytes = Buffer.alloc(SAMPLES * 2);
  for (let i = 0; i < SAMPLES; i++) {
    const t = i / RATE;
    bytes[i * 2] = Math.round(127.5 + 90 * Math.cos(2 * Math.PI * TONE * t));
    bytes[i * 2 + 1] = Math.round(127.5 + 90 * Math.sin(2 * Math.PI * TONE * t));
  }
  fs.writeFileSync(path.join(dir, 'tone.sigmf-data'), bytes);
  fs.writeFileSync(path.join(dir, 'tone.sigmf-meta'), JSON.stringify({
    global: { 'core:datatype': 'cu8', 'core:sample_rate': RATE },
    captures: [{ 'core:sample_start': 0, 'core:frequency': CENTER }],
  }));
  return { id: 'tone.sigmf-data', bytes };
}

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdrflex-parity-'));
  const { id, bytes } = writeCapture(dir);
  const { server } = createServer({ webDir: dir, captureDir: dir, quiet: true });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const remote = new RemoteEngine(`ws://127.0.0.1:${server.address().port}/ws`);
  await remote.connect();
  const mock = new MockEngine({ latency: false });
  const inMemory = () => new Capture({
    buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    format: 'cu8', sampleRate: RATE, centerHz: CENTER, label: 'tone',
  });

  t.after(() => {
    remote._sock.close();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { mock, remote, id, inMemory };
}

/** Run the identical script of calls against one engine. */
async function script(e, openWith) {
  await e.createSession();
  await e.openCapture(openWith);
  const root = e.root;
  const c = CENTER + TONE;
  const tuner = await e.addNode({
    parent: root.id, op: 'core.tuner',
    selection: { f0: c - 20_000, f1: c + 20_000 }, at: 0.2,
  });
  const det = await e.addNode({ parent: tuner.id, op: 'core.am_envelope', at: 0.2 });
  return { root, tuner, det };
}

/** Wait until a live frame has actually crossed the wire. */
async function settle(e, nodeId, opts, tries = 200) {
  for (let i = 0; i < tries; i++) {
    const f = e.frame(nodeId, opts);
    if (f.kind !== 'pending') return f;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('no frame arrived');
}

test('the same calls build the same graph', async (t) => {
  const f = await fixture(t);
  const m = await script(f.mock, f.inMemory());
  const r = await script(f.remote, f.id);

  assert.equal(f.remote.capture.durationS, f.mock.capture.durationS);
  assert.equal(f.remote.capture.sampleRate, f.mock.capture.sampleRate);
  assert.equal(f.remote.nodes.size, f.mock.nodes.size);

  for (const k of ['tuner', 'det']) {
    assert.equal(r[k].op, m[k].op, k);
    assert.equal(r[k].label, m[k].label, k);
    assert.equal(r[k].letter, m[k].letter, k);
    assert.deepEqual(r[k].out, m[k].out, `${k} output type`);
    assert.deepEqual(Object.keys(r[k].params), Object.keys(m[k].params), `${k} parameters`);
    for (const [key, p] of Object.entries(m[k].params)) {
      assert.deepEqual(r[k].params[key].value, p.value, `${k}.${key} value`);
      assert.equal(r[k].params[key].mode, p.mode, `${k}.${key} mode`);
      // the evidence for an auto value has to survive too, or ADR-0017 is a local rule
      assert.equal(r[k].params[key].auto?.from, p.auto?.from, `${k}.${key} evidence`);
    }
  }
});

test('the same graph produces the same spectrum, sample for sample', async (t) => {
  const f = await fixture(t);
  const m = await script(f.mock, f.inMemory());
  const r = await script(f.remote, f.id);

  for (const at of [0.05, 0.2, 0.5, 0.9]) {
    const want = f.mock.frame(m.tuner.id, { bins: 1024, window: 'Hann', at });
    f.remote.prefetch(r.tuner.id, { bins: 1024, window: 'Hann' }, [at]);
    const got = await settle(f.remote, r.tuner.id, { bins: 1024, window: 'Hann', at });

    assert.equal(got.kind, 'spectrum');
    assert.equal(got.data.length, want.data.length);
    assert.equal(got.sampleRate, want.sampleRate);
    assert.equal(got.centerHz, want.centerHz);
    let worst = 0;
    for (let i = 0; i < want.data.length; i++) {
      worst = Math.max(worst, Math.abs(got.data[i] - want.data[i]));
    }
    // identical code over identical samples: the only difference allowed is float32
    // rounding through the wire, which is none at all
    assert.equal(worst, 0, `spectrum at ${at}s differs by ${worst} dB`);
  }
});

test('and the same detector output', async (t) => {
  const f = await fixture(t);
  const m = await script(f.mock, f.inMemory());
  const r = await script(f.remote, f.id);

  const opts = { spanS: 0.05, trigger: 'free' };
  const want = f.mock.frame(m.det.id, { ...opts, at: 0.3 });
  f.remote.prefetch(r.det.id, opts, [0.3]);
  const got = await settle(f.remote, r.det.id, { ...opts, at: 0.3 });

  assert.equal(got.kind, 'timeseries');
  assert.equal(got.data.length, want.data.length);
  assert.equal(got.sampleRate, want.sampleRate);
  let worst = 0;
  for (let i = 0; i < want.data.length; i++) worst = Math.max(worst, Math.abs(got.data[i] - want.data[i]));
  assert.equal(worst, 0);
});

test('a parameter change lands on both and changes the same thing', async (t) => {
  const f = await fixture(t);
  const m = await script(f.mock, f.inMemory());
  const r = await script(f.remote, f.id);

  await f.mock.setParam(m.tuner.id, 'centerHz', CENTER + 5_000);
  await f.remote.setParam(r.tuner.id, 'centerHz', CENTER + 5_000);

  assert.equal(f.remote.node(r.tuner.id).params.centerHz.value, CENTER + 5_000);
  assert.equal(f.remote.node(r.tuner.id).params.centerHz.mode, 'manual');
  assert.equal(f.remote.node(r.tuner.id).out.centerHz, f.mock.node(m.tuner.id).out.centerHz);

  const want = f.mock.frame(m.tuner.id, { bins: 512, window: 'Hann', at: 0.4 });
  f.remote.prefetch(r.tuner.id, { bins: 512, window: 'Hann' }, [0.4]);
  const got = await settle(f.remote, r.tuner.id, { bins: 512, window: 'Hann', at: 0.4 });
  let worst = 0;
  for (let i = 0; i < want.data.length; i++) worst = Math.max(worst, Math.abs(got.data[i] - want.data[i]));
  assert.equal(worst, 0);
});

test('removing a node removes what hung off it, on both', async (t) => {
  const f = await fixture(t);
  const m = await script(f.mock, f.inMemory());
  const r = await script(f.remote, f.id);

  await f.mock.removeNode(m.tuner.id);
  await f.remote.removeNode(r.tuner.id);
  assert.equal(f.remote.nodes.size, f.mock.nodes.size);
  assert.equal(f.remote.node(r.det.id), undefined);
  assert.equal(f.remote.children(f.remote.root.id).length, 0);
});

test('a span reads back whole, in chunks, with progress', async (t) => {
  const f = await fixture(t);
  const m = await script(f.mock, f.inMemory());
  const r = await script(f.remote, f.id);

  const seen = [];
  const want = await f.mock.readSpan(m.det.id, 0.1, 0.6);
  const got = await f.remote.readSpan(r.det.id, 0.1, 0.6, (p) => seen.push(p));

  assert.equal(got.kind, want.kind);
  assert.equal(got.count, want.count);
  assert.equal(got.sampleRate, want.sampleRate);
  assert.equal(got.data.length, want.data.length);
  let worst = 0;
  for (let i = 0; i < want.data.length; i++) worst = Math.max(worst, Math.abs(got.data[i] - want.data[i]));
  assert.equal(worst, 0, 'a span that crossed the wire in pieces is the span that went in');
  assert.ok(seen.length > 0 && seen[seen.length - 1] <= 1, 'progress was reported while it ran');
});

test('the library lists what is on the box, and refuses what is not', async (t) => {
  const f = await fixture(t);
  await f.remote.createSession();
  const caps = await f.remote.listCaptures();
  assert.equal(caps.length, 1);
  assert.equal(caps[0].id, 'tone.sigmf-data');
  assert.equal(caps[0].sampleRate, RATE);
  assert.equal(caps[0].centerHz, CENTER);
  assert.ok(caps[0].sigmf, 'it read the SigMF sidecar rather than guessing');

  await assert.rejects(() => f.remote.openCapture('../../etc/passwd'),
    /not in the library|no such file|ENOENT/i,
    'a path out of the library is not a capture');
});

test('dropping a file on a remote engine says where captures live', async (t) => {
  const f = await fixture(t);
  await f.remote.createSession();
  await assert.rejects(() => f.remote.openCapture({ name: 'x.cu8' }), /from the server/);
});
