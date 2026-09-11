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
import os from 'node:os';
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

    // When it recognises nothing, ask it what it saw.
    //
    // rtl_433 has an analyzer that measures the pulse and gap distributions and then
    // prints the flex-decoder line that would read them. That is the same answer this
    // tool gives everywhere else — here is the parameter, and here is what the signal
    // said it should be (ADR-0017) — so a decode that finds nothing should end with
    // that rather than with silence.
    explain: {
      args: ({ rate, centerHz }) => [
        '-r', 'cu8:-', '-s', String(Math.round(rate)),
        ...(centerHz ? ['-f', String(Math.round(centerHz))] : []),
        '-A',
      ],
      parse(text) {
        const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
        const suggestion = /-X\s+'([^']+)'/.exec(clean);
        const pulses = [...clean.matchAll(/^\s*\[\s*\d+\]\s+count:\s*(\d+),\s+width:\s*(\d+)\s*us/gm)]
          .map((m) => `${m[2]} µs ×${m[1]}`);
        const guess = /Guessing modulation:\s*(.+)/.exec(clean);
        if (!pulses.length && !suggestion) return null;
        // Two different kinds of claim, kept apart on purpose. The pulse widths are
        // measurements and can be relied on. The modulation is an inference — rtl_433
        // says "Guessing modulation" and it is right to — and on a signal that is PWM
        // it will happily guess Manchester, produce a decode, and the decode will not
        // be the message. Presenting both as "it suggests" was overstating half of it.
        return {
          measured: pulses.length ? `pulses at ${[...new Set(pulses)].slice(0, 4).join(', ')}` : null,
          guess: guess ? guess[1].trim() : null,
          suggestion: suggestion ? suggestion[1] : null,
        };
      },
    },
  },

  'ext.multimon': {
    name: 'multimon-ng', group: 'Decode', in: 'real', out: 'events',
    command: 'multimon-ng',
    blurb: 'POCSAG, FLEX, AFSK, DTMF, ZVEI and more',
    // multimon-ng is fixed at 22.05 kHz signed 16-bit mono, and says so if you disagree
    wants: { format: 's16', rate: 22_050 },
    params: [
      { id: 'modes', type: 'text', default: 'POCSAG512 POCSAG1200 POCSAG2400',
        label: 'demodulators', placeholder: 'POCSAG1200 FLEX AFSK1200 DTMF MORSE_CW',
        hint: 'space-separated: POCSAG512/1200/2400, FLEX, AFSK1200/2400, FSK9600, ' +
              'DTMF, MORSE_CW, ZVEI1/2/3, EAS, X10. Each one costs CPU, so it is a ' +
              'list rather than everything' },
    ],
    args: ({ params }) => [
      '-t', 'raw',
      ...String(params.modes || 'POCSAG1200').trim().split(/\s+/).filter(Boolean).flatMap((m) => ['-a', m]),
      '-',
    ],
    // multimon-ng prints an AX.25 packet as two lines — "AFSK1200: fm N0CALL-0 to
    // APRS-0 UI  pid=F0" and then the payload on its own. Read as plain lines that is
    // two records, one of which is a header with no message and one a message with no
    // sender.
    //
    // Only AX.25 does that, which is why the test is the shape of its header rather
    // than "the line before had a prefix": POCSAG and FLEX put everything on one line,
    // DTMF prints one digit per line, and MORSE_CW prints bare text with no prefix at
    // all — so a rule that glued any unprefixed line onto the record above it would
    // turn a Morse decode after a DTMF digit into a mangled hybrid of the two.
    parse: (stdout) => {
      const out = [];
      const isAx25Header = (s) => /^fm \S+ to \S+/.test(s);
      for (const raw of stdout.split('\n')) {
        const line = raw.trim();
        if (!line || CHATTER.some((re) => re.test(line))) continue;
        const m = /^([A-Z][A-Z0-9_]+):\s*(.*)$/.exec(line);
        if (m) { out.push({ text: m[2], demod: m[1] }); continue; }
        const prev = out[out.length - 1];
        if (prev && !prev.envelope && isAx25Header(prev.text)) {
          prev.envelope = prev.text;
          prev.text = line;
        } else out.push({ text: line });
      }
      return out;
    },
    title: ['text'],
  },

  'ext.dump1090': {
    name: 'dump1090', group: 'Decode', in: 'iq', out: 'events',
    // Three distributions ship this program under three names and none of them is
    // `dump1090`: Debian has dump1090-mutability, FlightAware has dump1090-fa. The
    // adapter that named only the upstream binary was unavailable on every machine
    // that actually had it installed.
    command: ['dump1090', 'dump1090-mutability', 'dump1090-fa'],
    blurb: 'ADS-B — aircraft position and identity',
    // 2.4 MS/s is what Mode S wants and what dump1090 assumes; its own bandwidth is
    // 2 MHz, so this is not a number to nudge.
    wants: { format: 'cu8', rate: 2_400_000 },
    params: [],
    // --quiet does not mean "no banner", it means "no stdout" — which is where the
    // decodes are. The shipped args asked for --raw and then silenced it.
    args: () => ['--ifile', '-', '--iformat', 'UC8', '--raw'],
    parse: (stdout) => stdout.split('\n')
      .map((s) => s.trim())
      .filter((s) => /^\*[0-9a-f]+;$/i.test(s))
      .map((s) => {
        const hex = s.slice(1, -1);
        const df = parseInt(hex.slice(0, 2), 16) >> 3;
        const rec = { text: hex, df, bits: hex.length * 4 };
        // The address is in the same place for the downlink formats that carry one,
        // and it is the one field worth reading without a full Mode S decoder here.
        if (df === 17 || df === 18 || df === 11) rec.icao = hex.slice(2, 8).toUpperCase();
        return rec;
      }),
    title: ['text'],
  },

  'ext.direwolf': {
    name: 'direwolf', group: 'Decode', in: 'real', out: 'events',
    command: 'direwolf',
    blurb: 'APRS / AX.25 packet radio',
    wants: { format: 's16', rate: 44_100 },
    params: [
      { id: 'modem', type: 'text', default: '1200', label: 'modem',
        placeholder: '1200 or 9600 or 300',
        hint: "direwolf's MODEM line: the baud rate, and the tones that go with it" },
    ],
    // Three things here were wrong and each one was silent in a different way.
    //
    // `-` is not stdin to direwolf — getopt eats it, and the program then has no file
    // argument at all. The word it wants is `stdin`.
    //
    // Without a config file it opens the default sound device, and on a box with no
    // sound card (a container, a server, anything headless) it prints "Pointless to
    // continue without audio device" and exits before reading a sample. The config
    // below points it at stdin and nothing else; AGWPORT and KISSPORT are zeroed
    // because otherwise it listens on 8000 and 8001, which is not a thing a decode
    // should do.
    //
    // And `-q hd` suppresses the hex and decoded output — exactly the lines we run it
    // for. What we do want quiet is its own audio-level chatter, which is `-q d`... but
    // that hides the decodes too, so the filtering happens here instead.
    files: ({ params }) => [{
      name: 'direwolf.conf',
      text: [
        'ADEVICE stdin null',
        'ACHANNELS 1',
        'CHANNEL 0',
        `MODEM ${String(params.modem || '1200').trim() || '1200'}`,
        'AGWPORT 0',
        'KISSPORT 0',
      ].join('\n') + '\n',
    }],
    args: ({ rate, dir }) => [
      '-c', path.join(dir, 'direwolf.conf'),
      '-r', String(Math.round(rate)), '-n', '1', '-b', '16',
      '-t', '0',                              // no color: the escapes are not data
      'stdin',
    ],
    parse: (stdout) => {
      const out = [];
      let level = null;
      for (const raw of stdout.split('\n')) {
        const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
        if (!line) continue;
        const lv = /audio level = (\d+)/.exec(line);
        if (lv) { level = Number(lv[1]); continue; }
        // "[0.3] N0CALL>APRS:=4903.50N/..." — the number is which decoder in the
        // stack found it, and direwolf writes control bytes as <0xNN>.
        const m = /^\[(\d+)(?:\.(\d+))?\]\s+(.+)$/.exec(line);
        if (!m) continue;
        const rec = { text: m[3].replace(/<0x0a>/g, '').trim() };
        if (level != null) { rec.level = level; level = null; }
        out.push(rec);
      }
      return out;
    },
    title: ['text'],
  },

  'ext.minimodem': {
    name: 'minimodem', group: 'Decode', in: 'real', out: 'events',
    command: 'minimodem',
    blurb: 'RTTY, Bell 103/202, and any N-baud FSK',
    // minimodem reads through libsndfile, which will not take headerless samples on a
    // pipe — `-f -` on raw bytes is "Format not recognised". It will take a WAV on a
    // pipe, though, and since the whole span is in hand before the program starts, the
    // header can carry a truthful length rather than the streaming fiction of 0xffffffff.
    wants: { format: 's16', rate: 48_000, container: 'wav' },
    params: [
      { id: 'baudmode', type: 'text', default: '1200', label: 'baud mode',
        placeholder: '1200, 300, rtty, same, callerid',
        hint: "minimodem's own baudmode: a number is Bell-like at that rate, or a name" },
      { id: 'mark', type: 'text', default: '', label: 'mark Hz', placeholder: 'e.g. 1200',
        hint: 'override the tone pair; empty means whatever the baud mode implies' },
      { id: 'space', type: 'text', default: '', label: 'space Hz', placeholder: 'e.g. 2200' },
    ],
    args: ({ params }) => [
      '--rx', '-f', '-',
      ...(params.mark ? ['-M', String(params.mark)] : []),
      ...(params.space ? ['-S', String(params.space)] : []),
      String(params.baudmode || '1200').trim() || '1200',
    ],
    // The decoded characters come out on stdout and the carrier report on stderr, so
    // this is the one adapter that has to read both to produce a record. Which is the
    // right shape anyway: minimodem is a modem, not a packet decoder — a transmission
    // is a run of characters between a carrier appearing and going away, and the
    // confidence and measured bit rate it prints at the end are evidence about that
    // run rather than chatter to drop (ADR-0017).
    parse: (stdout, stderr) => {
      const text = stdout.replace(/\r/g, '').replace(/\u0000/g, '').trim();
      const ev = [];
      for (const line of String(stderr).split('\n')) {
        const c = /### CARRIER\s+(\S+)\s+@\s+([\d.]+)\s*Hz/.exec(line);
        if (c) { ev.push({ mode: c[1], markHz: Number(c[2]) }); continue; }
        const n = /### NOCARRIER\s+(.*?)\s*###/.exec(line);
        if (n && ev.length) {
          const last = ev[ev.length - 1];
          for (const kv of n[1].split(/\s+/)) {
            const [k, v] = kv.split('=');
            if (v != null && v !== '') last[k] = Number.isNaN(Number(v)) ? v : Number(v);
          }
        }
      }
      if (!text) return [];
      // One record per line of decoded text, each carrying what the modem measured.
      const stats = ev[0] || {};
      return text.split('\n').map((line) => ({
        text: line,
        ...(stats.markHz ? { carrierHz: stats.markHz } : {}),
        ...(stats.confidence ? { confidence: stats.confidence } : {}),
        ...(stats.bps ? { bps: stats.bps } : {}),
      }));
    },
    title: ['text'],
  },
};

