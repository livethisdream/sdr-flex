// What captures are on the box.
//
// Drag and drop was the right answer when the engine lived in the tab: the file was
// already on the machine doing the work. With the engine on a server the file is on
// the server, and pushing 360 MB up a socket to hand it back a window at a time would
// be a strange way to use a network. So the client asks what is there and names one.
//
// The listing is a directory scan and nothing else — no database, no import step, no
// state that can disagree with the disk. Drop a file in the directory and it is there.

import fs from 'node:fs';
import path from 'node:path';
import { guessFormat, guessFromName } from '../web/src/capture.js';
import { FileCapture } from './filecapture.js';

const SIGMF_TYPES = {
  cf32_le: 'cf32', ci16_le: 'cs16', ci8: 'cs8', cu8: 'cu8', ci8_le: 'cs8', cu8_le: 'cu8',
};

const SAMPLE_EXT = /\.(sigmf-data|cf32|fc32|cfile|cu8|cs16|cs8|sc16|sc8|iq|raw|bin|dat|complex)$/i;

/**
 * A path is inside the library or it is not readable at all.
 *
 * The client names a capture by id, and an id is a relative path, so this is the one
 * place a request from the network turns into a path on the disk. `..` and absolute
 * paths and symlinks that leave the tree all resolve to somewhere outside `root`, and
 * anything outside `root` is refused — the library is what the operator put in one
 * directory, not everything the server process can open.
 */
export function resolveInside(root, id) {
  const base = fs.realpathSync(root);
  const full = path.resolve(base, id);
  const real = fs.realpathSync(full);
  if (real !== base && !real.startsWith(base + path.sep)) {
    throw new Error('that capture is not in the library');
  }
  return real;
}

export class Library {
  constructor(root) { this.root = root; }

  /** Every capture in the directory, newest first, with what is known without opening it. */
  list() {
    let names;
    try { names = fs.readdirSync(this.root); } catch { return []; }
    const metas = new Set(names.filter((n) => /\.sigmf-meta$/i.test(n)));
    const out = [];

    for (const name of names) {
      if (!SAMPLE_EXT.test(name)) continue;
      const full = path.join(this.root, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile()) continue;

      const stem = name.replace(/\.sigmf-data$/i, '');
      const metaName = metas.has(`${stem}.sigmf-meta`) ? `${stem}.sigmf-meta` : null;
      const known = metaName ? readMeta(path.join(this.root, metaName)) : {};
      const named = guessFromName(name);

      const format = known.format || guessFormat(name) || 'cu8';
      const sampleRate = known.sampleRate || named.sampleRate || 2_048_000;
      const bps = { cf32: 8, cs16: 4, cu8: 2, cs8: 2 }[format] || 2;
      out.push({
        id: name,
        label: name.replace(SAMPLE_EXT, ''),
        bytes: st.size,
        modified: st.mtimeMs,
        format,
        sampleRate,
        centerHz: known.centerHz != null ? known.centerHz : (named.centerHz != null ? named.centerHz : 0),
        durationS: Math.floor(st.size / bps) / sampleRate,
        sigmf: !!metaName,
        // a guess is worth showing as a guess; SigMF is worth showing as fact
        derived: metaName ? 'its SigMF metadata' : 'its filename',
      });
    }
    return out.sort((a, b) => b.modified - a.modified);
  }

  /** Open one by the id `list` gave out. */
  open(id) {
    const full = resolveInside(this.root, id);
    const name = path.basename(full);
    const stem = full.replace(/\.sigmf-data$/i, '');
    const metaPath = `${stem}.sigmf-meta`;
    const known = fs.existsSync(metaPath) ? readMeta(metaPath) : {};
    const named = guessFromName(name);

    return new FileCapture({
      path: full,
      format: known.format || guessFormat(name) || 'cu8',
      sampleRate: known.sampleRate || named.sampleRate || 2_048_000,
      centerHz: known.centerHz != null ? known.centerHz
        : (named.centerHz != null ? named.centerHz : 0),
      label: name.replace(SAMPLE_EXT, ''),
      meta: known.meta || null,
    });
  }
}

function readMeta(p) {
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    const g = parsed.global || {};
    const cap = (parsed.captures || [])[0] || {};
    return {
      meta: parsed,
      format: SIGMF_TYPES[g['core:datatype']] || null,
      sampleRate: g['core:sample_rate'] || null,
      centerHz: cap['core:frequency'] != null ? cap['core:frequency'] : null,
    };
  } catch {
    return {};
  }
}
