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
    if (spec.needs && !adapters.list().some((a) => a.command === spec.needs && a.available)) {
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

    const out = await e.runRecords(made[made.length - 1].id, 0.05);
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
