// The golden-capture harness (ADR-0025).
//
// Every decoder ships with a capture, the records it must produce, and — the part most
// projects skip — an assertion that the parameters were *derived* rather than handed
// over. A decoder that only works once you have told it the symbol rate and the
// polynomial works for the person who already knew the answer, which is nobody.
//
// The point of the harness is that it is the harness. The second decoder costs a
// capture and a manifest, because the thing that replays and diffs already exists; if
// adding the fiftieth adapter means writing the fiftieth test, the coverage strategy in
// ADR-0013 does not work.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockEngine } from '../src/engine.js';
import { Capture } from '../src/capture.js';
import * as adapters from '../../server/adapters.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');

const SIGMF = { cf32_le: 'cf32', ci16_le: 'cs16', cu8: 'cu8', ci8: 'cs8' };

function load(dir) {
  const spec = JSON.parse(fs.readFileSync(path.join(dir, 'fixture.json'), 'utf8'));
  const stem = spec.capture.replace(/\.sigmf-data$/, '');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, `${stem}.sigmf-meta`), 'utf8'));
  const buf = fs.readFileSync(path.join(dir, spec.capture));
  const g = meta.global, c = (meta.captures || [])[0] || {};
  const capture = new Capture({
    buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    format: SIGMF[g['core:datatype']] || 'cu8',
    sampleRate: g['core:sample_rate'],
    centerHz: c['core:frequency'] || 0,
    label: path.basename(dir),
  });
  return { spec, capture, meta };
}

/** An engine with the adapter table wired in, the way the server wires it. */
function engineWithAdapters() {
  const e = new MockEngine({ latency: false });
  e.adapters = adapters.list();
  e.adapter = (id) => (adapters.ADAPTERS[id] ? { id, ...adapters.ADAPTERS[id] } : null);
  e.runAdapter = async (n, at) => {
    const p = e.node(n.parent);
    const got = await e.readSpan(p.id, 0, e.duration());
    if (!got) return { records: [], error: 'nothing upstream' };
    const params = {};
    for (const [k, v] of Object.entries(n.params)) params[k] = v.value;
    return adapters.run(n.adapter, {
      data: got.data, kind: got.kind, sampleRate: got.sampleRate,
      centerHz: p.out.centerHz, params,
    });
  };
  return e;
}

/**
 * Is what this fixture needs on the box?
 *
 * `needs` names an adapter rather than a binary, because a binary is not one name: the
 * same dump1090 is `dump1090-mutability` on Debian and `dump1090-fa` from FlightAware,
 * and a fixture that named the upstream binary skipped itself on every machine that
 * could actually have run it. The adapter knows its own candidates.
 */
function have(needs) {
  if (adapters.ADAPTERS[needs]) return adapters.available(needs);
  // An older fixture may still name the program. Match it against every candidate name
  // any adapter declares, rather than against the one that happened to be found.
  return Object.keys(adapters.ADAPTERS).some((id) =>
    [].concat(adapters.ADAPTERS[id].command).includes(needs) && adapters.available(id));
}

/**
 * A grid, in the shape the expectations are written against.
 *
 * The detailed assertions about a grid live in its own test — what belongs here is that
 * it was produced at all, without an error, from a capture that is still the right size
 * and still carries its license.
 */
function gridAsResult(g) {
  if (!g) return null;
  return {
    records: g.rows ? [{ text: `${g.rows} × ${g.cols}`, rows: g.rows, cols: g.cols }] : [],
    error: g.error,
    rows: g.rows, cols: g.cols,
  };
}

const dirs = fs.existsSync(FIXTURES)
  ? fs.readdirSync(FIXTURES).filter((d) => fs.existsSync(path.join(FIXTURES, d, 'fixture.json')))
  : [];

test('there are fixtures to run', () => {
  assert.ok(dirs.length > 0, 'no fixtures found — the harness is not protecting anything');
});

