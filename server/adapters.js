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
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { resample } from '../web/src/export.js';

// Color, for a terminal. Two of these programs draw their report rather than print it,
// and what arrives here is the drawing.
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

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

    // When it recognizes nothing, ask it what it saw.
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
    // A set chosen from a list, not a string somebody types.
    //
    // It was a text field, and the two ways anybody would naturally fill one in both
    // fail: `DTMF,FLEX` — commas, the obvious separator — and any misremembered name
    // make multimon-ng exit 2, and what it prints on the way out is the tail of its
    // usage message, which talks about sample rates. So a typo reads as a rate problem
    // and the field looks like it does not work. It did work; it was unusable.
    //
    // The valid members are fixed, finite, case-insensitive and published by the program
    // itself, which is the definition of a list to pick from.
    params: [
      { id: 'modes', type: 'multi', default: 'POCSAG512 POCSAG1200 POCSAG2400',
        label: 'demodulators', values: () => multimonDemods(),
        hint: 'each one costs CPU, so this is a list rather than everything' },
    ],
    // What "try everything" means here. `Identify` asks each adapter for the settings
    // that make it cast the widest net it usefully can, because only the adapter knows:
    // for multimon-ng that is a long -a list, each entry costing CPU, which is exactly
    // the trade a speculative pass should make and a default should not.
    //
    // Not everything the binary has, though the control above now offers everything.
    // A speculative pass is judged on its false positives, and the tone demodulators
    // multimon-ng ships (the ZVEI/EEA/EIA/CCIR selcall family) emit a record per tone
    // they think they heard, so they print on noise. Measured: with the full list, the
    // `manchester-crc` fixture — a single symbol out of noise, nothing multimon-ng
    // decodes — came back with four non-thin records. Curated, it comes back empty,
    // which is the true answer. The list below is the demodulators that need a framed,
    // checksummed packet before they will say anything, plus DTMF and MORSE_CW, which
    // are the two tone decoders worth the risk because a person actually sweeps for
    // them. Intersected with what this build has, so it never names one the binary
    // lacks.
    sweep: () => {
      const have = new Set(multimonDemods());
      return { modes: SWEEP_DEMODS.filter((m) => have.has(m)).join(' ') };
    },
    args: ({ params }) => {
      const have = new Set(multimonDemods());
      // Filtered against what the binary actually has. It cannot come from the control
      // any more, but a graph saved on a box with a newer multimon-ng can still name
      // FLEX_NEXT at one that has not got it — and losing that one demodulator is a
      // better outcome than the alternative, which is multimon-ng exiting 2 and decoding
      // none of the others either.
      const want = String(params.modes || 'POCSAG1200').trim().split(/\s+/)
        .filter((m) => have.has(m.toUpperCase()));
      return [
        '-t', 'raw',
        ...(want.length ? want : ['POCSAG1200']).flatMap((m) => ['-a', m]),
        '-',
      ];
    },
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
      const stats = ev[0] || {};
      const measured = [stats.bps ? `${stats.bps} bps` : null,
                        stats.confidence ? `confidence ${stats.confidence}` : null]
        .filter(Boolean).join(', ');
      if (!text) return [];

      // A modem will lock onto anything. Given FM audio carrying AX.25, or noise, this
      // one reports a carrier, a plausible bit rate and a respectable confidence, and
      // hands back bytes — the false positive on APRS scored 3.8 against 4.9 for a real
      // Bell 202 decode, so confidence does not separate them and nothing else it
      // reports does either. What separates them is that one is text and the other is
      // not, and this adapter is running in text mode, so that is a fair test.
      //
      // Dropping them silently would be worse than the false positive: "minimodem found
      // nothing" and "minimodem locked on and the bytes are not text" point at different
      // next moves. So the records go and the reason stays.
      const lines = text.split('\n');
      const readable = lines.filter(printableEnough);
      if (!readable.length) {
        return { records: [],
                 note: `locked on (${measured || 'no statistics'}) but the bytes are not text — ` +
                       'a modem will find structure in almost anything' };
      }
      return readable.map((line) => ({
        text: line,
        ...(stats.markHz ? { carrierHz: stats.markHz } : {}),
        ...(stats.confidence ? { confidence: stats.confidence } : {}),
        ...(stats.bps ? { bps: stats.bps } : {}),
      }));
    },
    title: ['text'],
  },
  'ext.m17': {
    name: 'M17', group: 'Decode', in: 'real', out: 'events',
    command: ['m17-demod'],
    blurb: 'M17 stream mode — 4FSK digital voice',
    // M17 is 4FSK at 4800 symbols a second, and its decoder wants the discriminator
    // output rather than IQ — so this goes after an FM demod, the way direwolf does.
    wants: { format: 's16', rate: 48_000 },
    params: [
      { id: 'invert', type: 'enum', default: 'no', values: ['no', 'yes'],
        label: 'inverted',
        hint: 'a receiver that inverts the discriminator turns every symbol upside down; ' +
              'if nothing decodes, this is the first thing to try' },
      { id: 'blanker', type: 'enum', default: 'no', values: ['no', 'yes'],
        label: 'noise blanker', hint: 'silences audio it believes is corrupt' },
    ],
    args: ({ params }) => [
      '-l',                                    // the link setup frame, which is the record
      ...(params.invert === 'yes' ? ['-i'] : []),
      ...(params.blanker === 'yes' ? ['-b'] : []),
    ],
    // The one adapter whose records are not on stdout. stdout is decoded voice — 8 kHz
    // signed 16-bit — and the link setup frame goes to stderr.
    recordsOn: 'stderr',
    parse: (stdout, stderr, spec, meta) => {
      const out = [];
      for (const raw of String(stderr).split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        // "SRC: AB1CDE, DEST: N0CALL, STR:V/V CAN:10, NONCE: 0000…, CRC: 4adf"
        const m = /^SRC:\s*(\S+?),\s*DEST:\s*(\S+?),\s*(.*)$/.exec(line);
        if (!m) continue;                      // LICH, EOS and the rest are progress
        const rec = { text: `${m[1]} → ${m[2]}`, src: m[1], dest: m[2] };
        for (const field of m[3].split(',')) {
          const kv = /^\s*([A-Za-z ]+):\s*(.+?)\s*$/.exec(field);
          if (kv) rec[kv[1].trim().toLowerCase().replace(/\s+/g, '')] = kv[2];
        }
        out.push(rec);
      }
      // A transmission with no link setup in the span is still a transmission, and an
      // empty report would say the opposite.
      //
      // `outBytes` is decoded *voice*, 8 kHz signed 16-bit, so this is seconds of speech
      // and nothing else. It used to be quoted whether or not any came out, which on a
      // packet-mode burst read "0.0 s of voice decoded" — a true statement about the
      // wrong mode, and a confident one, which is the worst way to be unhelpful. M17
      // packet mode is `ext.m17_packet` and a different program entirely; this one
      // cannot read it, so it says so rather than measuring voice that was never there.
      const seconds = (meta.outBytes || 0) / 2 / 8000;
      if (!out.length) {
        return { records: [], note: seconds > 0.05
          ? `${seconds.toFixed(1)} s of voice decoded, but no link setup frame in this ` +
            'span — widen it to catch the start'
          : 'nothing decoded. This reads M17 stream mode; a packet-mode burst (SMS or ' +
            'data) is M17 packet, which reads symbols and needs a Symbol sync in front of it' };
      }
      if (out.length && seconds > 0.05) {
        // Said rather than dropped: the voice is real and this node does not carry it.
        out[0].voiceS = +seconds.toFixed(2);
      }
      return out;
    },
    title: ['text'],
  },

  // M17 again, and the half `ext.m17` cannot do.
  //
  // M17 has two modes and they are decoded by two different programs from two different
  // upstreams. Stream mode carries voice and `m17-demod` (mobilinkd/m17-cxx-demod) reads
  // it. Packet mode carries SMS and arbitrary data, and nothing in m17-cxx-demod reads it
  // at all — `m17-packet-decode` is from M17-Project/M17_Implementations, which is a
  // separate build. The blurb on the other node said "voice and data" and the data half
  // was never there.
  //
  // What makes this one different from every other adapter here: it does not take
  // samples. It takes one float per symbol, already on the symbol grid, because its
  // syncword correlator expects them that way — which is why `core.symbols` exists and
  // why this is the one decoder with a node it has to sit behind. Given samples instead,
  // the conversion in front of it will resample 48 kS/s down to 4800 and say so, and the
  // decode will find nothing: a resampler low-passes and decimates, it does not pick a
  // sampling instant.
  'ext.m17_packet': {
    name: 'M17 packet', group: 'Decode', in: 'real', out: 'events',
    command: ['m17-packet-decode'],
    blurb: 'M17 packet mode — SMS and data, from symbols',
    // One float per symbol at M17's 4800 symbols a second. Not a preference: the program
    // reads a symbol per sample and correlates for the syncword, so a different rate is
    // a different protocol as far as it is concerned.
    wants: { format: 'f32', rate: 4800 },
    // What has to be in front of it, and what that thing wants in front of *it*.
    //
    // `wants.rate` has always meant "the rate of the stream handed to this program's
    // stdin", and for this one that is a symbol rate — 4800 symbols a second, not 4800
    // samples. Nothing else here reads a stream whose rate is not a sample rate, and the
    // difference is not cosmetic: `Identify` sizes the shared decimation from
    // `wants.rate`, so taken as a sample rate it would narrow the channel to a few
    // kilohertz and destroy the very signal the symbols are in. `after` says both halves
    // — the stage, and the rate the stage wants ahead of it.
    after: [{ op: 'core.symbols', rate: 48_000 }],
    // 4FSK at 4800 symbols a second with M17's ±2.4 kHz deviation occupies about 9.6 kHz
    // by Carson (2 × (2400 + 2400)), and that is the number rather than a round one above
    // it. Rounding up to 12 kHz was wrong in a way worth recording: a tuner sized to the
    // GRCon26 composite's own declared 9 kHz M17 slot lands at 11.9 kS/s, so `Identify`
    // skipped the decoder on the exact selection the signal's own metadata describes.
    // Erring low costs a decode attempt that fails; erring high costs the answer, silently.
    minRate: 9_600,
    params: [
      { id: 'callsigns', type: 'enum', default: 'decode', values: ['decode', 'raw'],
        label: 'callsigns',
        hint: 'decoded from M17’s base-40 packing, or left as the six bytes on the wire' },
      // On by default, which is the opposite of what "show me everything" instinct says
      // and is what the numbers ask for. Measured on the GRCon26 composite: 90 seconds
      // containing a 0.2 s packet at 21% duty returns **362 records** with this off —
      // one of them the flag and the rest the dead air between bursts, where demodulated
      // noise happens to correlate with a syncword. Every one of those carries a failed
      // CRC and is marked `suspect`, so nothing is hidden and nothing is ranked as a
      // decode; but a pane you have to scroll 361 rows of garbage to read is not a pane.
      // Turn it off to see what the decoder rejected.
      { id: 'errorfree', type: 'enum', default: 'yes', values: ['yes', 'no'],
        label: 'error-free only',
        hint: 'drop any frame the Viterbi decoder had to correct, rather than reporting it' },
    ],
    args: ({ params }) => [
      ...(params.callsigns !== 'raw' ? ['-c'] : []),
      ...(params.errorfree === 'yes' ? ['-f'] : []),
    ],
    // Like `m17-demod`, and for the same reason: what it prints is a running report on a
    // terminal rather than a data stream, so it goes to stderr.
    recordsOn: 'stderr',
    // It draws a box. Every line is a branch of a tree with a colored label, which is a
    // pleasant thing to watch in a terminal and four escape sequences per line to read
    // here — so the color comes off first and the tree characters are what separates a
    // field name from its value.
    parse: (stdout, stderr, spec, meta) => {
      const plain = String(stderr).replace(ANSI, '');
      const out = [];
      let cur = null;
      const push = () => { if (cur && (cur.text || cur.src)) out.push(cur); cur = null; };
      for (const raw of plain.split('\n')) {
        const line = raw.replace(/^[\s─-╿]+/, '').trim();
        if (!line) continue;
        if (/Packet received/.test(line)) { push(); cur = { fields: 0 }; continue; }
        if (!cur) continue;
        const kv = /^([A-Za-z][A-Za-z ]*):\s*(.*)$/.exec(line);
        if (!kv) continue;
        const key = kv[1].trim().toLowerCase(), val = kv[2].trim();
        cur.fields++;
        if (key === 'source') cur.src = val;
        else if (key === 'destination') cur.dest = val;
        else if (key === 'text') cur.text = val;
        else if (key === 'type') cur.kind = cur.kind || val;   // the LSF type, then the content's
        else if (key === 'lsf crc') cur.lsfCrc = val;
        else if (key === 'payload crc') cur.payloadCrc = val;
      }
      push();
      for (const r of out) {
        delete r.fields;
        // A packet whose payload is not text still happened, and a record with no `text`
        // would be drawn as an empty row. Say what it was instead.
        if (!r.text) r.text = `${r.kind || 'packet'} from ${r.src || 'somebody'}`;
        // Said rather than dropped: a CRC that did not match means the fields above it are
        // a guess, and a decoder that reports a guess as a decode is the thing ADR-0031
        // is about.
        //
        // *Both* checksums, and the link setup one matters more than it first looks.
        // Measured on the envelope of an M17 burst rather than its frequency: five
        // records came back with plausible callsigns — `QJ.I67040`, `FJDX1-RLK` — and a
        // failed LSF CRC on every one. Those never reached a payload at all, so a rule
        // that only watched the payload CRC called all five clean.
        const bad = [r.lsfCrc && r.lsfCrc !== 'match' ? 'link setup' : null,
                     r.payloadCrc && r.payloadCrc !== 'match' ? 'payload' : null].filter(Boolean);
        if (bad.length) r.suspect = `${bad.join(' and ')} CRC mismatch`;
      }
      if (out.length) return out;
      // The failure this adapter is most likely to hit, named rather than left as
      // silence: it was handed samples, something resampled them, and there was never a
      // symbol grid to find.
      const resampled = /resampled/.test(meta && meta.inputNote ? meta.inputNote : '');
      return { records: [], note: resampled
        ? 'nothing decoded — this was handed samples and they were resampled to 4800 S/s. ' +
          'It reads one float per symbol, so put a Symbol sync between the demodulator and this'
        : 'nothing decoded — if there is a burst in this span, try the Symbol sync node’s ' +
          'invert, and check its eye' };
    },
    title: ['text'],
  },

  // The sixth, and the one the tool had to grow a view for before it could be aimed.
  //
  // redsea reads the FM composite itself rather than audio: RDS rides a suppressed 57 kHz
  // subcarrier, so what this wants is the discriminator's *whole* output, not the part of
  // it you can hear. That is why the chain in front of it is a wide tuner and an FM demod
  // and nothing else — a channel narrow enough to listen to has already filtered away the
  // thing being decoded, silently, and the decode then fails by finding nothing.
  // Speech, which is the one decoder here whose failure mode is being *convincing*.
  //
  // Every other program in this table either decodes a frame or does not: a CRC agrees
  // or it does not, a syncword correlates or it does not. Whisper always produces
  // fluent, well-punctuated English. Given silence it produces fluent, well-punctuated
  // English — "Thank you." and "Thanks for watching!" are its two most famous
  // hallucinations, and on a quiet channel it will write them with every appearance of
  // confidence. A transcript of static that reads like a sentence is the worst thing
  // this tool could hand anybody, and it is exactly what ADR-0031 is about.
  //
  // So three of whisper's own gates are turned up from their defaults rather than left
  // where a podcast transcriber would want them, the per-token probabilities come back
  // with every record as the evidence for it (ADR-0017), and anything under the
  // confidence floor is marked `suspect` the way a failed CRC is. Nothing is hidden —
  // a suspect record still appears, it just does not get to be the headline.
  //
  // PocketSphinx was measured first, because it is in the Ubuntu archive *with* its
  // model and would have needed no download at all. On real broadcast speech it
  // returned "have a hand fed is you too soon to use it to the punches". A general
  // language model will always emit fluent word salad; the difference is only whether
  // it is fluent enough to fool you.
  'ext.whisper': {
    name: 'Speech', group: 'Decode', in: 'real', out: 'events',
    command: ['whisper-cli'],
    blurb: 'Speech to text — voice traffic, transcribed',
    // Whisper's own rate. It resamples anything else internally, so converting here
    // instead is one resample rather than two and the note says which one happened.
    // WAV rather than raw: it reads through miniaudio, which wants a container.
    wants: { format: 's16', rate: 16_000, container: 'wav' },
    // Voice is not a narrow channel and a decoder handed 3 kHz of a 12 kHz FM channel
    // has been given the part somebody can hear rather than the part that was sent.
    // Below about this there is not enough of a voice left to be worth the CPU.
    minRate: 6_000,
    params: [
      { id: 'model', type: 'text', default: '', label: 'model',
        placeholder: 'leave empty for the installed one',
        hint: 'path to a ggml model file; the image installs one and SDRFLEX_WHISPER_MODEL points at it' },
      { id: 'language', type: 'text', default: 'en', label: 'language',
        placeholder: 'en, de, auto',
        hint: "a two-letter code, or `auto` to let it guess — guessing costs a pass and is wrong more often on short, noisy audio" },
      // The floor under which a segment is called a guess rather than a decode. 0.6 is
      // a judgment: whisper's token probabilities on clean speech sit well above it and
      // on invented text sit below, but the two distributions overlap and no single
      // number separates them cleanly. It is a parameter because it is a judgment.
      { id: 'confidence', type: 'number', default: 0.6, min: 0, max: 1, step: 0.05,
        label: 'confidence floor',
        hint: 'segments whose mean token probability is under this are marked as guesses, not dropped' },
      { id: 'quiet', type: 'enum', default: 'strict', values: ['strict', 'default'],
        label: 'silence handling',
        hint: 'strict raises whisper’s own no-speech and log-probability gates, which is what stops a quiet channel being transcribed as speech' },
    ],
    args: ({ params }) => [
      '-m', String(params.model || process.env.SDRFLEX_WHISPER_MODEL
                   || '/usr/local/share/whisper/model.bin'),
      // `-` is a filename it understands: it reads the WAV off stdin, so nothing is
      // written to disk for a decode and two decodes cannot read each other's audio.
      '-f', '-',
      // Full JSON to stdout. `-of -` also turns off the segment callback and the
      // progress printing, so stdout carries the JSON and nothing else.
      '-ojf', '-of', '-',
      '-l', String(params.language || 'en').trim() || 'en',
      // Deterministic. A decoder that answers differently on the same samples is not
      // something anybody can debug, and temperature fallback is where whisper does
      // most of its inventing.
      '-tp', '0',
      ...(params.quiet === 'default' ? [] : [
        // Its own gates, turned up. `-nth` is how sure it must be that there *is* no
        // speech before it gives up on a window; `-lpt` is the average log probability
        // under which it rejects a decode outright. Both default to values chosen for
        // podcasts, where the audio is known to contain speech. Here it very often
        // does not.
        '-nth', '0.3',
        '-lpt', '-0.7',
        // Suppress the non-speech tokens whisper otherwise spends its confidence on:
        // music notes, bracketed sound effects, and the subtitle furniture it learned
        // from its training data.
        '-sns',
      ]),
    ],
    // The JSON goes to stdout; the model banner and timings go to stderr.
    parse: (stdout, stderr, spec_, meta) => {
      const params = (meta && meta.params) || {};
      let doc = null;
      try { doc = JSON.parse(String(stdout)); } catch { doc = null; }
      if (!doc || !Array.isArray(doc.transcription)) {
        // A model that would not load is the likely cause and it says so on stderr,
        // which is a far more useful thing to report than "nothing decoded".
        const why = /error: (.+)|failed to (.+)/i.exec(String(stderr));
        return { records: [], note: why ? why[0].trim()
          : 'no transcription came back — whisper writes JSON to stdout with `-ojf -of -`, ' +
            'so this usually means the model did not load' };
      }
      const floor = Number(params.confidence ?? 0.6);
      const out = [];
      for (const seg of doc.transcription) {
        const text = String(seg.text || '').trim();
        if (!text) continue;
        // Mean probability over the real tokens. The specials — `[_BEG_]` and the
        // timestamp tokens — are whisper's own punctuation and carry a probability
        // that says nothing about whether the words are right.
        const toks = (seg.tokens || []).filter((t) => t && typeof t.p === 'number' &&
                                                      !/^\[_.*_\]$/.test(String(t.text || '')));
        const p = toks.length ? toks.reduce((a, t) => a + t.p, 0) / toks.length : null;
        const at = seg.offsets && typeof seg.offsets.from === 'number' ? seg.offsets.from / 1000 : null;
        const rec = { text };
        if (at != null) rec.fromS = +at.toFixed(2);
        if (p != null) rec.confidence = +p.toFixed(3);
        // Said rather than dropped, which is the same rule the CRCs get: a decoder that
        // reports a guess as a decode is the thing ADR-0031 exists to prevent, and one
        // that silently withholds what it found is no better.
        if (p != null && p < floor) rec.suspect = `mean token probability ${p.toFixed(2)}, under ${floor}`;
        out.push(rec);
      }
      if (out.length) return out;
      return { records: [], note: 'no speech in this span — ' +
        (params.quiet === 'default'
          ? 'its own gates are at their defaults here, which are set for audio known to contain speech'
          : 'the no-speech and log-probability gates are raised, which is what keeps a quiet channel from being transcribed') };
    },
    title: ['text'],
  },
  'ext.redsea': {
    name: 'redsea', group: 'Decode', in: 'real', out: 'events',
    command: ['redsea'],
    blurb: 'RDS — station name, radiotext, program type',
    // 171 kHz is not a preference, it is redsea's own internal rate: it resamples
    // whatever it is given to exactly this before demodulating, so handing it 171 kHz
    // means one resample here instead of two. Below 128 kHz it refuses outright, and it
    // is right to — 57 kHz plus its sidebands is above Nyquist by then and the
    // subcarrier being decoded is not in the samples at all.
    wants: { format: 's16', rate: 171_000 },
    // And the floor under the stream it is given, which is a different claim from the
    // rate it wants. Every other adapter can be handed a channel narrower than it likes
    // and will decode worse; this one cannot decode at all, because what it reads sits
    // at 57 kHz and a 40 kHz channel does not contain 57 kHz — no amount of resampling
    // on the way in puts it back. Saying so is what keeps `Identify` from demodulating
    // a wide span speculatively on every capture to look for something that provably is
    // not in it (ADR-0031).
    minRate: 128_000,
    params: [
      // RDS and RBDS number their program types differently, so the same five bits are
      // "Serious classical" in Europe and "Nostalgia" in North America. Nothing in the
      // signal says which, which is exactly the kind of thing that belongs on a knob
      // rather than in a guess — and the PI-to-callsign translation rides on it.
      { id: 'region', type: 'enum', default: 'rds', values: ['rds', 'rbds'],
        label: 'region',
        hint: 'rbds is North America: different program-type names, and the PI code ' +
              'translates to a callsign' },
      // A station name arrives two characters at a time and a receiver holds it back
      // until it is sure. That is the right default and the wrong one for a short span,
      // where everything is partial and the alternative to a partial answer is none.
      { id: 'partial', type: 'enum', default: 'no', values: ['no', 'yes'],
        label: 'show partial',
        hint: 'print a name or radiotext before every segment has arrived — useful on a ' +
              'span too short to have seen them all, and it will show gaps' },
    ],
    // What "try everything" means here. `Identify` gets one pass over a couple of
    // seconds, which is a dozen groups or so — and a dozen groups is not enough for a
    // receiver to commit to a station name, so with the default this adapter would
    // report nothing about a station that is plainly transmitting.
    sweep: { partial: 'yes' },
    // `--bler` is not a knob because there is no reason to turn it off: it puts the
    // block error rate on every group, and on a stream that decoded badly that is the
    // difference between "not RDS" and "RDS, and the signal is poor" — which point at
    // completely different next moves (ADR-0017).
    args: ({ rate, params }) => [
      '--input', 'mpx',
      '--samplerate', String(Math.round(rate)),
      '--output', 'json',
      ...(params.region === 'rbds' ? ['--rbds'] : []),
      ...(params.partial === 'yes' ? ['--show-partial'] : []),
      '--bler',
    ],
    // redsea prints one line per group, and a station sends ten groups a second — so a
    // minute of a healthy signal is six hundred lines of which four are news. Almost all
    // of them repeat the name and the program type that the line before already carried.
    //
    // So a group becomes a record when it *said* something: a name, radiotext or a
    // clock — or when it is the first sighting of a PI code, which is the station
    // announcing itself and is always worth one row. A callsign is not in that list
    // because it is not separately announced: it is the PI code read under the North
    // American rules, so it rides on the station's own row rather than making one.
    //
    // A repeat is dropped, and "repeat" is per field rather than per line. A station
    // whose name and whose radiotext are the same string — which is most of them, for
    // the first few seconds — says two different things that happen to read alike, and a
    // filter comparing only the text swallowed the second. Comparing the last value of
    // each field also keeps a radiotext that changes for the next song and changes back,
    // which a set of everything seen would not.
    parse: (stdout) => {
      const out = [];
      const lastSaid = new Map();            // "<pi>|<field>" → the last value it carried
      // Partial fields arrive space-padded to their full width — eight characters for a
      // name, sixty-four for radiotext — so an empty one is eight spaces rather than
      // absent, and reading it as "it said something" fills the pane with blank rows.
      const said = (v) => (v == null || !String(v).trim() ? null : String(v).replace(/\s+$/, ''));
      for (const line of String(stdout).split('\n')) {
        if (!line.trim()) continue;
        let g;
        try { g = JSON.parse(line); } catch { continue; }
        let kind = null, news = null;
        for (const field of ['ps', 'radiotext', 'partial_ps', 'partial_radiotext', 'clock_time']) {
          const v = said(g[field]);
          if (v != null) { kind = field; news = v; break; }
        }
        const firstOfStation = g.pi && !out.some((r) => r.pi === g.pi);
        if (news == null && !firstOfStation) continue;
        const text = news != null ? news : `${g.pi}${g.callsign ? ` (${g.callsign})` : ''}`;
        const key = `${g.pi}|${kind || 'pi'}`;
        if (lastSaid.get(key) === text) continue;
        lastSaid.set(key, text);
        out.push({
          text,
          ...(g.pi ? { pi: g.pi } : {}),
          ...(g.group ? { group: g.group } : {}),
          ...(said(g.ps) ? { ps: said(g.ps) } : {}),
          ...(said(g.partial_ps) ? { partialPs: said(g.partial_ps) } : {}),
          ...(said(g.radiotext) ? { radiotext: said(g.radiotext) } : {}),
          ...(said(g.partial_radiotext) ? { partialRadiotext: said(g.partial_radiotext) } : {}),
          ...(g.callsign ? { callsign: g.callsign } : {}),
          ...(g.prog_type ? { progType: g.prog_type } : {}),
          ...(g.clock_time ? { clockTime: g.clock_time } : {}),
          // On a stream that decoded badly this is the difference between "not RDS" and
          // "RDS, and the signal is poor" — which point at completely different fixes.
          ...(g.bler != null ? { blerPct: g.bler } : {}),
        });
      }
      return out;
    },
    title: ['text'],
  },

  // ── and one that is not a program at all ──────────────────────────────────
  //
  // A GNU Radio flowgraph satisfies the same contract every other row does: samples in
  // on stdin, records out on stdout. So it needs no new machinery here — only a way to
  // say that what must be installed is a *module inside an interpreter* rather than a
  // name on PATH, which `module` does. The flowgraph itself ships in `flowgraphs/` and
  // is ours, written by hand rather than exported from GNU Radio Companion: a .grc
  // export carries a GUI, a throttle and a sample-rate variable that only make sense
  // live, and none of that belongs in a job that reads a span and exits (ADR-0032).
  'ext.lora': {
    name: 'LoRa', group: 'Decode', in: 'iq', out: 'events',
    // The interpreter that has the bindings, which is not necessarily the one called
    // `python3`: GNU Radio's are built against one CPython and a box can have five.
    command: ['python3.12', 'python3.11', 'python3.10', 'python3'],
    module: 'gnuradio.lora_sdr',
    flowgraph: 'lora.py',
    blurb: 'LoRa — chirp spread spectrum, SF7 to SF12',
    // The one adapter whose rate is not a constant: LoRa is sampled at a whole multiple
    // of its bandwidth, so the bandwidth parameter decides what the decoder is fed.
    wants: ({ params }) => ({ format: 'cf32', rate: (Number(params.bw) || 125_000) * 2 }),
    params: [
      { id: 'sf', type: 'text', default: '7', label: 'spreading factor',
        placeholder: '7 \u2026 12',
        hint: 'higher spreads further and sends slower; the first thing to sweep' },
      { id: 'bw', type: 'text', default: '125000', label: 'bandwidth',
        placeholder: '125000, 250000, 500000',
        hint: 'also sets the rate the decoder is fed, at twice this' },
      { id: 'cr', type: 'text', default: '1', label: 'coding rate',
        placeholder: '1 \u2026 4', hint: 'the n in 4/(4+n)' },
      { id: 'sync', type: 'text', default: '0x12', label: 'sync word',
        placeholder: '0x12 private, 0x34 public' },
    ],
    args: ({ rate, params }) => [
      '--rate', String(Math.round(rate)),
      '--sf', String(params.sf || 7),
      '--bw', String(params.bw || 125_000),
      '--cr', String(params.cr || 1),
      '--sync', String(params.sync || '0x12'),
    ],
    parse: 'jsonl',
    title: ['text'],
  },
};

