// A chain of nodes, written as GNU Radio Companion (ADR-0043, ADR-0044).
//
// Two things come out of one walk down the graph:
//
//   - a recipe: a GRC hier block from a channel's input to a node, with SDR Flex's recipe block
//     on it, so it opens in GRC and comes back into SDR Flex as one menu entry;
//   - a program: the same chain as a GRC flowgraph a desktop can run, reading the capture and
//     ending in the speaker.
//
// Written here, from the graph the server holds, and never from anything the page sends but a
// node id and a name: a .grc can carry Python, and the page has no authentication. Every value
// written is a number or one of the expressions below.
//
// Which GNU Radio blocks an SDR Flex step is, is the table EXPORT: the reverse of STEPS in
// web/src/recipes.js. A step it has no block for ends the chain there, and says so.

const num = (v) => (Number.isFinite(Number(v)) ? String(Number(v)) : null);

/**
 * What a step becomes. `params` are the node's settings the blocks read, which become the
 * recipe's parameters by the same names; `blocks` are GNU Radio blocks in a line; `fuses` is
 * how many steps this one entry stands for.
 */
const EXPORT = {
  'core.fm_discriminator': (n, next) => (next && next.op === 'core.stereo'
    // FM and stereo are one GNU Radio block, and come back as two steps (STEPS).
    ? { fuses: 2, params: [[n, 'deviationHz'], [next, 'deemphasisUs']],
        vars: { audio_decim: 'max(1, int(samp_rate // 48000))' },
        blocks: [{ id: 'analog_wfm_rcv_pll', params: { quad_rate: 'samp_rate', audio_decimation: 'audio_decim',
                                                        deemph_tau: 'deemphasisUs * 1e-6' }, outs: 2 }],
        rate: 'samp_rate / audio_decim', output: 'stereo' }
    // SDR Flex scales the discriminator so full deviation is full scale, times its gain.
    : { fuses: 1, params: [[n, 'deviationHz'], [n, 'gain']], imports: 'import math',
        blocks: [{ id: 'analog_quadrature_demod_cf', params: { gain: 'samp_rate / (2 * math.pi) * gain / deviationHz' } }],
        rate: 'samp_rate', output: 'real' }),
  'core.cw': (n) => ({
    fuses: 1, params: [[n, 'offsetHz'], [n, 'pitchHz'], [n, 'filterHz'], [n, 'gain']],
    // The CW recipe itself, as the hier block it is (recipes/cw.grc).
    blocks: [{ id: 'sdrflex_cw', params: { samp_rate: 'samp_rate', offsetHz: 'offsetHz', pitchHz: 'pitchHz',
                                           filterHz: 'filterHz', gain: 'gain', start_index: '0' } }],
    rate: 'samp_rate', output: 'real', needs: 'sdrflex_cw' }),
  'core.am_envelope': () => ({
    fuses: 1, params: [], blocks: [{ id: 'blocks_complex_to_mag', params: { vlen: '1' } }],
    rate: 'samp_rate', output: 'real' }),
};

/** The nodes from `nodeId` up to the channel it is in, channel first. */
function chainTo(engine, nodeId) {
  const out = [];
  for (let n = engine.node(nodeId); n; n = n.parent != null ? engine.node(n.parent) : null) {
    out.unshift(n);
    if (n.op === 'core.tuner') break;
  }
  if (out[0].op !== 'core.tuner') throw new Error('a recipe starts at a channel: draw a box first');
  return out;
}

