// What survives a reload.
//
// A reload used to lose everything: the capture, the chain built on it, every parameter
// turned by hand. Nothing in this tool is a document, so nothing was ever saved, and the
// browser's own reload button sits an inch from the tab bar.
//
// Two things fix that and they fix different halves of it. The window asks before it
// unloads, which stops the accident. This module is what recovers from the ones it does
// not stop — a crash, a closed tab, a container restart, a `⌘R` that went through
// anyway.
//
// **What is saved is a recipe, not a result.** Nodes, their operations, the parameters
// somebody turned, and which capture it was — a few kilobytes of JSON, and the same
// thing [ADR-0032](../../docs/adr/0032-a-flowgraph-is-a-program.md) says a flowgraph
// already is. Not saved: samples, spectra, decoded records, or any derived parameter.
// Those are all reproducible from the recipe and the capture, and a stored copy of a
// derived value is a copy that can disagree with the thing it was derived from.
//
// **A derived parameter is not a decision.** Only `manual` parameters are written down.
// Replaying an `auto` value would pin a measurement taken from a signal to a signal that
// may have changed underneath it — and re-deriving gives the same answer from the same
// capture anyway, with fresh evidence attached (ADR-0017).
//
// **Only what the tool can re-open comes back.** A capture from the box's library has an
// id and can be opened again. A file dragged onto the window cannot — the browser will
// not hand the same bytes back without the person choosing it again — so that is
// remembered by name and the offer says so rather than failing halfway through.

const STORE = 'sdrflex.session.v1';

// A recipe older than this is not what anybody meant by "what I had open". Long enough
// to cover a weekend, short enough that a machine somebody comes back to in a month
// starts clean.
const KEEP_DAYS = 7;

function store() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

/**
 * The recipe for what is on screen, or null when there is nothing worth keeping.
 *
 * "Nothing worth keeping" is a capture with no chain on it. Re-opening the same file and
 * looking at its spectrum is what happens anyway when the page loads, so offering to
 * restore it is an offer to do nothing, worded as a question.
 */
export function recipe(engine, view = {}) {
  const root = engine.root;
  if (!root) return null;
  const nodes = [];
  for (const n of engine.nodes.values()) {
    if (n.id === root.id) continue;
    const params = {};
    for (const [k, p] of Object.entries(n.params || {})) {
      // Manual only — see the note at the top. `ro` is a fact about the node, and an
      // `action` is a button.
      if (p && p.mode === 'manual') params[k] = p.value;
    }
    nodes.push({
      id: n.id, op: n.op, parent: n.parent,
      // `name` is what somebody typed; `label` is what the operation is called and comes
      // back with it. Only the first is a decision.
      ...(n.name ? { name: n.name } : {}),
      ...(Object.keys(params).length ? { params } : {}),
      ...(selectionOf(n) ? { selection: selectionOf(n) } : {}),
    });
  }
  if (!nodes.length) return null;
  return {
    v: 1,
    at: Date.now(),
    source: sourceOf(engine, view.source),
    nodes,
    view: {
      current: view.current || null,
      channel: view.channel || null,
      tabs: view.tabs ? [...view.tabs] : [],
    },
  };
}

/**
 * The selection a node was drawn with, read back out of the parameters it became.
 *
 * `addNode` takes a selection and turns it into a centre and a width immediately — the
 * selection is not kept, because after the first drag the parameters are the truth and a
 * stored selection would be a second copy going stale. Which means replaying one means
 * reconstructing it, and the arithmetic is the inverse of what `core.tuner` does.
 */
function selectionOf(n) {
  if (n.op !== 'core.tuner' || !n.params || !n.params.centerHz) return null;
  const c = n.params.centerHz.value, w = n.params.widthHz.value;
  const sel = { f0: c - w / 2, f1: c + w / 2 };
  // A pinned clip is part of what was drawn, not a parameter turned afterwards.
  if (n.params.t0 && n.params.t1 && n.params.timeMode && n.params.timeMode.value === 'pinned') {
    sel.t0 = n.params.t0.value;
    sel.t1 = n.params.t1.value;
  }
  return sel;
}

/**
 * Which capture this was, in the terms whoever opens it next will need.
 *
 * `opened` comes from whoever did the opening rather than from the engine, and it has
 * to: the client's mirror of a remote graph carries a capture's *facts* — label, rate,
 * duration — and not the library id it was opened by, because nothing that draws a
 * spectrum has ever needed one. The window that knows the id is the one that asked for
 * it, so that is where it is remembered.
 */
