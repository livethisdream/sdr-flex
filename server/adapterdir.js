// Decoders the operator added.
//
// ADR-0026 designed this and then deferred it, on the grounds that a pack format written
// before three real adapters exist is a pack format written from imagination. Six exist
// now, and between them they forced every mechanism this needs: a program under several
// names, a module inside an interpreter, a container in front of the samples, a config
// file written per run, a sample rate that follows a parameter, a sweep for `Identify`,
// and four different ways of reading a program's output. None of that had to be guessed.
//
// ## The trust line, stated plainly
//
// An adapter is a command line. Anything that can write to this directory can run
// programs on this box — so the directory's permissions *are* the control, and this
// refuses to load from one the world can write to.
//
// That is why this is a directory on the box and not a drop target in the browser. The
// rule that dropped code runs in the tab and never on the server (ADR-0029) has not
// moved an inch: a plugin is something anybody can hand you, and an adapter is something
// you put on your own machine on purpose. The capture directory and the plugin directory
// already sit at exactly this trust level.
//
// ## The shape
//
//   <SDRFLEX_ADAPTERS>/
//     my-decoder/
//       adapter.json          the manifest — or adapter.mjs, when it needs functions
//       flowgraph.py          optional, named by the manifest
//       fixture.json          optional, and the golden capture beside it (ADR-0025)
//       capture.sigmf-data
//       capture.sigmf-meta
//
// A manifest that does not load is reported with the reason and skipped. One bad decoder
// is not a reason for the others to be missing.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Stream types the graph knows about (ADR-0006). */
const KINDS = ['iq', 'real', 'bits', 'bytes', 'events'];
const FORMATS = ['cu8', 'cs8', 'cs16', 'cf32', 's16'];

export class AdapterDir {
  constructor(root) { this.root = root; }

  /**
   * Every adapter in the directory, as specs the table can hold.
   *
   * Async because a manifest may be an ES module, and importing one is. Returns the
   * problems as well as the adapters — a decoder that failed to load should say so at
   * startup rather than simply not appear.
   */
  async load() {
    const adapters = [], problems = [];
    let names;
    try { names = fs.readdirSync(this.root); } catch { return { adapters, problems }; }

    if (worldWritable(this.root)) {
      problems.push({ pack: path.basename(this.root),
                      why: 'the directory is world-writable, and an adapter is a command line — ' +
                           'chmod o-w it and they will load' });
      return { adapters, problems };
    }

    for (const name of names.sort()) {
      const dir = path.join(this.root, name);
      try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
      try {
        const spec = await this.read(dir, name);
        adapters.push(spec);
      } catch (e) {
        problems.push({ pack: name, why: e.message });
      }
    }
    return { adapters, problems };
  }

  async read(dir, name) {
    const mjs = path.join(dir, 'adapter.mjs');
    const json = path.join(dir, 'adapter.json');
    let raw;
    if (fs.existsSync(mjs)) {
      // A manifest that needs to *compute* — an args builder with a loop in it, a parser
      // for a program with an unusual output — is an ES module exporting the same shape.
      // No new trust: the JSON form already names a command to run.
      const mod = await import(pathToFileURL(mjs).href + `?t=${Date.now()}`);
      raw = mod.default;
      if (!raw) throw new Error('adapter.mjs has no default export');
    } else if (fs.existsSync(json)) {
      raw = JSON.parse(fs.readFileSync(json, 'utf8'));
    } else {
      throw new Error('no adapter.json or adapter.mjs in it');
    }
    return compile(raw, dir, name);
  }
}