/**
 * Decoders the operator added, from `SDRFLEX_ADAPTERS` (ADR-0026).
 *
 * Held beside the shipped table rather than merged into it, for two reasons that are the
 * same reason: a local adapter must never quietly replace a shipped one, and every place
 * that reports an adapter has to be able to say which it is. `register` refuses an id
 * that already exists, and `local` travels on the spec.
 */
const LOCAL = new Map();

export function register(id, spec) {
  if (ADAPTERS[id]) throw new Error(`${id} is already a decoder that ships with the tool`);
  LOCAL.set(id, spec);
  return id;
}

export function forget(id) { LOCAL.delete(id); PROBED.clear(); }

/** Every adapter, shipped and local. The shipped ones first, so the menu is stable. */
export function all() {
  return { ...ADAPTERS, ...Object.fromEntries(LOCAL) };
}

/** One, by id. */
export function spec(id) { return ADAPTERS[id] || LOCAL.get(id) || null; }

/**
 * What this adapter wants on stdin, for the settings it is about to run with.
 *
 * Static for almost all of them — rtl_433 takes cu8 at 250 kS/s and that is that. LoRa
 * is the exception that made this a function: its sample rate is a whole multiple of its
 * bandwidth, so choosing 250 kHz bandwidth changes what the decoder needs fed to it.
 * Pinning `wants` to the default would have quietly starved every setting but one.
 */
