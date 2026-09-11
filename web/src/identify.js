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
 * @param {{kind: string, sampleRate: number, demods?: Array<{op: string, label: string}>}} stream
 * @returns {{tried: Array, skipped: Array}}
 */
export function plan(adapters, { kind, sampleRate, demods = [] }) {
  const tried = [], skipped = [];
  for (const a of adapters || []) {
    const row = { id: a.id, name: a.name, blurb: a.blurb, wants: a.wants, params: settings(a) };
    if (!a.available) { skipped.push({ ...row, why: `${a.command} is not installed on this machine` }); continue; }

    if (a.in === kind) {
      if (fits(a, sampleRate)) tried.push({ ...row, via: null, viaLabel: null });
      else skipped.push({ ...row, why: rateWhy(a, sampleRate) });
      continue;
    }
    // An audio decoder on a channel of IQ is the ordinary case, not a special one: it is
    // the chain the graph would build by hand, a demodulator and then the decoder. Both
    // demodulators go in the plan, because which one is right is the question being asked.
    if (a.in === 'real' && kind === 'iq' && demods.length) {
      if (!fits(a, sampleRate)) { skipped.push({ ...row, why: rateWhy(a, sampleRate) }); continue; }
      for (const d of demods) tried.push({ ...row, via: d.op, viaLabel: d.label });
      continue;
    }
    skipped.push({ ...row, why: `takes ${say(a.in)}, and this is ${say(kind)}` });
  }
  return { tried, skipped };
}

const fits = (a, sampleRate) => !(a.wants.rate > sampleRate * RATE_HEADROOM);

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
  const f = a.wants.rate / sampleRate;
  return `wants ${fmtRate(a.wants.rate)} and this stream is ${fmtRate(sampleRate)} — ` +
         `resampling up ${f.toFixed(f < 10 ? 1 : 0)}× cannot put back bandwidth the capture never had`;
}

const say = (kind) => (kind === 'real' ? 'audio' : kind);

export function fmtRate(hz) {
  return hz >= 1e6
    ? `${(hz / 1e6).toFixed(hz % 1e6 ? 2 : 0)} MS/s`
    : `${(hz / 1e3).toFixed(hz % 1e3 ? 2 : 0)} kS/s`;
}