/** Turn a manifest into the spec shape `adapters.js` runs, and refuse a bad one loudly. */
export function compile(raw, dir, packName) {
  const id = String(raw.id || `ext.${packName}`);
  const need = (k) => {
    if (raw[k] == null || raw[k] === '') throw new Error(`${id}: no "${k}"`);
    return raw[k];
  };
  const name = String(need('name'));
  const kindIn = String(need('in')), kindOut = String(need('out'));
  if (!KINDS.includes(kindIn)) throw new Error(`${id}: "in" is ${kindIn}, not one of ${KINDS.join(', ')}`);
  if (!KINDS.includes(kindOut)) throw new Error(`${id}: "out" is ${kindOut}, not one of ${KINDS.join(', ')}`);
  if (!id.startsWith('ext.')) throw new Error(`${id}: an adapter id starts with "ext."`);

  const command = [].concat(need('command')).map(String);
  const params = (raw.params || []).map((p, i) => {
    if (!p.id) throw new Error(`${id}: parameter ${i} has no id`);
    return { id: String(p.id), type: p.type || 'text', default: p.default ?? '',
             label: p.label || p.id, placeholder: p.placeholder, hint: p.hint, values: p.values };
  });

  const spec = {
    name, group: raw.group || 'Decode', in: kindIn, out: kindOut,
    command, blurb: raw.blurb, params,
    wants: compileWants(raw.wants, id),
    args: typeof raw.args === 'function' ? raw.args : compileArgs(raw.args, id),
    parse: typeof raw.parse === 'function' ? raw.parse : (raw.parse || 'lines'),
    title: raw.title || ['text'],
    ...(raw.module ? { module: String(raw.module) } : {}),
    ...(raw.sweep ? { sweep: raw.sweep } : {}),
    ...(typeof raw.files === 'function' ? { files: raw.files } : {}),
    ...(typeof raw.explain === 'object' ? { explain: raw.explain } : {}),
    // Where it came from, so the UI and the log can say "yours" rather than implying it
    // shipped with the tool.
    local: { pack: packName, dir },
  };

  if (raw.flowgraph) {
    const fg = path.join(dir, String(raw.flowgraph));
    if (!fs.existsSync(fg)) throw new Error(`${id}: flowgraph ${raw.flowgraph} is not in the pack`);
    // Absolute, because the shipped ones resolve against server/flowgraphs and these
    // resolve against wherever the operator put them.
    spec.flowgraphPath = fg;
  }
  if (!['jsonl', 'lines'].includes(spec.parse) && typeof spec.parse !== 'function') {
    throw new Error(`${id}: "parse" is ${spec.parse}, not jsonl or lines`);
  }
  return { id, spec };
}

/**
 * `wants` is usually two constants. It is a function when the rate follows a parameter,
 * which in a JSON manifest cannot be a function — so the one case that actually occurs
 * is spelled out declaratively instead: LoRa's rate is twice its bandwidth.
 */
function compileWants(w, id) {
  if (typeof w === 'function') return w;
  if (!w || !w.format) throw new Error(`${id}: no "wants.format"`);
  if (!FORMATS.includes(w.format)) {
    throw new Error(`${id}: wants.format is ${w.format}, not one of ${FORMATS.join(', ')}`);
  }
  // `container` travels with format and rate — minimodem reads through libsndfile and
  // will not take headerless samples on a pipe, and a manifest that could name the
  // format but not the wrapper could describe minimodem and not drive it.
  const box = w.container ? { container: String(w.container) } : {};
  if (w.rate) return { format: w.format, rate: Number(w.rate), ...box };
  const r = w.ratePerParam;
  if (!r || !r.param) throw new Error(`${id}: wants needs a "rate", or a "ratePerParam"`);
  const times = Number(r.times ?? 1), fallback = Number(r.default ?? 0);
  return ({ params }) => ({ format: w.format, rate: (Number(params[r.param]) || fallback) * times, ...box });
}

/**
 * The command line, from a list of templates.
 *
 * `{rate}`, `{centerHz}`, `{dir}` and `{param:id}` are substituted. An entry may instead
 * be `{ "if": "flex", "then": [...] }`, which is included only when that parameter has a
 * value — because "restrict to one protocol" and "restrict to no protocol" are different
 * command lines, and a flag with an empty argument after it is neither.
 */
export function compileArgs(spec, id) {
  const list = spec || [];
  if (!Array.isArray(list)) throw new Error(`${id}: "args" is not a list`);
  // Checked now rather than when it runs. The point of validating a manifest at all is
  // that a decoder which cannot work says so at startup, and an entry that blows up the
  // first time somebody clicks the node has defeated that entirely.
  for (const entry of list) {
    if (typeof entry === 'string') continue;
    if (entry && typeof entry === 'object' && entry.if) continue;
    throw new Error(`${id}: an args entry is neither a string nor an "if": ${JSON.stringify(entry)}`);
  }
  return ({ rate, centerHz, params, dir }) => {
    const fill = (s) => String(s).replace(/\{(\w+)(?::(\w+))?\}/g, (all, key, p) => {
      if (key === 'rate') return String(Math.round(rate));
      if (key === 'centerHz') return String(Math.round(centerHz || 0));
      if (key === 'dir') return String(dir || '');
      if (key === 'param') return String(params[p] ?? '');
      return all;
    });
    const out = [];
    for (const entry of list) {
      if (typeof entry === 'string') { out.push(fill(entry)); continue; }
      const v = params[entry.if];
      if (v !== undefined && v !== null && String(v) !== '') out.push(...[].concat(entry.then || []).map(fill));
    }
    return out;
  };
}

/** A directory anyone can write to is a directory anyone can put a command line in. */
function worldWritable(dir) {
  try {
    const st = fs.statSync(dir);
    // The sticky bit makes /tmp-style shared directories safe for files you own, but an
    // adapter is read by name rather than by owner, so it does not help here.
    return (st.mode & 0o002) !== 0;
  } catch { return false; }
}
