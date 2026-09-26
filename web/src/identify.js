// Which decoder is this? — the auto mode of choosing one.
//
// ADR-0017 says a parameter arrives derived and shows its evidence, and that the same
// applies one level up, at decoder selection: `Identify` is `⟲ auto` for the question
// "what is this signal". You do not have to know that a 433 MHz burst is OOK PWM before
// the tool will tell you anything about it.
//
// This module is only the *plan* — no samples go anywhere here. Separating it out buys
// two things. It can be reasoned about and tested without a single subprocess, and the
// report can say what it declined to try and why, which matters more than it sounds:
// "nothing decoded this" and "nothing that could decode this was tried" are completely
// different answers and a user cannot tell them apart from an empty list.
//
// It works on the adapter *descriptors* — the `list()` shape the engine already carries
// — rather than on the adapter table itself, because the client has the descriptors and
// must never reach into the server's own module (ADR-0029). That is also why the
// demodulators arrive as an argument: the engine knows about those and the adapter
// table does not.

// How far above the source's rate an adapter may reach before trying it stops making
// sense. A judgment call rather than a derivation: resampling up is not *wrong*, it just
// cannot put back bandwidth that was never captured, and past about this much the
// decoder is being asked to find a signal that could not have fitted in the recording.
// dump1090 wants 2.4 MS/s and Mode S is a megabit — it cannot be hiding in 96 kHz of it.
// A decoder skipped for this can still be added by hand; the report says it was skipped.
export const RATE_HEADROOM = 4;

/**
 * @param {Array} adapters  the `list()` descriptors: { id, name, in, out, wants, available, command }
 * @param {{kind: string, sampleRate: number, demods?: Array<{op: string, label: string}>,
 *          plugins?: Array}} stream
 * @returns {{tried: Array, skipped: Array}}
 */
export function plan(adapters, { kind, sampleRate, demods = [], plugins = [] }) {
  const tried = [], skipped = [];
  for (const a of adapters || []) {
    const row = { id: a.id, name: a.name, blurb: a.blurb, wants: a.wants,
                  params: settings(a), feedRate: feedRate(a) };
    if (!a.available) { skipped.push({ ...row, why: `${a.command} is not installed on this machine` }); continue; }

    if (a.in === kind) {
      if (!wideEnough(a, sampleRate)) { skipped.push({ ...row, why: narrowWhy(a, sampleRate) }); continue; }
      if (fits(a, sampleRate)) tried.push({ ...row, ...chain(a, null) });
      else skipped.push({ ...row, why: rateWhy(a, sampleRate) });
      continue;
    }
    // An audio decoder on a channel of IQ is the ordinary case, not a special one: it is
    // the chain the graph would build by hand, a demodulator and then the decoder. Both
    // demodulators go in the plan, because which one is right is the question being asked.
    if (a.in === 'real' && kind === 'iq' && demods.length) {
      if (!wideEnough(a, sampleRate)) { skipped.push({ ...row, why: narrowWhy(a, sampleRate) }); continue; }
      if (!fits(a, sampleRate)) { skipped.push({ ...row, why: rateWhy(a, sampleRate) }); continue; }
      for (const d of demods) tried.push({ ...row, ...chain(a, d) });
      continue;
    }
    skipped.push({ ...row, why: `takes ${say(a.in)}, and this is ${say(kind)}` });
  }
  return { tried: tried.concat(pluginPlan(plugins, kind, skipped)), skipped };
}

/**
 * The decoders that came from a file rather than from a process.
 *
 * Planned separately and much more simply, because none of the adapter reasoning
 * applies: a plugin is already here, so "not installed" cannot happen; it runs in this
 * tab, so there is no box to be missing; and it reads bytes that have already been
 * sliced, so there is no sample rate for it to be too narrow for. What is left is the
 * one question — does it take this kind of stream — and the answer to "no" is still
 * written down, for the reason at the top of this file.
 *
 * They are planned at all because they are the only decoders a tab with no server has.
 * `Identify` that could only ever offer a subprocess was `Identify` that did not exist
 * on the hosted copy of the tool, and a button that is not drawn cannot say why.
 */
function pluginPlan(plugins, kind, skipped) {
  const tried = [];
  for (const p of plugins || []) {
    const row = { id: p.id, name: p.name, blurb: p.blurb, plugin: true, params: settings(p) };
    if (p.in === kind || p.in === '*') tried.push({ ...row, via: null, viaLabel: '' });
    else skipped.push({ ...row, why: `takes ${say(p.in)}, and this is ${say(kind)}` });
  }
  return tried;
}

/**
 * Run the plugin half of a plan, here in the tab.
 *
 * It does not go through the engine and it must not: a plugin is a file somebody dropped
 * on *this window* (ADR-0029), so on a box the server has never seen it and could not run
 * it if it had. The engine runs the adapters, this runs these, and both land in the same
 * report — which is the whole reason the row shape is defined here rather than in either.
 *
 * `run` is passed in rather than imported so this stays a pure function of a plan, which
 * is the property that makes the planner testable without loading a decoder. `feed` is
 * whatever `Graph.pluginFeed` handed back — the samples or the bytes, and the facts about
 * them a decoder cannot work out for itself.
 */
export function runPlugins(tried, feed, run, onResult = null) {
  const results = [];
  for (const cand of tried) {
    const out = run(cand.id, feed.data, cand.params, feed.info) || { records: [] };
    const records = out.records || [];
    const row = {
      id: cand.id, name: cand.name, via: null, viaLabel: '', params: cand.params,
      plugin: true,
      records: records.length, ms: out.ms, error: out.error,
      thin: records.length > 0 && textLength(records) < MIN_DECODE_CHARS,
      suspect: records.length > 0 && records.every((r) => r.suspect),
      sample: records.slice(0, 3).map((r) => r.text),
    };
    results.push(row);
    if (onResult) onResult(row);
  }
  return results;
}

