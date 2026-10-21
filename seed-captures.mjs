#!/usr/bin/env node
// Put the shipped fixtures where the server will find them.
//
// The repository ships a handful of synthetic captures for the conformance harness, but
// the library scans one flat directory and the fixtures live one directory deeper — so a
// first run finds nothing to open and the tool looks emptier than it is. This copies
// them across under their own names. It is a convenience, not a step: the captures
// directory is yours, and anything you drop in it shows up the same way.
//
//   node seed-captures.mjs [destination] [--index]
//
// `--index` also writes `index.json` beside them, which is how the hosted copy — a
// static site that cannot list a directory — knows what examples it has.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const from = path.join(HERE, 'fixtures');
const args = process.argv.slice(2);
const index = args.includes('--index');
const to = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(HERE, 'captures'));
const BYTES = { cu8: 2, ci8: 2, cs8: 2, ci16_le: 4, cs16_le: 4, cf32_le: 8 };
const examples = [];

fs.mkdirSync(to, { recursive: true });
let n = 0;
for (const name of fs.readdirSync(from)) {
  const dir = path.join(from, name);
  if (!fs.statSync(dir).isDirectory()) continue;
  const data = path.join(dir, 'capture.sigmf-data');
  if (!fs.existsSync(data)) continue;
  for (const ext of ['sigmf-data', 'sigmf-meta']) {
    const src = path.join(dir, `capture.${ext}`);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(to, `${name}.${ext}`));
  }
  n++;
  console.log(`  ${name}`);
  if (index) {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'capture.sigmf-meta'), 'utf8'));
    const fx = JSON.parse(fs.readFileSync(path.join(dir, 'fixture.json'), 'utf8'));
    const g = meta.global, rate = g['core:sample_rate'];
    const bps = BYTES[g['core:datatype']];
    if (!bps) throw new Error(`${name}: no size known for ${g['core:datatype']}`);
    examples.push({
      // `label` is what the picker shows; `name` is the sentence the tests are named by.
      id: name, name: fx.label || fx.name, sampleRate: rate,
      durationS: fs.statSync(data).size / bps / rate,
      bytes: fs.statSync(data).size,
      needs: fx.needs && fx.needs.startsWith('ext.') ? fx.needs : null,
      files: [`${name}.sigmf-data`, `${name}.sigmf-meta`],
    });
  }
}
if (index) fs.writeFileSync(path.join(to, 'index.json'), JSON.stringify({ examples }, null, 2) + '\n');
console.log(`${n} capture${n === 1 ? '' : 's'} in ${to}`);
console.log('Each one is synthetic and CC0; fixtures/<name>/README.md says what it is.');
