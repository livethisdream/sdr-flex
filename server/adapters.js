// Decoders somebody else already wrote.
//
// The largest body of proven decoding in this field ships as standalone Unix programs
// that agreed on an interface decades ago: samples in, records out. `rtl_433` alone is
// 250-odd ISM protocols, `multimon-ng` about fifteen, `dump1090` is ADS-B, `direwolf`
// is APRS. Writing those natively is years of work and the result would be worse,
// because these have absorbed a decade of real-world signal weirdness that no
// specification mentions (ADR-0013).
//
// So an adapter is a table row: what to run, what samples it wants on stdin, and how to
// read what it says. The engine derives the conversion and resampling. It is the same
// shape as the radio drivers in `radio.js`, for the same reason — the pipe is the
// interface these programs already have, and it costs a copy at a few hundred kS/s.
//
// Three things come free with the subprocess boundary and are worth naming, because
// each would otherwise be paid for separately: a decoder that segfaults kills a pipe
// rather than a session; a GPL decoder invoked at arm's length is aggregation rather
// than linking (ADR-0015); and a version of it we have never tested still runs, it
// just may not match what the manifest expected.
//
// These ship with the tool. They are not user-supplied, and that is deliberate: an
// adapter is a command line, so a droppable one is arbitrary code execution on the box.
// That is exactly why dropped plugins run in the browser instead (ADR-0029).

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resample } from '../web/src/export.js';

/**
 * `wants` is the format and rate the program needs on stdin. `args` builds its command
 * line. `parse` turns its stdout into records. `params` are the knobs worth exposing —
 * deliberately few, because a node you cannot see inside should not pretend otherwise.
 */
export const ADAPTERS = {
  'ext.rtl433': {
    name: 'rtl_433', group: 'Decode', in: 'iq', out: 'events',
    command: 'rtl_433',
    blurb: '250+ ISM device protocols',
    wants: { format: 'cu8', rate: 250_000 },
    params: [
      // rtl_433's own flex decoder, which is how you read a protocol it does not know.
      // Left empty by default: with no -X it runs every built-in decoder, which is the
      // reason to reach for it in the first place.
      { id: 'flex', type: 'text', default: '',
        label: 'flex decoder', placeholder: 'n=mine,m=OOK_PWM,s=250,l=500,r=6000',
        hint: "rtl_433's own -X spec, for a protocol it does not know" },
      { id: 'protocol', type: 'text', default: '', label: 'only protocol',
        placeholder: 'e.g. 40', hint: 'restrict to one -R number; empty means all of them' },
    ],
    args: ({ rate, centerHz, params }) => [
      '-r', 'cu8:-',
      '-s', String(Math.round(rate)),
      ...(centerHz ? ['-f', String(Math.round(centerHz))] : []),
      '-F', 'json',
      // one row per decode with the level in it, and no console chatter on stdout
      '-M', 'level',
      ...(params.protocol ? ['-R', String(params.protocol)] : []),
      ...(params.flex ? ['-X', String(params.flex)] : []),
    ],
    parse: 'jsonl',
    // What to show as the headline of a record, in order of preference.
    title: ['model', 'type', 'codes', 'data'],
  },

  'ext.multimon': {
    name: 'multimon-ng', group: 'Decode', in: 'real', out: 'events',
    command: 'multimon-ng',
    blurb: 'POCSAG, FLEX, AFSK, DTMF, ZVEI and more',
    // multimon-ng is fixed at 22.05 kHz signed 16-bit mono, and says so if you disagree
    wants: { format: 's16', rate: 22_050 },
    params: [
      { id: 'modes', type: 'text', default: 'POCSAG512 POCSAG1200 POCSAG2400',
        label: 'demodulators', placeholder: 'POCSAG1200 FLEX AFSK1200',
        hint: 'space-separated; each one costs CPU, so it is a list rather than everything' },
    ],
    args: ({ params }) => [
      '-t', 'raw',
      ...String(params.modes || 'POCSAG1200').trim().split(/\s+/).filter(Boolean).flatMap((m) => ['-a', m]),
      '-',
    ],
    parse: 'lines',
    title: ['text'],
  },

  'ext.dump1090': {
    name: 'dump1090', group: 'Decode', in: 'iq', out: 'events',
    command: 'dump1090',
    blurb: 'ADS-B — aircraft position and identity',
    wants: { format: 'cu8', rate: 2_400_000 },
    params: [],
    args: () => ['--ifile', '-', '--raw', '--quiet'],
    parse: 'lines',
    title: ['text'],
  },

  'ext.direwolf': {
    name: 'direwolf', group: 'Decode', in: 'real', out: 'events',
    command: 'direwolf',
    blurb: 'APRS / AX.25 packet radio',
    wants: { format: 's16', rate: 44_100 },
    params: [],
    args: ({ rate }) => ['-r', String(Math.round(rate)), '-n', '1', '-b', '16', '-q', 'hd', '-t', '0', '-'],
    parse: 'lines',
    title: ['text'],
  },
};

