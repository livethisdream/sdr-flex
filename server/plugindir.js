// The plugins the box keeps.
//
// `web/plugins/bbc.js` has been in this repository since the plugin framework landed,
// and nothing has ever loaded it — a decoder that ships with the tool but is not in the
// tool. This is the directory scan that fixes that, and it is deliberately the same
// shape as the capture library: no registry, no install step, no state that can
// disagree with the disk. Drop a file in, it is there.
//
// These files are read and sent to every tab that connects, which is a real statement
// about trust: they are the operator's own, exactly like the captures. They are still
// *executed* in the browser and never on the server (ADR-0029) — storing is not
// running, and the reason plugins do not run server-side has not changed.

import fs from 'node:fs';
import path from 'node:path';

/** A plugin is one ES module, and nothing larger than this is one. */
const MAX_BYTES = 1 << 20;

export class PluginDir {
  constructor(root) { this.root = root; }

  /** Every `.js` in the directory, with its source. Unreadable files are skipped. */
  list() {
    let names;
    try { names = fs.readdirSync(this.root); } catch { return []; }
    const out = [];
    for (const name of names.sort()) {
      if (!/\.js$/i.test(name)) continue;
      const full = path.join(this.root, name);
      try {
        const st = fs.statSync(full);
        if (!st.isFile() || st.size > MAX_BYTES) continue;
        out.push({ filename: name, source: fs.readFileSync(full, 'utf8'), bytes: st.size });
      } catch { /* vanished or unreadable between the listing and the read */ }
    }
    return out;
  }
}