/** The steps as GNU Radio, as far as there are blocks for them. */
function plan(engine, nodeId) {
  const nodes = chainTo(engine, nodeId);
  const tuner = nodes[0];
  const params = new Map([['widthHz', { node: tuner, key: 'widthHz' }]]);
  const steps = [];
  const notes = [];
  let listen = false, output = 'iq', rate = 'samp_rate', imports = new Set(), vars = {}, needs = new Set();
  for (let i = 1; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.op === 'core.audio') { listen = true; continue; }
    const ex = EXPORT[n.op] && EXPORT[n.op](n, nodes[i + 1]);
    if (!ex) {
      notes.push(`stops before ${n.label || n.op}: GNU Radio has no block SDR Flex knows it as`);
      break;
    }
    for (const [node, key] of ex.params) {
      if (!node.params[key]) continue;
      if (params.has(key)) { notes.push(`${key} is a setting of two steps; the recipe keeps the first`); continue; }
      params.set(key, { node, key });
    }
    steps.push(...ex.blocks);
    if (ex.imports) imports.add(ex.imports);
    if (ex.needs) needs.add(ex.needs);
    Object.assign(vars, ex.vars || {});
    output = ex.output;
    rate = ex.rate;
    i += ex.fuses - 1;
    if (ex.fuses === 2 && nodes[i + 1] && nodes[i + 1].op === 'core.audio') { listen = true; i++; }
  }
  if (!steps.length) throw new Error('nothing after the channel that GNU Radio has a block for');
  return { nodes, tuner, params, steps, notes, listen, output, rate, imports, vars, needs };
}

// ── YAML, written by hand: the shapes are fixed, and every scalar is quoted ──────────

const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const coord = (x, y) => `    coordinate: [${x}, ${y}]\n    rotation: 0\n    state: enabled`;

function block(name, id, params, x, y) {
  const lines = Object.entries(params).map(([k, v]) => `    ${k}: ${q(v)}`).join('\n');
  return `- name: ${name}\n  id: ${id}\n  parameters:\n${lines || '    {}'}\n  states:\n${coord(x, y)}`;
}