/** Is the program this adapter needs on the box? */
export function available(id) {
  const a = ADAPTERS[id];
  if (!a) return false;
  const names = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE').split(';').filter(Boolean).flatMap((e) => [a.command + e.toLowerCase(), a.command + e])
    : [a.command];
  return (process.env.PATH || '').split(path.delimiter).filter(Boolean).some((dir) =>
    names.concat(a.command).some((n) => {
      try { return fs.statSync(path.join(dir, n)).isFile(); } catch { return false; }
    }));
}

/** Every adapter, with whether it could actually run here. */
export function list() {
  return Object.entries(ADAPTERS).map(([id, a]) => ({
    id, name: a.name, group: a.group, in: a.in, out: a.out,
    command: a.command, blurb: a.blurb, params: a.params,
    wants: a.wants, available: available(id),
  }));
}

/**
 * Samples in the format the program is expecting.
 *
 * Two conversions, and both change what the decoder sees, so both are reported rather
 * than done quietly. Resampling is the interesting one: a decoder tuned for 250 kS/s
 * given 2 MS/s does not fail, it just decodes worse, and "why does rtl_433 find nothing
 * here but everything in the same signal saved to a file" is a bad afternoon.
 */
export function convert(data, kind, fromRate, want) {
  const note = [];
  let out = data;

  if (Math.abs(fromRate - want.rate) / want.rate > 0.001) {
    // IQ is interleaved, so the two halves are resampled separately — resampling the
    // interleaved array directly would filter I against Q and produce nonsense.
    if (kind === 'iq') {
      const n = data.length / 2;
      const i = new Float32Array(n), q = new Float32Array(n);
      for (let k = 0; k < n; k++) { i[k] = data[k * 2]; q[k] = data[k * 2 + 1]; }
      const ri = resample(i, fromRate, want.rate), rq = resample(q, fromRate, want.rate);
      out = new Float32Array(ri.length * 2);
      for (let k = 0; k < ri.length; k++) { out[k * 2] = ri[k]; out[k * 2 + 1] = rq[k]; }
    } else {
      out = resample(data, fromRate, want.rate);
    }
    note.push(`resampled ${(fromRate / 1e3).toFixed(1)} → ${(want.rate / 1e3).toFixed(1)} kS/s`);
  }

  let bytes;
  if (want.format === 'cu8') {
    bytes = Buffer.allocUnsafe(out.length);
    for (let i = 0; i < out.length; i++) {
      bytes[i] = Math.max(0, Math.min(255, Math.round(out[i] * 127.5 + 127.5)));
    }
  } else if (want.format === 's16') {
    bytes = Buffer.allocUnsafe(out.length * 2);
    for (let i = 0; i < out.length; i++) {
      bytes.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(out[i] * 32767))), i * 2);
    }
  } else if (want.format === 'cs16') {
    bytes = Buffer.allocUnsafe(out.length * 2);
    for (let i = 0; i < out.length; i++) {
      bytes.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(out[i] * 32767))), i * 2);
    }
  } else if (want.format === 'cf32') {
    bytes = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
  } else {
    throw new Error(`no conversion to ${want.format}`);
  }
  note.push(`${want.format} at ${(want.rate / 1e3).toFixed(1)} kS/s`);
  return { bytes, note: note.join(', '), samples: kind === 'iq' ? out.length / 2 : out.length };
}

