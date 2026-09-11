#!/usr/bin/env node
// Put the shipped fixtures where the server will find them.
//
// The repository ships a handful of synthetic captures for the conformance harness, but
// the library scans one flat directory and the fixtures live one directory deeper — so a
// first run finds nothing to open and the tool looks emptier than it is. This copies
// them across under their own names. It is a convenience, not a step: the captures
// directory is yours, and anything you drop in it shows up the same way.
//
//   node seed-captures.mjs [destination]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const from = path.join(HERE, 'fixtures');
const to = path.resolve(process.argv[2] || path.join(HERE, 'captures'));

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
}
console.log(`${n} capture${n === 1 ? '' : 's'} in ${to}`);
console.log('Each one is synthetic and CC0; fixtures/<name>/README.md says what it is.');
