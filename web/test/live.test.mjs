// A radio is a medium (ADR-0005), and this is the proof: the same engine, the same
// calls, the same frames — against a source that is still being written and whose past
// expires. Uses the synthetic driver, so it needs no hardware and no network.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RemoteEngine } from '../src/remote.js';
import { createServer } from '../../server/main.js';
import { available } from '../../server/radio.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdrflex-live-'));
  const { server } = createServer({ webDir: dir, captureDir: null, quiet: true, ringDir: dir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const e = new RemoteEngine(`ws://127.0.0.1:${server.address().port}/ws`);
  await e.connect();
  await e.createSession();
  t.after(async () => {
    try { await e.stopRadio(); } catch { /* already gone */ }
    e._sock.close();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { e, dir };
}

/** Ask for a frame until one arrives. */
async function settle(e, nodeId, opts, tries = 300) {
  for (let i = 0; i < tries; i++) {
    const f = e.frame(nodeId, opts);
    if (f.kind !== 'pending') return f;
    await wait(10);
  }
  throw new Error('no frame arrived');
}

/**
 * Let time pass the way the running app does — asking for frames throughout.
 *
 * The live window rides along on frame replies, so a client that stops asking stops
 * learning that history is moving. The app calls `frame` sixty times a second in every
 * view, so this is what "waiting" actually looks like from the engine's side; a test
 * that just slept would be testing a state the app is never in.
 */
async function pump(e, nodeId, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { e.frame(nodeId, { bins: 256 }); await wait(16); }
}

test('the drivers this build knows are listed, installed or not', async (t) => {
  const { e } = await fixture(t);
  const d = await e.listRadios();
  const kinds = d.map((x) => x.kind);
  assert.deepEqual(kinds.sort(), ['pluto', 'pluto-libiio', 'rtl', 'soapy', 'synthetic', 'uhd']);
  // The Pluto talks a protocol rather than running a program, so it is offered whether
  // or not libiio is installed — whether a radio answers is a different question.
  const pluto = d.find((x) => x.kind === 'pluto');
  assert.equal(pluto.native, true);
  assert.equal(pluto.available, true, 'a native driver needs nothing installed');
  const synth = d.find((x) => x.kind === 'synthetic');
  assert.ok(synth.available, 'the synthetic source always runs');
  const rtl = d.find((x) => x.kind === 'rtl');
  assert.equal(rtl.command, 'rtl_sdr', 'and a missing one still says what it wants');
});

test('a radio opens as a source and starts recording', async (t) => {
  const { e } = await fixture(t);
  await e.openRadio('synthetic', { sampleRate: 240_000, centerHz: 433_920_000 });

  assert.ok(e.isLive(), 'the session knows it is live');
  assert.equal(e.root.out.sampleRate, 240_000);
  assert.equal(e.root.out.centerHz, 433_920_000);
  assert.match(e.root.label, /Synthetic/);

  await settle(e, e.root.id, { bins: 512, window: 'Hann' });
  await pump(e, e.root.id, 600);
  const f = await settle(e, e.root.id, { bins: 512, window: 'Hann' });
  assert.equal(f.kind, 'spectrum');
  assert.equal(f.data.length, 512);
  assert.ok(Math.max(...f.data) > -60, 'and there is signal in it, not silence');
});

test('history accumulates, and the client is told how far back it goes', async (t) => {
  const { e } = await fixture(t);
  await e.openRadio('synthetic', { sampleRate: 120_000 });

  await settle(e, e.root.id, { bins: 256 });
  const early = e.span();
  await pump(e, e.root.id, 1200);
  const later = e.span();

  assert.ok(later[1] > early[1] + 0.8, `the head moved: ${early[1].toFixed(2)} -> ${later[1].toFixed(2)}`);
  assert.equal(later[0], 0, 'and nothing has expired yet in a 60 s ring');
  assert.ok(e.duration() > 1, 'duration grows with the recording');
});

test('a chain built on a radio produces the same kinds of frames a file does', async (t) => {
  const { e } = await fixture(t);
  await e.openRadio('synthetic', { sampleRate: 480_000 });
  await settle(e, e.root.id, { bins: 256 });
  await pump(e, e.root.id, 900);

  const c = e.root.out.centerHz - 25_000;
  const tuner = await e.addNode({ parent: e.root.id, op: 'core.tuner',
                                  selection: { f0: c - 25_000, f1: c + 25_000 } });
  assert.equal(tuner.letter, 'A');
  assert.ok(tuner.out.sampleRate < 480_000, 'it decimated, as it would on a file');

  const det = await e.addNode({ parent: tuner.id, op: 'core.am_envelope' });
  const f = await settle(e, det.id, { spanS: 0.02, trigger: 'free' });
  assert.equal(f.kind, 'timeseries');
  assert.ok([...f.data].every(Number.isFinite));
});

test('scrubbing back into the ring reads history, not the live edge', async (t) => {
  const { e } = await fixture(t);
  await e.openRadio('synthetic', { sampleRate: 240_000 });
  await settle(e, e.root.id, { bins: 1024, window: 'Hann' });
  await pump(e, e.root.id, 1500);

  const [, head] = e.span();
  assert.ok(head > 1.2, `about a second and a half recorded, got ${head.toFixed(2)}`);

  // Two moments a second apart, both in the past. The synthetic scene is not
  // stationary, so history and the live edge must not produce identical spectra.
  const back = head - 1.0, near = head - 0.1;
  e.prefetch(e.root.id, { bins: 1024, window: 'Hann' }, [back, near]);
  const a = await settle(e, e.root.id, { bins: 1024, window: 'Hann', at: back });
  const b = await settle(e, e.root.id, { bins: 1024, window: 'Hann', at: near });

  assert.equal(a.kind, 'spectrum');
  assert.equal(b.kind, 'spectrum');
  let diff = 0;
  for (let i = 0; i < a.data.length; i++) diff = Math.max(diff, Math.abs(a.data[i] - b.data[i]));
  assert.ok(diff > 1, `a moment a second ago is a different moment (max ${diff.toFixed(1)} dB apart)`);

  // and asking again for the same past moment gives the same answer — it is recorded
  e._pre.clear();
  e.prefetch(e.root.id, { bins: 1024, window: 'Hann' }, [back]);
  const again = await settle(e, e.root.id, { bins: 1024, window: 'Hann', at: back });
  let worst = 0;
  for (let i = 0; i < a.data.length; i++) worst = Math.max(worst, Math.abs(a.data[i] - again.data[i]));
  assert.equal(worst, 0, 'history is a recording: the same moment reads the same twice');
});

test('the past expires, and the clock will not sit on a moment that is gone', async (t) => {
  const { e } = await fixture(t);
  // a ring barely longer than the test, so it wraps while we watch
  await e.call('openRadio', { kind: 'synthetic', tuning: { sampleRate: 240_000 }, ringSeconds: 5 });
  await settle(e, e.root.id, { bins: 256 });
  await pump(e, e.root.id, 1000);

  // pretend we scrubbed to the very beginning, then let real time pass it by
  e.t = 0.01;
  await pump(e, e.root.id, 5400);
  const [first] = e.span();
  assert.ok(first > 0.5, `the ring wrapped and the oldest moment is now ${first.toFixed(2)}s`);

  e.playing = true;
  e._last = performance.now() - 100;
  e.tick();
  assert.ok(e.t >= first, `the playhead was pulled forward to ${e.t.toFixed(2)}s, not left in the void`);
});

test('a radio that cannot start says why, and leaves nothing half-open', async (t) => {
  const { e } = await fixture(t);
  // Two different failures, and which one you get depends on the machine: a box with
  // no rtl-sdr package cannot find the program, and a box with the package but no
  // dongle gets the program's own complaint. Both have to arrive as a readable reason
  // rather than a hang or a half-open session, and asserting only the first made this
  // test pass for the wrong reason until rtl_sdr was actually installed.
  const err = await e.openRadio('rtl', {}).then(() => null, (x) => x);
  assert.ok(err, 'starting a radio with no hardware must not succeed');
  assert.match(err.message,
    available('rtl') ? /device|found|usb|failed|open/i : /rtl_sdr is not installed/,
    `unhelpful reason: ${JSON.stringify(err.message)}`);
  assert.ok(err.message.length > 8, 'and it says something, not just "error"');
  assert.ok(!e.isLive(), 'the session is not left pointing at a radio that never started');

  // whatever happened, the session still works afterwards
  await e.openRadio('synthetic', { sampleRate: 120_000 });
  assert.ok(e.isLive(), 'and a radio that can start still starts');
});

test('stopping the radio takes the recording with it', async (t) => {
  const { e, dir } = await fixture(t);
  await e.openRadio('synthetic', { sampleRate: 120_000 });
  await settle(e, e.root.id, { bins: 256 });
  assert.equal(fs.readdirSync(dir).filter((f) => /\.iq$/.test(f)).length, 1, 'a ring file exists while it runs');

  await e.stopRadio();
  assert.equal(fs.readdirSync(dir).filter((f) => /\.iq$/.test(f)).length, 0,
               'and is gone afterwards — a ring is scratch, not a capture you meant to keep');
});