/**
 * Which of this adapter's candidate binaries is actually on the box, if any.
 *
 * `command` is a list because the same program ships under different names — dump1090
 * is `dump1090-mutability` on Debian and `dump1090-fa` from FlightAware, and an adapter
 * that knew only the upstream name reported "not installed" on machines that had it.
 * First name found wins, so the list is in preference order.
 */
export function resolve(id) {
  const a = ADAPTERS[id];
  if (!a) return null;
  const wanted = Array.isArray(a.command) ? a.command : [a.command];
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE').split(';').filter(Boolean)
    : [];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const name of wanted) {
    const names = exts.length ? [name, ...exts.flatMap((e) => [name + e.toLowerCase(), name + e])] : [name];
    for (const dir of dirs) {
      for (const n of names) {
        try { if (fs.statSync(path.join(dir, n)).isFile()) return name; } catch { /* next */ }
      }
    }
  }
  return null;
}

/** Is the program this adapter needs on the box? */
export function available(id) {
  return resolve(id) != null;
}

/** What to call it when it is missing, which is the whole list rather than a guess. */
function commandNames(a) {
  return (Array.isArray(a.command) ? a.command : [a.command]).join(' / ');
}

/** Every adapter, with whether it could actually run here. */
export function list() {
  return Object.entries(ADAPTERS).map(([id, a]) => {
    const found = resolve(id);
    return {
      id, name: a.name, group: a.group, in: a.in, out: a.out,
      // The name it will actually run under, when there is one — a box with
      // dump1090-mutability should say so rather than claim a binary it does not have.
      command: found || commandNames(a), blurb: a.blurb, params: a.params,
      wants: a.wants, available: found != null,
    };
  });
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

  // Some of these read through libsndfile, which will not look at headerless bytes on a
  // pipe: minimodem given raw samples says "Format not recognised" and stops. Because
  // the whole span is in hand before the program starts, the header can carry the real
  // length instead of the 0xffffffff a streaming writer has to use — so the decoder
  // knows where the signal ends rather than reading until the pipe closes.
  if (want.container === 'wav') {
    bytes = Buffer.concat([wavHeader(bytes.length, want.rate, want.format), bytes]);
    note.push('in a WAV wrapper');
  }
  return { bytes, note: note.join(', '), samples: kind === 'iq' ? out.length / 2 : out.length };
}

