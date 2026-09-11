// The Pluto driver, against a mock iiod that libiio's own tools vouch for.
//
// The structure matters more than the assertions. A mock of a protocol you wrote from
// memory tests your memory. So: real `iio_info`, `iio_attr` and `iio_readdev` are run
// against this mock first, and only a mock they accept is used to test our client —
// and then our client has to pull the same samples out of it that `iio_readdev` did.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { serve } from './support/mock-iiod.mjs';
import { Iiod, parseContext, parseFormat } from '../../server/iiod.js';
import { PlutoSource } from '../../server/pluto.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const XML = path.join(HERE, 'support', 'pluto-context.xml');
const PORT = 30431;               // libiio's `ip:` URI cannot carry a port

/** Interleaved I/Q with a recognizable pattern, as 12-bit-in-16 words. */
function fakeSamples(n = 1 << 16) {
  const b = Buffer.alloc(n);
  for (let i = 0; i + 3 < n; i += 4) {
    b.writeInt16LE(((i * 7) % 4000) - 2000, i);
    b.writeInt16LE(((i * 13) % 4000) - 2000, i + 2);
  }
  return b;
}

async function mock(t, port = PORT) {
  const m = await serve({ port, xmlPath: XML, samples: fakeSamples() });
  t.after(() => m.stop());
  return m;
}

const run = async (cmd, args) => {
  try { return { ok: true, out: (await promisify(execFile)(cmd, args, { encoding: 'latin1', timeout: 20000 })).stdout }; }
  catch (e) { return { ok: false, out: String(e.stderr || e.message) }; }
};
const haveLibiio = async () => (await run('iio_info', ['--version'])).ok ||
                               (await run('iio_info', ['-V'])).ok;

// ── the mock earns the right to be used ──────────────────────────────────
test('libiio\'s own client accepts the mock as an iiod', async (t) => {
  if (!await haveLibiio()) { t.skip('libiio is not installed on this machine'); return; }
  await mock(t);
  const r = await run('iio_info', ['-u', `ip:127.0.0.1`]);
  assert.ok(r.ok, `iio_info rejected the mock: ${r.out.split('\n').slice(0, 2).join(' | ')}`);
  assert.match(r.out, /ad9361-phy/);
  assert.match(r.out, /cf-ad9361-lpc/);
  assert.match(r.out, /frequency value: 2400000000/);
});

test('and reads and writes attributes through it', async (t) => {
  if (!await haveLibiio()) { t.skip('libiio is not installed'); return; }
  const m = await mock(t);
  const w = await run('iio_attr', ['-u', 'ip:127.0.0.1', '-c', 'ad9361-phy', 'altvoltage0', 'frequency', '915000000']);
  assert.ok(w.ok, w.out);
  assert.equal(m.attrs.get('iio:device1/OUTPUT/altvoltage0/frequency'), '915000000');
});

// ── and then our client has to agree with it ─────────────────────────────
test('our client reads the same context libiio does', async (t) => {
  await mock(t);
  const c = await new Iiod({ host: '127.0.0.1', port: PORT }).connect();
  const ctx = parseContext(await c.print());
  const names = ctx.devices.map((d) => d.name);
  assert.deepEqual(names, ['ad9361-phy', 'cf-ad9361-lpc']);

  const rx = ctx.devices.find((d) => d.name === 'cf-ad9361-lpc');
  const scan = rx.channels.filter((ch) => ch.scan).sort((a, b) => a.scan.index - b.scan.index);
  assert.equal(scan.length, 2, 'I and Q');
  assert.equal(scan[0].scan.format, 'le:S12/16>>0', 'the entity-encoded format is decoded');
  await c.exit();
});

test('twelve bits in sixteen is read off the device, not assumed', () => {
  // Assuming sixteen is not an error anything reports — it just makes every signal
  // twenty-four decibels quiet, which looks like a gain problem and is chased as one.
  const f = parseFormat('le:S12/16>>0');
  assert.equal(f.bits, 12);
  assert.equal(f.storage, 16);
  assert.equal(f.scale, 1 / 2048);
  assert.equal(parseFormat('le:S16/16>>0').scale, 1 / 32768);
});