function options(p) {
  return `options:\n  parameters:\n${Object.entries(p).map(([k, v]) => `    ${k}: ${q(v)}`).join('\n')}\n  states:\n${coord(8, 8)}`;
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'recipe';

/** A parameter block for one of the node's settings, at the value it has now. */
function parameter(name, p, x) {
  const v = p.node.params[p.key].value;
  const n = num(v);
  // A number that could not be measured (an estimate over silence) is written as 0: it is
  // derived again where the recipe is used, and GRC refuses a NaN.
  const numeric = n != null || typeof v === 'number';
  return block(name, 'parameter', {
    label: name, type: numeric ? 'eng_float' : 'str', value: n != null ? n : numeric ? '0' : v, hide: 'none', short_id: '',
    comment: isDerived(p) ? 'derived by SDR Flex where the recipe is used' : '',
  }, x, 8);
}

/**
 * Derived where the recipe is used, rather than fixed at what it was here. The channel's width
 * is the exception: a tuner calls its width derived from the box that was drawn, but in a
 * recipe the width is a choice the recipe makes (WBFM's 240 kHz).
 */
const isDerived = (p) => p.node.params[p.key].mode === 'auto' && !(p.node.op === 'core.tuner' && p.key === 'widthHz');

/**
 * A recipe: the chain from `nodeId`'s channel down to it, as a GRC hier block whose input is
 * the channel and whose parameters are the settings the chain was built with. A setting SDR
 * Flex derived is marked so, and derived again wherever the recipe is used.
 */
export function recipeGrc(engine, nodeId, title) {
  const pl = plan(engine, nodeId);
  const id = `sdrflex_${slug(title)}`;
  const derived = [...pl.params.entries()].filter(([, p]) => isDerived(p)).map(([k]) => `${k}=auto`).join(',');
  const blocks = [
    block('recipe', 'sdrflex_recipe', {
      kind: 'chain', node: '', input: 'iq', output: pl.output, derived, history: '',
      listen: pl.listen ? 'yes' : 'no', comment: '',
    }, 8, 120),
    block('samp_rate', 'parameter', { label: 'Sample rate', type: 'eng_float', value: num(pl.tuner.out.sampleRate),
                                      hide: 'none', short_id: '', comment: 'filled from the stream' }, 200, 8),
    ...[...pl.params.entries()].map(([k, p], i) => parameter(k, p, 360 + i * 160)),
    ...[...pl.imports].map((imp, i) => block(`import_${i}`, 'import', { imports: imp }, 8, 200 + i * 40)),
    ...Object.entries(pl.vars).map(([k, v], i) => block(k, 'variable', { value: v }, 200 + i * 160, 120)),
    block('pad_source_0', 'pad_source', { label: 'in', type: 'complex', vlen: '1', num_streams: '1', optional: 'False' }, 8, 320),
  ];
  const conns = [];
  let prev = 'pad_source_0';
  let outs = 1;
  pl.steps.forEach((s, i) => {
    const name = `${s.id}_${i}`;
    blocks.push(block(name, s.id, s.params, 200 + i * 200, 320));
    conns.push([prev, '0', name, '0']);
    prev = name;
    outs = s.outs || 1;
  });
  const labels = outs === 2 ? ['left', 'right'] : ['out'];
  labels.forEach((label, i) => {
    blocks.push(block(`pad_sink_${i}`, 'pad_sink', { label, type: 'float', vlen: '1', num_streams: '1', optional: 'False' },
                      240 + pl.steps.length * 200, 280 + i * 80));
    conns.push([prev, String(i), `pad_sink_${i}`, '0']);
  });
  for (const [i, text] of pl.notes.entries()) blocks.push(block(`note_${i}`, 'note', { note: text }, 8, 440 + i * 40));
  const text = [
    options({ author: 'SDR Flex', category: '[SDR Flex]', id, title, generate_options: 'hb', output_language: 'python',
              hier_block_src_path: '.:',
              description: `Saved from SDR Flex: ${pl.nodes.slice(1).map((n) => n.label || n.op).join(', ')}.` }),
    '', 'blocks:', ...blocks, '', 'connections:', ...conns.map((c) => `- [${c.map(q).join(', ')}]`), '',
    'metadata:', '  file_format: 1', '',
  ].join('\n');
  return { name: slug(title), title, text, notes: pl.notes, needs: [...pl.needs] };
}

/** How a capture's samples are read into GNU Radio as complex floats, scaled as capture.js does. */
const SOURCE = {
  cf32: { item: '8', id: 'complex', chain: [] },
  cs16: { item: '2', id: 'short', chain: [{ id: 'blocks_interleaved_short_to_complex', params: { scale_factor: '32768.0', swap: 'False', vector_input: 'False' } }] },
  cu8: { item: '1', id: 'byte', chain: [
    { id: 'blocks_uchar_to_float', params: {} },
    { id: 'blocks_add_const_vxx', params: { type: 'float', const: '-127.5', vlen: '1' } },
    { id: 'blocks_multiply_const_vxx', params: { type: 'float', const: '1 / 127.5', vlen: '1' } },
    { id: 'blocks_float_to_complex', params: { vlen: '1' }, deinterleave: true },
  ] },
};

/**
 * A program: the capture, the channel, the chain, and the speaker, as a flowgraph GRC can run
 * on a desktop. The capture is named by its file alone; it is expected beside the .grc.
 */
export function programGrc(engine, nodeId, title) {
  const pl = plan(engine, nodeId);
  const cap = engine.capture;
  if (!cap || !SOURCE[cap.format]) throw new Error('only a recording in cf32, cs16 or cu8 can be exported as a program');
  const root = engine.root, t = pl.tuner;
  const src = SOURCE[cap.format];
  const fileName = String(cap.path || cap.label || 'capture').split('/').pop();
  const blocks = [
    block('capture_rate', 'variable', { value: num(root.out.sampleRate) }, 200, 8),
    block('samp_rate', 'variable', { value: num(t.out.sampleRate), comment: 'the channel\'s rate' }, 360, 8),
    block('offset', 'variable', { value: num(t.params.centerHz.value - root.out.centerHz) }, 520, 8),
    block('import_math', 'import', { imports: 'import math' }, 8, 120),
    ...[...pl.params.entries()].map(([k, p], i) => block(k, 'variable', { value: num(p.node.params[p.key].value)
      ?? (typeof p.node.params[p.key].value === 'number' ? '0' : JSON.stringify(String(p.node.params[p.key].value))) }, 680 + i * 160, 8)),
    ...Object.entries(pl.vars).map(([k, v], i) => block(k, 'variable', { value: v }, 200 + i * 160, 120)),
    block('capture', 'blocks_file_source', { file: fileName, type: src.id, repeat: 'True', vlen: '1', offset: '0', length: '0', begin_tag: 'pmt.PMT_NIL' }, 8, 240),
    block('throttle', 'blocks_throttle', { type: src.id === 'complex' ? 'complex' : src.id, samples_per_second: 'capture_rate * ' + (src.id === 'complex' ? '1' : '2'), vlen: '1', ignoretag: 'True' }, 200, 240),
  ];
  const conns = [['capture', '0', 'throttle', '0']];
  let prev = 'throttle';
  src.chain.forEach((s, i) => {
    const name = `${s.id}_${i}`;
    if (s.deinterleave) {
      blocks.push(block('deinterleave', 'blocks_deinterleave', { type: 'float', blocksize: '1', num_streams: '2', vlen: '1' }, 380 + i * 160, 300));
      conns.push([prev, '0', 'deinterleave', '0']);
      blocks.push(block(name, s.id, s.params, 540 + i * 160, 300));
      conns.push(['deinterleave', '0', name, '0'], ['deinterleave', '1', name, '1']);
    } else {
      blocks.push(block(name, s.id, s.params, 380 + i * 160, 240));
      conns.push([prev, '0', name, '0']);
    }
    prev = name;
  });
  const decim = Math.max(1, Math.round(root.out.sampleRate / t.out.sampleRate));
  blocks.push(block('channel', 'freq_xlating_fir_filter_xxx', {
    type: 'ccf', decim: String(decim), center_freq: 'offset', samp_rate: 'capture_rate',
    taps: 'firdes.low_pass(1.0, capture_rate, widthHz / 2, widthHz / 10, window.WIN_HAMMING)',
  }, 200, 400));
  conns.push([prev, '0', 'channel', '0']);
  prev = 'channel';
  let outs = 1;
  pl.steps.forEach((s, i) => {
    const name = `${s.id}_${i}`;
    blocks.push(block(name, s.id, s.params, 400 + i * 200, 400));
    conns.push([prev, '0', name, '0']);
    prev = name;
    outs = s.outs || 1;
  });
  // A sound card takes 48 kHz; the chain's own rate goes through a resampler to get there.
  blocks.push(block('audio_rate', 'variable', { value: '48000' }, 840, 120));
  for (let c = 0; c < outs; c++) {
    const rs = `resample_${c}`;
    blocks.push(block(rs, 'rational_resampler_xxx', { type: 'fff', interp: 'audio_rate', decim: `int(${pl.rate})`, taps: '[]', fbw: '0.4' }, 640 + pl.steps.length * 200, 380 + c * 80));
    conns.push([prev, String(c), rs, '0'], [rs, '0', 'speaker', String(c)]);
  }
  blocks.push(block('speaker', 'audio_sink', { samp_rate: 'audio_rate', device_name: '', ok_to_block: 'True', num_inputs: String(outs) }, 900 + pl.steps.length * 200, 400));
  for (const [i, text] of pl.notes.entries()) blocks.push(block(`note_${i}`, 'note', { note: text }, 8, 560 + i * 40));
  blocks.push(block('note_capture', 'note', { note: `Reads ${fileName}, expected beside this file. Exported from SDR Flex.` }, 8, 520));
  const id = slug(title);
  const text = [
    options({ author: 'SDR Flex', id, title, generate_options: 'no_gui', output_language: 'python', run: 'True',
              run_options: 'prompt', category: 'Custom' }),
    '', 'blocks:', ...blocks, '', 'connections:', ...conns.map((c) => `- [${c.map(q).join(', ')}]`), '',
    'metadata:', '  file_format: 1', '',
  ].join('\n');
  return { name: id, title, text, notes: pl.notes, needs: [...pl.needs] };
}