/** One JSON object per line, which is what every modern one of these emits. */
function parseJsonl(text, spec) {
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let o;
    try { o = JSON.parse(s); } catch { continue; }
    const title = spec.title.map((k) => o[k]).find((v) => v != null);
    const rec = { text: fmtTitle(title, o) };
    for (const [k, v] of Object.entries(o)) {
      if (k === 'time' || v == null) continue;
      if (spec.title.includes(k) && String(v) === String(title)) continue;
      // An array of strings is the answer often enough to be worth keeping: rtl_433's
      // flex decoder reports what it read as `codes`, and dropping it for being an
      // array left a record that said a decode happened and not what it said.
      if (Array.isArray(v)) {
        const flat = v.filter((x) => x == null || typeof x !== 'object');
        if (flat.length) rec[k] = flat.length > 6 ? `${flat.slice(0, 6).join(' ')} … (${flat.length})` : flat.join(' ');
        continue;
      }
      if (typeof v === 'object') continue;      // `rows`, which `codes` already says
      rec[k] = v;
    }
    out.push(rec);
  }
  return out;
}

function fmtTitle(title, o) {
  if (Array.isArray(title)) return title.join(' ');
  if (title != null) return String(title);
  return JSON.stringify(o).slice(0, 120);
}

/** Everything else: one record per non-empty line, banners and chatter dropped. */
function parseLines(text) {
  return text.split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !/^(Enabled demodulators|multimon-ng|\(C\)|Available demodulators)/i.test(s))
    .map((s) => ({ text: s }));
}

/**
 * Run one, over a span of samples.
 *
 * The whole span goes in and stdin closes, which is what makes this a job rather than
 * a stream: these programs are written to read a file to the end and exit, and the
 * records come back when they do. A program that hangs anyway is killed on the timeout
 * and its output up to that point is kept — a decoder that found six packets and then
 * wedged has still told you six things.
 */
export function run(id, { data, kind, sampleRate, centerHz, params = {}, timeoutMs = 60_000 }) {
  const spec = ADAPTERS[id];
  if (!spec) return Promise.resolve({ records: [], error: `no adapter ${id}` });
  if (!available(id)) {
    return Promise.resolve({ records: [], error: `${spec.command} is not installed on this machine` });
  }

  let input;
  try {
    input = convert(data, kind, sampleRate, spec.wants);
  } catch (e) {
    return Promise.resolve({ records: [], error: e.message });
  }

  const args = spec.args({ rate: spec.wants.rate, centerHz, params });
  const started = Date.now();

  return new Promise((resolve) => {
    const proc = spawn(spec.command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', done = false;

    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const records = spec.parse === 'jsonl' ? parseJsonl(stdout, spec) : parseLines(stdout);
      resolve({
        records, ms: Date.now() - started,
        note: `${spec.command} · ${input.note}`,
        // stderr is where these programs say the useful things — what they enabled,
        // what they could not parse — and it is only worth surfacing when nothing came
        // back, where it is usually the reason. Their banners and advice are not
        // reasons, and reporting "Use -F log if you want any messages" as the error
        // when a decoder simply found nothing is worse than saying nothing.
        error: error || (records.length === 0 ? complaint(stderr) : undefined),
      });
    };

    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } finish(`${spec.command} did not finish within ${timeoutMs / 1000}s`); }, timeoutMs);

    proc.stdout.on('data', (b) => { stdout += b; });
    proc.stderr.on('data', (b) => { stderr += b; });
    proc.on('error', (e) => finish(e.code === 'ENOENT'
      ? `${spec.command} is not installed on this machine` : e.message));
    proc.on('close', (code) => finish(code && code !== 0 && !stdout
      ? `${spec.command} exited ${code}: ${firstLine(stderr)}` : undefined));

    // A decoder that stops reading — dump1090 quits once it has what it wants — closes
    // the pipe under us, and that is a normal end rather than a fault.
    proc.stdin.on('error', () => {});
    proc.stdin.end(input.bytes);
  });
}

function firstLine(s) {
  return String(s).split('\n').map((x) => x.trim()).filter(Boolean).slice(-1)[0] || '';
}

/** Lines these programs print that are not complaints about the signal. */
const CHATTER = [
  /^rtl_433 version/i, /^Use "-F log"/i, /^\[\w+\]/, /^Registered \d+ out of/i,
  /^multimon-ng/i, /^\(C\)/, /^Available demodulators/i, /^Enabled demodulators/i,
  /^Directory .* does not exist/i, /^dump1090/i, /^Dire ?Wolf/i,
];

function complaint(stderr) {
  const lines = String(stderr).split('\n').map((x) => x.replace(/\x1b\[[0-9;]*m/g, '').trim())
    .filter((x) => x && !CHATTER.some((re) => re.test(x)));
  return lines.length ? lines[lines.length - 1] : undefined;
}