/** 44 bytes of canonical RIFF, mono, with a truthful data length. */
function wavHeader(dataLen, rate, format) {
  const bits = format === 'cf32' ? 32 : format === 's16' || format === 'cs16' ? 16 : 8;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataLen, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(format === 'cf32' ? 3 : 1, 20);     // 3 is IEEE float, 1 is PCM
  h.writeUInt16LE(1, 22);                             // mono
  h.writeUInt32LE(Math.round(rate), 24);
  h.writeUInt32LE(Math.round(rate) * (bits / 8), 28);
  h.writeUInt16LE(bits / 8, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataLen, 40);
  return h;
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

/**
 * A spec reads its own output when it has an opinion, and otherwise gets lines.
 *
 * stderr is handed over as well because one of these needs it: minimodem writes the
 * decoded characters to stdout and the carrier report to stderr, and the report is
 * the evidence for the decode rather than noise beside it.
 */
function readRecords(spec, stdout, stderr) {
  if (typeof spec.parse === 'function') return spec.parse(stdout, stderr, spec);
  if (spec.parse === 'jsonl') return parseJsonl(stdout, spec);
  return parseLines(stdout);
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
  const command = resolve(id);
  if (!command) {
    return Promise.resolve({ records: [], error: `${commandNames(spec)} is not installed on this machine` });
  }

  let input;
  try {
    input = convert(data, kind, sampleRate, spec.wants);
  } catch (e) {
    return Promise.resolve({ records: [], error: e.message });
  }

  // Some of these are configured by file rather than by flag — direwolf will not start
  // without one on a machine with no sound card, which is every machine this runs on.
  // The directory is per-run and goes away with the run, so a decode leaves nothing
  // behind and two decodes cannot read each other's config.
  let dir = null;
  try {
    if (spec.files) {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdrflex-'));
      for (const file of spec.files({ rate: spec.wants.rate, centerHz, params })) {
        fs.writeFileSync(path.join(dir, file.name), file.text);
      }
    }
  } catch (e) {
    return Promise.resolve({ records: [], error: `could not set up ${command}: ${e.message}` });
  }

  const args = spec.args({ rate: spec.wants.rate, centerHz, params, dir });
  const started = Date.now();

  return new Promise((done_) => {
    const proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', done = false;

    const finish = async (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* it is a temp dir */ } }
      const records = readRecords(spec, stdout, stderr);

      // Nothing recognised is a result, not a failure — but a result with no account of
      // itself is a dead end, and "I ran a decoder and it said nothing" is the least
      // useful thing this tool could tell anybody.
      let told = null;
      if (!records.length && !error && spec.explain) {
        told = await explain(spec, command, input.bytes, { rate: spec.wants.rate, centerHz, params });
      }

      done_({
        records, ms: Date.now() - started,
        note: `${command} · ${input.note}`,
        // stderr is where these programs say the useful things — what they enabled,
        // what they could not parse — and it is only worth surfacing when nothing came
        // back, where it is usually the reason. Their banners and advice are not
        // reasons, and reporting "Use -F log if you want any messages" as the error
        // when a decoder simply found nothing is worse than saying nothing.
        error: error || (records.length === 0 ? complaint(stderr) : undefined),
        ...(told ? { explained: told } : {}),
      });
    };

    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } finish(`${command} did not finish within ${timeoutMs / 1000}s`); }, timeoutMs);

    proc.stdout.on('data', (b) => { stdout += b; });
    proc.stderr.on('data', (b) => { stderr += b; });
    proc.on('error', (e) => finish(e.code === 'ENOENT'
      ? `${command} is not installed on this machine` : e.message));
    proc.on('close', (code) => finish(code && code !== 0 && !stdout
      ? `${command} exited ${code}: ${firstLine(stderr)}` : undefined));

    // A decoder that stops reading — dump1090 quits once it has what it wants — closes
    // the pipe under us, and that is a normal end rather than a fault.
    proc.stdin.on('error', () => {});
    proc.stdin.end(input.bytes);
  });
}

/**
 * Ask a decoder what it saw, when it recognised nothing.
 *
 * Bounded hard: it runs once, on the same samples, with a short timeout. A decoder that
 * cannot explain itself quickly is one that has already cost the user enough time.
 */
function explain(spec, command, bytes, ctx) {
  return new Promise((resolve) => {
    let out = '', done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
    let proc;
    try { proc = spawn(command, spec.explain.args(ctx), { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { resolve(null); return; }
    const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } finish(null); }, 20_000);
    proc.stdout.on('data', (b) => { out += b; });
    proc.stderr.on('data', (b) => { out += b; });
    proc.on('error', () => finish(null));
    proc.on('close', () => { try { finish(spec.explain.parse(out)); } catch { finish(null); } });
    proc.stdin.on('error', () => {});
    proc.stdin.end(bytes);
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