for (const name of dirs) {
  const dir = path.join(FIXTURES, name);
  const { spec } = load(dir);

  test(`${name}: ${spec.name}`, async (t) => {
    // A fixture for a program this machine does not have is skipped rather than failed:
    // the adapter is still correct, it just cannot be exercised here, and a red suite
    // on a laptop without rtl_433 teaches people to ignore the suite.
    if (spec.needs && !have(spec.needs)) {
      t.skip(`${spec.needs} is not installed on this machine`);
      return;
    }

    const { capture } = load(dir);
    const e = engineWithAdapters();
    await e.createSession();
    await e.openCapture(capture);

    const made = [];
    let parent = e.root.id;
    for (const step of spec.chain) {
      const n = await e.addNode({
        parent, op: step.op, at: 0.05,
        selection: step.selection || { f0: capture.centerHz - 50_000, f1: capture.centerHz + 50_000 },
      });
      assert.ok(n, `${step.op} did not build`);
      for (const [k, v] of Object.entries(step.params || {})) await e.setParam(n.id, k, v);
      made.push(n);
      parent = n.id;
    }

    // A chain ends in whatever it ends in. Most produce records; an analyzer that folds
    // the signal into two dimensions produces a grid, and asking it for records gets
    // nothing — which used to read as "the fixture is broken".
    const last = made[made.length - 1];
    const out = last.out.kind === 'grid'
      ? gridAsResult(await e.sliceGrid(last.id, 0.05))
      : await e.runRecords(last.id, 0.05);
    assert.ok(out, 'the last node produced nothing at all');

    const x = spec.expect || {};
    if (x.noError) assert.equal(out.error, undefined, `reported an error: ${out.error}`);
    if (x.records != null) {
      assert.equal(out.records.length, x.records,
        `expected ${x.records} records, got ${out.records.length}: ` +
        JSON.stringify(out.records.slice(0, 3)));
    }
    if (x.texts) {
      assert.deepEqual(out.records.map((r) => r.text), x.texts);
    }
    for (const [field, wanted] of Object.entries(x.fieldContains || {})) {
      const all = out.records.map((r) => String(r[field] ?? '')).join(' ');
      for (const w of wanted) {
        assert.ok(all.includes(w), `no record's ${field} contained ${w}: ${all.slice(0, 200)}`);
      }
    }
    for (const [field, pattern] of Object.entries(x.everyRecord || {})) {
      for (const r of out.records) {
        assert.match(String(r[field] ?? ''), new RegExp(pattern), `record ${r.text}`);
      }
    }

    // The assertion that carries the design: given only the capture, `auto` landed on
    // parameters that produce the records above, and said what told it so.
    for (const d of spec.derive || []) {
      const n = e.node(made[d.node].id);
      const p = n.params[d.param];
      assert.ok(p, `${d.param} is not a parameter of ${n.op}`);
      if (d.mode) assert.equal(p.mode, d.mode, `${d.param} should still be ${d.mode}`);
      if (d.about != null) {
        assert.ok(Math.abs(p.value - d.about) <= d.about * (d.within ?? 0.05),
          `${d.param} derived as ${p.value}, expected about ${d.about}`);
      }
      if (d.evidence) {
        assert.ok(p.auto && String(p.auto.from).includes(d.evidence),
          `${d.param} did not say what told it so: ${p.auto && p.auto.from}`);
      }
      if (d.confident != null) {
        assert.equal(!!(p.auto && p.auto.confident), d.confident,
          `${d.param} confidence: ${p.auto && p.auto.from}`);
      }
    }
  });

  test(`${name}: ships its license and provenance`, () => {
    // ADR-0025 asks for both, and the reason is not bureaucracy: a capture is a signal
    // somebody transmitted, and one whose origin nobody recorded cannot be published,
    // corrected, or trusted later.
    const stem = spec.capture.replace(/\.sigmf-data$/, '');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `${stem}.sigmf-meta`), 'utf8'));
    assert.ok(meta.global['core:license'], 'no license in the SigMF metadata');
    assert.ok(meta.global['core:description'], 'no note saying what the signal is');
    assert.ok(fs.existsSync(path.join(dir, 'README.md')), 'no README saying where it came from');
    assert.ok(spec.why && spec.why.length > 40, 'the fixture does not say what it protects');
  });

  test(`${name}: stays small enough to live in the repository`, () => {
    const bytes = fs.statSync(path.join(dir, spec.capture)).size;
    assert.ok(bytes <= 400 * 1024,
      `${(bytes / 1024).toFixed(0)} kB — ADR-0025 caps a committed capture at a few hundred; ` +
      'anything larger is a link and a checksum');
  });
}

test('a decoder that recognizes nothing says what it saw', async (t) => {
  // "Nothing decoded" is true and useless, and it is what the shipped OOK fixture
  // produces if you just pick rtl_433 and change nothing — because the fixture is a
  // made-up protocol rather than a real device, which is deliberate for the adapter
  // test and a dead end for a person. rtl_433 can measure what it saw and name the
  // decoder that would read it, which is the same answer this tool gives everywhere.
  if (!have('ext.rtl433')) {
    t.skip('rtl_433 is not installed on this machine');
    return;
  }
  const dir = path.join(FIXTURES, 'rtl433-ook-pwm');
  const { capture } = load(dir);
  const e = engineWithAdapters();
  await e.createSession();
  await e.openCapture(capture);
  const n = await e.addNode({ parent: e.root.id, op: 'ext.rtl433', at: 0.05 });

  const r = await e.runRecords(n.id, 0.05);
  assert.equal(r.records.length, 0, 'with no flex spec it should recognize nothing');
  assert.ok(r.explained, 'and it should still have something to say');
  assert.match(r.explained.measured, /pulses at/);
  // the modulation is reported as the guess it is, separately from the measurements
  assert.ok(r.explained.guess, 'it should say what it guessed, not fold it into the facts');
  assert.ok(r.explained.suggestion && r.explained.suggestion.includes('m=OOK'),
    `no usable suggestion: ${JSON.stringify(r.explained)}`);

  // and the suggestion is one the adapter will actually accept
  await e.setParam(n.id, 'flex', r.explained.suggestion);
  const again = await e.runRecords(n.id, 0.05);
  assert.ok(again.records.length > 0, 'taking its own advice should decode something');
});