// Below this many characters across all of a decoder's records, a speculative pass does
// not call it a decode. Three: enough to rule out a single symbol found in noise, few
// enough to keep a short but real answer — eight DTMF digits are eight characters.
//
// Here rather than in the engine because both halves of a report have to agree on it. A
// plugin row and an adapter row sit in the same list and are sorted against each other,
// and a threshold that was three in one file and something else in another would rank
// them by which code path produced them.
export const MIN_DECODE_CHARS = 3;

export const textLength = (records) =>
  records.reduce((n, r) => n + String((r && r.text) ?? '').trim().length, 0);

/**
 * Everything that has to run between the node being identified and this decoder.
 *
 * A list rather than the single demodulator it used to be, because one decoder here does
 * not read samples: `m17-packet-decode` reads one float per symbol, so a symbol sync has
 * to sit between the discriminator and it (ADR-0040). The adapter declares that as
 * `after`, so this stays a question about data rather than a list of special cases — and
 * a decoder that grows a second stage later costs a field, not an edit here.
 *
 * `null` still means "hand it the stream as it is", which is what every other adapter on
 * a matching stream gets.
 */
function chain(a, demod) {
  const ops = [...(demod ? [demod.op] : []), ...(a.after || []).map((s) => s.op)];
  if (!ops.length) return { via: null, viaLabel: null };
  const labels = [...(demod ? [demod.label] : []), ...(a.after || []).map((s) => label(s.op))];
  return { via: ops, viaLabel: labels.join(' \u2192 ') };
}

// The one place a stage's name is written down. A plan is built from descriptors and
// cannot reach into the engine's operation table (ADR-0029), and two names is not a table.
const label = (op) => (op === 'core.symbols' ? 'Symbol sync' : op.replace(/^core\./, ''));

/**
 * The rate the stream feeding this decoder's chain should be at.
 *
 * Usually the rate it reads itself. Not always: a symbol decoder reads 4800 *symbols* a
 * second off a stream that has to have been wide enough to contain them, and sizing the
 * shared decimation from 4800 would narrow the channel to a few kilohertz and remove the
 * signal before the symbol sync ever saw it. The adapter says which.
 *
 * **Sizing only.** This is a preference — the rate the stage in front would like — and
 * not a floor, which is the distinction the check below turns on.
 */
export function feedRate(a) {
  const first = (a.after || [])[0];
  return (first && first.rate) || a.wants.rate;
}

/**
 * Could this stream be resampled up to what the decoder reads, without inventing
 * bandwidth the capture never had?
 *
 * `wants.rate`, not `feedRate`. For a decoder with a stage in front of it the two are
 * different questions and only `minRate` answers the second one — measured on the
 * GRCon26 composite, whose M17 slot its own metadata calls 9 kHz wide: a tuner sized to
 * that lands at 11.9 kS/s, and testing it against the symbol sync's preferred 48 kS/s
 * rejected it for being 4.03× short of a number that was never a requirement. The signal
 * was there and the decoder was never asked.
 */
const fits = (a, sampleRate) => !(a.wants.rate > sampleRate * RATE_HEADROOM);

/**
 * Some decoders read something that is not in a narrow stream at all.
 *
 * `wants.rate` is a preference and being under it costs quality; `minRate` is a floor and
 * being under it costs everything. redsea reads a subcarrier at 57 kHz, so a 40 kHz
 * channel does not contain the signal whatever it is resampled to — and the difference
 * matters twice over. The report is honest instead of empty, and the speculative pass
 * does not decimate and demodulate a wide span on every capture to look for something
 * that could not be there: on a 2.4 MS/s capture that alone was a second per
 * demodulator, paid by every other decoder in the run.
 */
const wideEnough = (a, sampleRate) => !(a.minRate && sampleRate < a.minRate);

/**
 * The settings to run an adapter with when nobody has chosen any.
 *
 * Its own defaults, then whatever it says "try everything" means for it. Only the
 * adapter can know that second part: multimon-ng's default is three POCSAG rates,
 * because a default should be cheap, but a speculative pass wants its whole -a list and
 * should pay the CPU for it. Running with no parameters at all — which is what `{}`
 * means — silently asked every adapter for its least capable configuration.
 *
 * The chosen settings travel in the plan and in the report, so that picking a decoder
 * out of an `Identify` builds a node configured the way the one that answered was. A
 * report you cannot reproduce by clicking the row is worse than no report.
 */
export function settings(a) {
  const out = {};
  for (const pm of a.params || []) out[pm.id] = pm.default;
  return { ...out, ...(a.sweep || {}) };
}

function rateWhy(a, sampleRate) {
  const want = a.wants.rate;
  const f = want / sampleRate;
  return `wants ${fmtRate(want)} and this stream is ${fmtRate(sampleRate)} — ` +
         `resampling up ${f.toFixed(f < 10 ? 1 : 0)}× cannot put back bandwidth the capture never had`;
}

function narrowWhy(a, sampleRate) {
  return `needs at least ${fmtRate(a.minRate)} and this stream is ${fmtRate(sampleRate)} — ` +
         `what it decodes is not inside a channel this narrow, so resampling cannot reach it`;
}

export const say = (kind) => (kind === 'real' ? 'audio' : kind);

export function fmtRate(hz) {
  return hz >= 1e6
    ? `${(hz / 1e6).toFixed(hz % 1e6 ? 2 : 0)} MS/s`
    : `${(hz / 1e3).toFixed(hz % 1e3 ? 2 : 0)} kS/s`;
}
