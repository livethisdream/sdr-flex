// Which GNU Radio this box has, if any (ADR-0044).
//
// The server never imports GNU Radio; it starts GNU Radio's Python as a worker. So any
// installation will do — a distribution's, radioconda's, one built from source — as long as
// we start the interpreter its bindings were built against. `SDRFLEX_GR_PYTHON` names it.
// Unset, we try `python3` and then radioconda's default place, because radioconda does not
// put its Python on PATH unless asked to.
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

// Everything the worker and the decoder feed import that is not in Python's standard library.
const PROBE = 'import yaml\nfrom gnuradio import gr, analog, blocks, fft, filter\nprint(gr.version())';

function candidates() {
  if (process.env.SDRFLEX_GR_PYTHON) return [process.env.SDRFLEX_GR_PYTHON];
  const home = os.homedir();
  return process.platform === 'win32'
    ? ['python', path.join(home, 'radioconda', 'python.exe')]
    : ['python3', path.join(home, 'radioconda', 'bin', 'python')];
}

/**
 * `{ python, version }` for the first interpreter that has GNU Radio, or `{ tried }`, each
 * entry saying why that one would not do — the last line of its error, which for a missing
 * module is the module's name.
 */
export function findGnuRadio() {
  const tried = [];
  for (const python of candidates()) {
    const r = spawnSync(python, ['-c', PROBE], { encoding: 'utf8', timeout: 20_000 });
    if (r.status === 0) return { python, version: r.stdout.trim() };
    const why = r.error ? (r.error.code === 'ENOENT' ? 'not found' : r.error.message)
      : (r.stderr.trim().split('\n').pop() || `exited ${r.status}`);
    tried.push({ python, why });
  }
  return { tried };
}