export function wants(a, params = {}) {
  return typeof a.wants === 'function' ? a.wants({ params }) : a.wants;
}

/** The settings an adapter starts with, which is what `wants` is reported against. */
function defaults(a) {
  const out = {};
  for (const pm of a.params || []) out[pm.id] = pm.default;
  return out;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Flowgraphs that ship with the tool, run by whichever interpreter has the module. */
const FLOWGRAPHS = path.join(HERE, 'flowgraphs');

/**
 * Which of this adapter's candidate binaries is actually on the box, if any.
 *
 * `command` is a list because the same program ships under different names — dump1090
 * is `dump1090-mutability` on Debian and `dump1090-fa` from FlightAware, and an adapter
 * that knew only the upstream name reported "not installed" on machines that had it.
 * First name found wins, so the list is in preference order.
 */
export function resolve(id) {
  const a = spec(id);
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

/**
 * Is the program this adapter needs on the box?
 *
 * For an ordinary adapter that is a name on PATH. For a flowgraph it is not: the command
 * is an interpreter, which is always there, and what actually has to exist is a module
 * inside it. An adapter that answered "yes, python3 is installed" would offer a decoder
 * that cannot run — the same failure as naming `dump1090` on a box that has
 * `dump1090-mutability`, arrived at from the other direction.
 *
 * So a flowgraph adapter is probed: the interpreter is asked to import the module, and
 * that is the answer. It costs about half a second and is cached for the life of the
 * process, because the alternative is half a second per adapter on every connect.
 * `warm()` pays it at startup instead of on somebody's first click.
 */
const PROBED = new Map();

export function available(id) {
  const a = spec(id);
  if (!a) return false;
  const command = resolve(id);
  if (!command) return false;
  if (!a.module) return true;

  const key = `${command}|${a.module}`;
  if (!PROBED.has(key)) {
    // Synchronous on purpose: this answers a question the palette asks synchronously,
    // it happens once, and an async cache that can be read before it is filled reports
    // "not installed" for a decoder that is.
    let ok = false;
    try {
      const r = spawnSync(command, ['-c', `import ${a.module}`], { timeout: 20_000, stdio: 'ignore' });
      ok = r.status === 0;
    } catch { ok = false; }
    PROBED.set(key, ok);
  }
  return PROBED.get(key);
}

/** Probe every adapter now, so the first connection does not pay for it. */
export function warm() {
  const ids = Object.keys(all());
  for (const id of ids) available(id);
  return ids.filter(available).length;
}

/** What to call it when it is missing, which is the whole list rather than a guess. */
function commandNames(a) {
  // For a flowgraph the interpreter is never the missing piece, so naming it would send
  // somebody to install Python. The module is what they actually have to build.
  if (a.module) return `${a.module} (a GNU Radio module)`;
  return (Array.isArray(a.command) ? a.command : [a.command]).join(' / ');
}

/**
 * What this build of multimon-ng can actually demodulate.
 *
 * Asked, not assumed. It prints `Available demodulators: …` in its banner on any
 * invocation, and the list has grown over the years — FLEX_NEXT, AFSK2400_2 and
 * AFSK2400_3 are not in older builds, and a menu offering something the installed binary
 * rejects is the same failure this control was rewritten to remove.
 *
 * Probed once and cached beside the other probes. `DUMPCSV` and `SCOPE` come out: they
 * are debugging sinks rather than demodulators, and neither produces a record.
 */
const NOT_DEMODS = new Set(['DUMPCSV', 'SCOPE']);
let MULTIMON_DEMODS = null;

/**
 * What a speculative pass asks multimon-ng for. See the note on `ext.multimon`'s
 * `sweep`: this is deliberately shorter than what the binary has.
 */
const SWEEP_DEMODS = ['POCSAG512', 'POCSAG1200', 'POCSAG2400', 'FLEX', 'AFSK1200',
                      'AFSK2400', 'FSK9600', 'DTMF', 'MORSE_CW', 'EAS', 'X10'];

export function multimonDemods() {
  if (MULTIMON_DEMODS) return MULTIMON_DEMODS;
  const fallback = ['POCSAG512', 'POCSAG1200', 'POCSAG2400', 'FLEX', 'EAS', 'UFSK1200',
                    'CLIPFSK', 'AFSK1200', 'AFSK2400', 'HAPN4800', 'FSK9600', 'DTMF',
                    'ZVEI1', 'ZVEI2', 'ZVEI3', 'DZVEI', 'PZVEI', 'EEA', 'EIA', 'CCIR',
                    'MORSE_CW', 'X10'];
  const command = resolve('ext.multimon');
  if (!command) return fallback;
  try {
    const r = spawnSync(command, ['-h'], { timeout: 10_000, encoding: 'utf8' });
    const line = /Available demodulators:([^\n]*)/.exec(`${r.stdout || ''}${r.stderr || ''}`);
    const found = line ? line[1].trim().split(/\s+/).filter((d) => d && !NOT_DEMODS.has(d)) : [];
    MULTIMON_DEMODS = found.length ? found : fallback;
  } catch {
    MULTIMON_DEMODS = fallback;
  }
  return MULTIMON_DEMODS;
}

/** Every adapter, with whether it could actually run here. */
export function list() {
  return Object.entries(all()).map(([id, a]) => {
    const found = resolve(id);
    return {
      id, name: a.name, group: a.group, in: a.in, out: a.out,
      // The name it will actually run under, when there is one — a box with
      // dump1090-mutability should say so rather than claim a binary it does not have.
      command: a.module ? commandNames(a) : (found || commandNames(a)),
      // A parameter whose choices depend on what is installed asks for them here, the
      // same way `wants` is asked rather than read — the client has no way to run a
      // program and must never need one (ADR-0029).
      blurb: a.blurb, params: (a.params || []).map(
        (pm) => (typeof pm.values === 'function' ? { ...pm, values: pm.values() } : pm)),
      sweep: (typeof a.sweep === 'function' ? a.sweep() : a.sweep) || null,
      wants: wants(a, defaults(a)),
      // The narrowest stream this decoder could possibly read, when it has an opinion.
      ...(a.minRate ? { minRate: a.minRate } : {}),
      // And the stages that have to sit between a demodulated stream and it, for the one
      // kind of decoder that does not read samples (ADR-0040). Data, like everything else
      // here: the client builds the chain and must not have to know which decoders are
      // special.
      ...(a.after ? { after: a.after } : {}),
      available: available(id),
      // Yours or ours. The UI says so, because a decoder you added behaving oddly and
      // one that shipped behaving oddly are different problems.
      ...(a.local ? { local: a.local.pack } : {}),
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
  } else if (want.format === 'cf32' || want.format === 'f32') {
    // The same bytes either way — the name says whether the floats are pairs. A decoder
    // that reads one float per symbol is not reading IQ and should not have to say it is.
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
  const bits = format === 'cf32' || format === 'f32' ? 32 : format === 's16' || format === 'cs16' ? 16 : 8;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataLen, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(format === 'cf32' || format === 'f32' ? 3 : 1, 20);  // 3 is IEEE float, 1 is PCM
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

/**
 * Is this a line of text, or a line of bytes?
 *
 * Printable ASCII, tab and the replacement character standing in for whatever could not
 * be decoded as UTF-8. Four in five has to be readable; below that it is a byte dump
 * wearing a string, and a text-mode decoder reporting it as a message is a false
 * positive dressed as an answer.
 */
function printableEnough(line) {
  if (!line.length) return false;
  let ok = 0;
  for (const ch of line) {
    const c = ch.codePointAt(0);
    if (c === 9 || (c >= 32 && c < 127)) ok++;
  }
  return ok / [...line].length >= 0.8;
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
function readRecords(spec, stdout, stderr, meta = {}) {
  const r = typeof spec.parse === 'function' ? spec.parse(stdout, stderr, spec, meta)
    : spec.parse === 'jsonl' ? parseJsonl(stdout, spec)
    : parseLines(stdout);
  // A parser may hand back a note as well as records, for the case where it *rejected*
  // something the program said. Rejecting quietly would turn an informative failure back
  // into an uninformative one.
  return Array.isArray(r) ? { records: r, note: null } : r;
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
  const a = spec(id);
  if (!a) return Promise.resolve({ records: [], error: `no adapter ${id}` });
  const command = resolve(id);
  if (!command) {
    return Promise.resolve({ records: [], error: `${commandNames(a)} is not installed on this machine` });
  }

  const need = wants(a, params);
  let input;
  try {
    input = convert(data, kind, sampleRate, need);
  } catch (e) {
    return Promise.resolve({ records: [], error: e.message });
  }

  // Some of these are configured by file rather than by flag — direwolf will not start
  // without one on a machine with no sound card, which is every machine this runs on.
  // The directory is per-run and goes away with the run, so a decode leaves nothing
  // behind and two decodes cannot read each other's config.
  let dir = null;
  try {
    if (a.files) {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdrflex-'));
      for (const file of a.files({ rate: need.rate, centerHz, params })) {
        fs.writeFileSync(path.join(dir, file.name), file.text);
      }
    }
  } catch (e) {
    return Promise.resolve({ records: [], error: `could not set up ${command}: ${e.message}` });
  }

  const args = [
    ...(a.flowgraphPath ? [a.flowgraphPath]
        : a.flowgraph ? [path.join(FLOWGRAPHS, a.flowgraph)] : []),
    ...a.args({ rate: need.rate, centerHz, params, dir }),
  ];
  const started = Date.now();

  return new Promise((done_) => {
    const proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', outBytes = 0, done = false;

    const finish = async (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* it is a temp dir */ } }
      // `inputNote` is what the conversion said it did, so a parser can tell "nothing was
      // there" from "something in front of this changed what it was looking at" — the
      // difference between a signal that is absent and one that was resampled away.
      const { records, note: parseNote } =
        // `params` as well, because a parser can have a judgment of its own to apply and
        // the setting for it belongs to the node rather than to the program's flags —
        // whisper's confidence floor decides which segments are called guesses, and that
        // is a decision about the report rather than about the decode.
        readRecords(a, stdout, stderr, { outBytes, inputNote: input.note, params });

      // Nothing recognized is a result, not a failure — but a result with no account of
      // itself is a dead end, and "I ran a decoder and it said nothing" is the least
      // useful thing this tool could tell anybody.
      let told = null;
      if (!records.length && !error && a.explain) {
        told = await explain(a, command, input.bytes, { rate: need.rate, centerHz, params });
      }

      done_({
        records, ms: Date.now() - started,
        // Named by what ran, which for a flowgraph is the module rather than the
        // interpreter: "python3.12 · cf32 at 250 kS/s" tells nobody anything.
        note: `${a.module || command} · ${input.note}${parseNote ? ` · ${parseNote}` : ''}`,
        // Also on its own, because a parser note is the only part of that string that
        // is about the *signal* rather than about the plumbing, and a report with room
        // for one line wants that line.
        ...(parseNote ? { rejected: parseNote } : {}),
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

    // Most of these put their records on stdout. `m17-demod` puts *audio* there and its
    // records on stderr — and a few seconds of 8 kHz audio coerced into a JavaScript
    // string is both wrong and a way to run a server out of memory on a long capture. So
    // an adapter can say where its records are, and the other stream is counted, not kept.
    proc.stdout.on('data', (b) => { if (a.recordsOn === 'stderr') outBytes += b.length; else stdout += b; });
    proc.stderr.on('data', (b) => { stderr += b; });
    proc.on('error', (e) => finish(e.code === 'ENOENT'
      ? `${command} is not installed on this machine` : e.message));
    proc.on('close', (code) => finish(code && code !== 0 && !stdout && !outBytes
      ? `${command} exited ${code}: ${firstLine(stderr)}` : undefined));

    // A decoder that stops reading — dump1090 quits once it has what it wants — closes
    // the pipe under us, and that is a normal end rather than a fault.
    proc.stdin.on('error', () => {});
    proc.stdin.end(input.bytes);
  });
}

/**
 * Ask a decoder what it saw, when it recognized nothing.
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
  // minimodem frames everything it says in hashes — the carrier report is a banner and
  // a measurement, and reporting "### NOCARRIER ndata=8 ###" as the error when a decode
  // found nothing says less than saying nothing would.
  /^###/,
  // rtl_433 announces its own release notes on stderr. Reporting that as the reason a
  // decode found nothing is worse than reporting nothing.
  /^New defaults active/i, /^Use "-Y classic/i, /^:\s*$/,
];

function complaint(stderr) {
  const lines = String(stderr).split('\n').map((x) => x.replace(/\x1b\[[0-9;]*m/g, '').trim())
    .filter((x) => x && !CHATTER.some((re) => re.test(x)));
  return lines.length ? lines[lines.length - 1] : undefined;
}