function sourceOf(engine, opened) {
  const c = engine.capture;
  if (!c) return { kind: 'scene', label: 'the synthetic scene' };
  // A live radio is not re-openable as itself: the samples it was reading are gone, and
  // starting the radio again would be a different signal wearing the same name.
  if (c.live) return { kind: 'live', label: c.label || 'a radio' };
  if (opened && opened.kind === 'library' && opened.id) {
    return { kind: 'library', id: opened.id, label: c.label || opened.label || 'a capture',
             sampleRate: c.sampleRate, durationS: c.durationS };
  }
  return { kind: 'file', label: c.label || 'a capture',
           sampleRate: c.sampleRate, durationS: c.durationS };
}

/** Write one down. Takes the recipe rather than making it, so the caller can compare. */
export function keep(r) {
  if (!r) return null;
  try { store()?.setItem(STORE, JSON.stringify(r)); } catch { /* quota, or no store */ }
  return r;
}

export function remember(engine, view) {
  return keep(recipe(engine, view));
}

/** What was there last time, if it is still worth offering. */
export function saved() {
  let r;
  try { r = JSON.parse(store()?.getItem(STORE) || 'null'); } catch { return null; }
  if (!r || r.v !== 1 || !Array.isArray(r.nodes) || !r.nodes.length) return null;
  if (!(Date.now() - r.at < KEEP_DAYS * 24 * 3600 * 1000)) { forget(); return null; }
  return r;
}

export function forget() {
  try { store()?.removeItem(STORE); } catch { /* no store */ }
  return null;
}

/**
 * Whether this recipe can be put back, and what to say if not.
 *
 * Asked before the offer is shown rather than discovered halfway through rebuilding it,
 * because a restore that stops three nodes in has left the graph in a state nobody chose.
 */
export function canReplay(r, { captures = [], remote = false } = {}) {
  if (!r) return { ok: false, why: 'nothing was saved' };
  const s = r.source || {};
  if (s.kind === 'live') return { ok: false, why: `${s.label} was a live radio, and those samples are gone` };
  if (s.kind === 'scene') return { ok: true, open: null };
  if (s.kind === 'library') {
    const found = captures.find((c) => c.id === s.id);
    if (!found) return { ok: false, why: `${s.label} is no longer in the box’s capture directory` };
    return { ok: true, open: found };
  }
  // A dropped file. The chain is still good; the samples have to come back by hand.
  return { ok: false, why: `open ${s.label} again and this comes back with it`, awaitingFile: s.label };
}

/**
 * Rebuild the graph from a recipe, onto a capture that is already open.
 *
 * Two passes, and the reason is the second input: a Math node names another node, and on
 * the first pass that node may not have been made yet. So every node is created first
 * and every parameter set afterwards, against a map from the ids that were saved to the
 * ids they came back as.
 *
 * Returns what actually happened, because a partial restore that says it succeeded is
 * worse than a failed one.
 */
export async function replay(engine, r, { at = 0.05 } = {}) {
  const map = new Map();
  const made = [];
  const skipped = [];

  for (const n of r.nodes) {
    // The root is not in the recipe, so a parent that is not in the map is the root.
    const parent = map.get(n.parent) || engine.root.id;
    try {
      const node = await engine.addNode({
        parent, op: n.op, at,
        selection: n.selection || defaultSelection(engine, parent),
      });
      map.set(n.id, node.id);
      made.push({ was: n.id, is: node.id, op: n.op });
    } catch (err) {
      // An operation that no longer exists — a plugin that was not dropped back in, a
      // decoder uninstalled since — is one node lost, not the whole chain. Anything
      // downstream of it will fall back to the root, which is visible and recoverable;
      // silently dropping the rest would not be.
      skipped.push({ op: n.op, why: err.message });
    }
  }

  for (const n of r.nodes) {
    const id = map.get(n.id);
    if (!id) continue;
    for (const [k, v] of Object.entries(n.params || {})) {
      const value = k === 'withNode' ? map.get(v) : v;
      if (k === 'withNode' && !value) continue;      // its other input did not come back
      try { await engine.setParam(id, k, value); } catch { skipped.push({ op: n.op, why: `${k} would not take ${v}` }); }
    }
    if (n.name) { try { await engine.renameNode(id, n.name); } catch { /* a name is not worth failing over */ } }
  }

  return { map, made, skipped };
}

/** A selection for a node whose own was not recorded: the parent's whole width. */
function defaultSelection(engine, parentId) {
  const p = engine.node(parentId);
  const c = p && p.out ? p.out.centerHz || 0 : 0;
  const w = p && p.out ? p.out.sampleRate / 2 : 1;
  return { f0: c - w / 2, f1: c + w / 2 };
}