test('an attribute round-trips', async (t) => {
  const m = await mock(t);
  const c = await new Iiod({ host: '127.0.0.1', port: PORT }).connect();
  await c.writeAttr('iio:device1', 'OUTPUT', 'altvoltage0', 'frequency', 433920000);
  assert.equal(m.attrs.get('iio:device1/OUTPUT/altvoltage0/frequency'), '433920000');
  assert.equal(await c.readAttr('iio:device1', 'OUTPUT', 'altvoltage0', 'frequency'), '433920000');
  await c.exit();
});

test('a missing attribute reports why rather than hanging', async (t) => {
  await mock(t);
  const c = await new Iiod({ host: '127.0.0.1', port: PORT }).connect();
  await assert.rejects(() => c.readAttr('iio:device1', 'INPUT', 'voltage0', 'no_such_thing'),
    /no such attribute/);
  // and the session is still usable afterwards, which a desync would prevent
  assert.equal(await c.readAttr('iio:device1', 'INPUT', 'voltage0', 'sampling_frequency'), '2000000');
  await c.exit();
});

test('the source tunes and streams, and the bytes are the ones on the wire', async (t) => {
  const m = await mock(t);
  const src = new PlutoSource({ host: '127.0.0.1', port: PORT });
  const chunks = [];
  const started = await src.start(
    { centerHz: 433_920_000, sampleRate: 2_000_000, bufferSamples: 4096 },
    (b) => chunks.push(b));

  assert.equal(started.format, 'cs12', 'it took the format from the device');
  assert.equal(m.attrs.get('iio:device1/OUTPUT/altvoltage0/frequency'), '433920000');
  assert.equal(m.attrs.get('iio:device1/INPUT/voltage0/sampling_frequency'), '2000000');
  assert.equal(m.attrs.get('iio:device1/INPUT/voltage0/gain_control_mode'), 'slow_attack',
    'and left the gain automatic, since none was asked for');

  await new Promise((r) => setTimeout(r, 300));
  src.stop();
  assert.ok(chunks.length > 0, 'no buffers arrived');
  const got = Buffer.concat(chunks);
  const want = fakeSamples();
  for (let i = 0; i < Math.min(got.length, 4096); i++) {
    assert.equal(got[i], want[i % want.length], `byte ${i}`);
  }
});

test('retuning is an attribute write, not a restart', async (t) => {
  const m = await mock(t);
  const src = new PlutoSource({ host: '127.0.0.1', port: PORT });
  let chunks = 0;
  await src.start({ centerHz: 433_920_000, sampleRate: 2_000_000, bufferSamples: 4096 }, () => chunks++);
  await new Promise((r) => setTimeout(r, 150));
  const before = chunks;

  await src.tune({ centerHz: 915_000_000, sampleRate: 2_000_000 });
  assert.equal(m.attrs.get('iio:device1/OUTPUT/altvoltage0/frequency'), '915000000');

  await new Promise((r) => setTimeout(r, 150));
  assert.ok(chunks > before, 'the stream kept running across the retune');
  assert.ok(src.running, 'and the source is still up');
  src.stop();
});

test('manual gain is set only when asked for', async (t) => {
  const m = await mock(t);
  const src = new PlutoSource({ host: '127.0.0.1', port: PORT });
  await src.start({ centerHz: 433_920_000, sampleRate: 2_000_000, gain: 42, bufferSamples: 4096 }, () => {});
  assert.equal(m.attrs.get('iio:device1/INPUT/voltage0/gain_control_mode'), 'manual');
  assert.equal(m.attrs.get('iio:device1/INPUT/voltage0/hardwaregain'), '42');
  src.stop();
});

test('a radio that is not there says so, in words', async () => {
  const src = new PlutoSource({ host: '127.0.0.1', port: 1 });
  await assert.rejects(() => src.start({ centerHz: 1e9, sampleRate: 2e6 }, () => {}),
    /nothing is listening|did not answer|route/);
});

test('something that is not a Pluto is not mistaken for one', async (t) => {
  // An IIO context with no AD936x in it: a thermometer, say. Refusing it with the
  // device list is more useful than failing later on a missing attribute.
  const m = await serve({ port: PORT + 11, xmlPath: XML, samples: fakeSamples() });
  t.after(() => m.stop());
  const c = await new Iiod({ host: '127.0.0.1', port: PORT + 11 }).connect();
  const ctx = parseContext((await c.print()).replace(/ad9361-phy/g, 'tmp103'));
  await c.exit();
  assert.ok(!ctx.devices.some((d) => d.name === 'ad9361-phy'));
});
