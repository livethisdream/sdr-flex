// Recipes that expand into a chain of nodes (ADR-0043).
//
// A recipe is a GNU Radio Companion hier block; the server reads it (server/gr/recipes.py) and
// sends what it found. A chain recipe becomes SDR Flex nodes, one or more per GNU Radio block,
// so every step can be opened and looked at — the "all the knobs" end. Which nodes a GNU Radio
// block is, is this table: one table for every recipe, rather than a file beside each.
//
// A recipe's parameters are named as SDR Flex's settings are (`widthHz`, `deviationHz`), and
// each goes to whichever step has a setting of that name. Nothing maps one to the other.

// Where a chain recipe sits in the menu: after `Tune here` (10), ahead of the demodulators (20s).
export const RECIPE_RANK = 15;

export const STEPS = {
  // Demodulation and the stereo decode in one GNU Radio block; two nodes here, so the
  // composite between them can be looked at — which is where the pilot and RDS are.
  analog_wfm_rcv_pll: ['core.fm_discriminator', 'core.stereo'],
  analog_wfm_rcv: ['core.fm_discriminator'],
  analog_quadrature_demod_cf: ['core.fm_discriminator'],
  analog_am_demod_cf: ['core.am_envelope'],
};

/**
 * The SDR Flex operations a chain recipe becomes, in order: its blocks followed from the input
 * pad along the connections. Throws, naming the block, when one has no step here — a recipe
 * that cannot be built is said to be one rather than built short.
 */
export function chainOf(recipe) {
  const byName = new Map(recipe.blocks.map((b) => [b.name, b]));
  const next = new Map();
  for (const [from, , to] of recipe.connections) if (!next.has(from)) next.set(from, to);
  const start = recipe.connections.find(([from]) => /^pad_source/.test(from));
  const ops = [];
  for (let at = start && start[2], seen = 0; at && byName.has(at) && seen < 64; at = next.get(at), seen++) {
    const b = byName.get(at);
    if (!STEPS[b.id]) throw new Error(`${recipe.title}: SDR Flex has no step for the GNU Radio block ${b.id}`);
    ops.push(...STEPS[b.id]);
  }
  if (!ops.length) throw new Error(`${recipe.title}: no blocks between its input and its output`);
  return ops;
}

/** The recipe's settings that belong to this node: those it has a setting of the same name for. */
export function settingsFor(recipe, node) {
  const out = {};
  for (const [name, p] of Object.entries(recipe.params)) {
    if (p.fromStream || !node.params || !node.params[name]) continue;
    const v = Number(p.value);
    out[name] = typeof node.params[name].value === 'string' ? String(p.value) : (Number.isFinite(v) ? v : p.value);
  }
  return out;
}
