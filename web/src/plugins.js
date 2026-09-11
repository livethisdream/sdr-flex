// Third-party operations, loaded at runtime.
//
// The plugin boundary is a **stream type**, not "wraps a Unix tool". ADR-0013 framed
// a plugin as a subprocess because the motivating examples — rtl_433, multimon-ng —
// eat IQ or audio, and at that end of the chain the hard parts are rate negotiation,
// format conversion and supervising something that might segfault mid-stream.
//
// The late end of the chain has none of those problems. A `bytes → events` plugin is
// handed a few kilobytes and returns records: no rates, no formats, no throughput, no
// process to babysit. Which means it does not need a server, and a browser can host
// it — so the first plugin kind ships before the engine does.
//
// A plugin is one ES module:
//
//   export const manifest = {
//     id: 'ext.bbc', name: 'BBC concurrent code', group: 'Decode',
//     in: 'bytes', out: 'events',
//     params: [{ id: 'msgBytes', type: 'int', default: 64, values: [16,32,64,128] }],
//   };
//   export function decode(bytes, params) { return [{ text: '…' }]; }
//
// `decode` may return more than one record and usually should — see ADR-0028 on why
// a records view has to lead with the count.

/** Everything loaded this session, by id. */
const registry = new Map();

export function loaded() { return [...registry.values()]; }
export function get(id) { return registry.get(id) || null; }

/**
 * Where a plugin comes back from after a reload.
 *
 * There are two answers, and they have different trust stories, which is why there are
 * two rather than one:
 *
 *  - **The box.** A directory on the server, listed on connect and loaded by every tab.
 *    Those files are the operator's own — the same trust as the capture directory — and
 *    they are how a decoder that ships with the tool is actually present in the tool
 *    rather than sitting in the repository being nothing.
 *  - **This browser.** A file dropped on the window is one viewer's choice, so it is
 *    kept in that viewer's browser and nowhere else. It survives a reload without
 *    uploading code to a machine other people can reach.
 *
 * Neither changes where a plugin *runs* — that is still this tab, and deliberately so
 * (ADR-0029). Storing is not executing.
 */
const STORE = 'sdrflex.plugins.v1';

function store() {
  // Node, a private window, and a browser told to block site data all land here.
  try { return globalThis.localStorage || null; } catch { return null; }
}

function readStore() {
  try { return JSON.parse(store()?.getItem(STORE) || '[]'); } catch { return []; }
}

function writeStore(list) {
  try { store()?.setItem(STORE, JSON.stringify(list)); } catch { /* quota, or no store */ }
}

/** Keep this one for next time. Dropped plugins only — the box keeps its own. */
export function remember(entry) {
  const list = readStore().filter((p) => p.id !== entry.id);
  list.push({ id: entry.id, filename: entry.filename, source: entry.source });
  writeStore(list);
  return list.length;
}

export function forget(id) {
  writeStore(readStore().filter((p) => p.id !== id));
  registry.delete(id);
}

export function remembered() { return readStore(); }

/**
 * Load everything this browser was asked to keep.
 *
 * A stored plugin that no longer loads is dropped rather than retried forever: the
 * file was edited into something broken, or a newer build rejects its manifest, and
 * either way failing silently on every startup is worse than losing it once.
 */
export async function restore() {
  const out = { loaded: [], failed: [] };
  for (const p of readStore()) {
    try { out.loaded.push(await loadSource(p.source, p.filename)); }
    catch (err) { out.failed.push({ filename: p.filename, error: err.message }); forget(p.id); }
  }
  return out;
}

function validate(m, where) {
  const bad = (why) => { throw new Error(`${where}: ${why}`); };
  if (!m || typeof m !== 'object') bad('no manifest export');
  if (!m.id || !/^[\w.]+$/.test(m.id)) bad('manifest.id must be a word like "ext.bbc"');
  if (!m.name) bad('manifest.name is required — it is what the menu shows');
  if (!m.in || !m.out) bad('manifest.in and manifest.out name the stream types it sits between');
  for (const p of m.params || []) {
    if (!p.id) bad('every param needs an id');
    if (p.default === undefined) bad(`param ${p.id} has no default; a plugin has to arrive usable`);
  }
  return m;
}

/**
 * Load a plugin from source text.
 *
 * A module URL rather than `eval`, so the plugin gets a real module scope, real
 * `import`, and a stack trace that points at a file when it throws. `data:` rather
 * than `blob:` because blob URLs exist only in a browser — the same loader has to
 * work under Node, both for tests and for the native shell ADR-0011 leaves open.
 *
 * It runs with the host's privileges. There is no sandbox, and one a real decoder
 * could work inside would be a research project; this is a tool you run on your own
 * machine against your own captures, and the control is that you choose the file.
 */
export async function loadSource(source, filename = 'plugin.js') {
  const url = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(source);
  const mod = await import(/* @vite-ignore */ url);
  const m = validate(mod.manifest, filename);
  if (typeof mod.decode !== 'function') throw new Error(`${filename}: no decode() export`);
  const entry = { ...m, decode: mod.decode, filename, source };
  registry.set(m.id, entry);
  return entry;
}

export async function loadFile(file) {
  return loadSource(await file.text(), file.name);
}

/** The plugins a server keeps, loaded into this tab. Failures are reported, not thrown. */
export async function loadAll(sources) {
  const out = { loaded: [], failed: [] };
  for (const s of sources || []) {
    try { out.loaded.push(await loadSource(s.source, s.filename)); }
    catch (err) { out.failed.push({ filename: s.filename, error: err.message }); }
  }
  return out;
}

/** Plugins that can sit after a node of this stream kind. */
export function forKind(kind) {
  return loaded().filter((p) => p.in === '*' || p.in === kind);
}

/**
 * Run one. Records are normalized to `{ text, …fields }` so a view can render any
 * plugin's output without knowing which plugin it was, and a throw becomes a record
 * rather than an exception — a decoder that fails on this packet is a result, not a
 * crash, and the whole point is to try several.
 */
export function run(id, bytes, params) {
  const p = registry.get(id);
  if (!p) return { records: [], error: `plugin ${id} is not loaded` };
  const t0 = performance.now();
  try {
    const out = p.decode(bytes, params || {}) || [];
    const records = (Array.isArray(out) ? out : [out]).map((r) =>
      typeof r === 'string' ? { text: r } : r);
    return { records, ms: performance.now() - t0 };
  } catch (err) {
    return { records: [], error: `${p.name}: ${err.message}`, ms: performance.now() - t0 };
  }
}
