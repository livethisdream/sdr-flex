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
  /**
   * `roots` is a directory, or a list of `{ root, local }` read in order. `local` marks
   * the files as yours rather than shipped, which the menu badges; a later directory's
   * file is sent later, so on a shared id yours is the one the tab keeps.
   */
  constructor(roots) {
    this.roots = typeof roots === 'string' ? [{ root: roots, local: null }] : roots;
  }

  /** Every `.js` in the directories, with its source. Unreadable files are skipped. */
  list() {
    const out = [];
    for (const { root, local } of this.roots) {
      let names;
      try { names = fs.readdirSync(root); } catch { continue; }
      for (const name of names.sort()) {
        if (!/\.js$/i.test(name)) continue;
        const full = path.join(root, name);
        try {
          const st = fs.statSync(full);
          if (!st.isFile() || st.size > MAX_BYTES) continue;
          out.push({ filename: name, source: fs.readFileSync(full, 'utf8'), bytes: st.size,
                     ...(local ? { local } : {}) });
        } catch { /* vanished or unreadable between the listing and the read */ }
      }
    }
    return out;
  }
}
