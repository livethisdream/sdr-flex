// Radios, in our own terms.
//
// The roadmap is explicit that the source interface must be defined here rather than
// being SoapySDR's interface with our names on it, because a layer you did not choose
// erodes into the layer you cannot leave. So a driver is described by four things: what
// program to run, how to tell it a frequency and a rate, what samples come out, and
// what it is called. Nothing in the rest of the tool knows more than that.
//
// Every one of these programs does the same thing — write raw interleaved IQ to stdout
// — which is not a coincidence. It is the lowest common denominator of every SDR
// toolchain, it needs no bindings, no native module and no `npm install`, and it means
// adding a radio is a row in a table rather than a port. It costs a process and a pipe,
// which at these rates is nothing: 2.4 MS/s of cu8 is 4.8 MB/s down a pipe on the same
// machine.
//
// When one of these turns out not to be enough — Pluto over the network rather than a
// process, or a rate this cannot sustain — the answer is another `kind` here, not a
// different architecture.

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Ring } from './ring.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * `args` builds the command line from a tuning. `format` is what lands on stdout.
 * `probe` is a command that lists what is plugged in, if there is one.
 */
export const DRIVERS = {
  rtl: {
    name: 'RTL-SDR',
    command: 'rtl_sdr',
    format: 'cu8',
    defaults: { sampleRate: 2_048_000, centerHz: 433_920_000, gain: null },
    minRate: 225_001, maxRate: 3_200_000,
    args: ({ centerHz, sampleRate, gain, device }) => [
      '-f', String(Math.round(centerHz)),
      '-s', String(Math.round(sampleRate)),
      ...(device ? ['-d', String(device)] : []),
      // rtl_sdr's -g is tenths of a dB, and omitting it entirely means AGC, which is
      // the right default for someone who has not said otherwise
      ...(gain != null ? ['-g', String(gain)] : []),
      '-',
    ],
    probe: { command: 'rtl_test', args: ['-t'] },
  },

  // The Pluto's samples come out of libiio. `iio_readdev` is the part of libiio that
  // already speaks to it over USB or the network, so this is a pipe rather than a
  // reimplementation of iiod in JavaScript. `-u ip:192.168.2.1` is the address the
  // board's USB-ethernet gadget answers on out of the box.
  pluto: {
    name: 'ADALM-PLUTO',
    command: 'iio_readdev',
    format: 'cs16',
    defaults: { sampleRate: 2_000_000, centerHz: 433_920_000, gain: null,
                uri: 'ip:192.168.2.1' },
    minRate: 520_833, maxRate: 61_440_000,
    args: ({ uri }) => [
      '-u', uri || 'ip:192.168.2.1',
      '-b', '32768',
      'cf-ad9361-lpc', 'voltage0', 'voltage1',
    ],
    // Frequency and rate are attributes on the device, not command-line flags, so they
    // are set before the reader starts rather than passed to it.
    tune: ({ uri, centerHz, sampleRate, gain }) => [
      { command: 'iio_attr', args: ['-u', uri || 'ip:192.168.2.1', '-c', 'ad9361-phy', 'altvoltage0', 'frequency', String(Math.round(centerHz))] },
      { command: 'iio_attr', args: ['-u', uri || 'ip:192.168.2.1', '-c', 'ad9361-phy', 'voltage0', 'sampling_frequency', String(Math.round(sampleRate))] },
      { command: 'iio_attr', args: ['-u', uri || 'ip:192.168.2.1', '-c', 'ad9361-phy', 'voltage0',
                                    'gain_control_mode', gain != null ? 'manual' : 'slow_attack'] },
      ...(gain != null ? [{ command: 'iio_attr', args: ['-u', uri || 'ip:192.168.2.1', '-c', 'ad9361-phy', 'voltage0', 'hardwaregain', String(gain)] }] : []),
    ],
    probe: { command: 'iio_info', args: ['-u', 'ip:192.168.2.1'] },
  },

  uhd: {
    name: 'USRP (UHD)',
    command: 'uhd_rx_cfile',
    format: 'cf32',
    defaults: { sampleRate: 2_000_000, centerHz: 433_920_000, gain: 30 },
    minRate: 200_000, maxRate: 60_000_000,
    args: ({ centerHz, sampleRate, gain, device }) => [
      '--freq', String(Math.round(centerHz)),
      '--rate', String(Math.round(sampleRate)),
      ...(gain != null ? ['--gain', String(gain)] : []),
      ...(device ? ['--args', device] : []),
      '/dev/stdout',
    ],
    probe: { command: 'uhd_find_devices', args: [] },
  },

  // Anything SoapySDR knows about, for the radios that do not have a row of their own.
  soapy: {
    name: 'SoapySDR',
    command: 'rx_sdr',
    format: 'cs16',
    defaults: { sampleRate: 2_048_000, centerHz: 433_920_000, gain: null },
    minRate: 100_000, maxRate: 60_000_000,
    args: ({ centerHz, sampleRate, gain, device }) => [
      '-f', String(Math.round(centerHz)),
      '-s', String(Math.round(sampleRate)),
      '-F', 'CS16',
      ...(device ? ['-d', device] : []),
      ...(gain != null ? ['-g', String(gain)] : []),
      '-',
    ],
    probe: { command: 'SoapySDRUtil', args: ['--find'] },
  },

  // Not a radio. A signal generator that emits the same synthetic scene the in-tab
  // engine has always drawn, at a real rate in real time, so the whole live path —
  // ring, wraparound, scrubbing back into history, a chain built on a moving source —
  // can be exercised and demonstrated on a machine with nothing plugged into it.
  synthetic: {
    name: 'Synthetic signal',
    command: process.execPath,
    format: 'cf32',
    defaults: { sampleRate: 480_000, centerHz: 433_920_000, gain: null },
    minRate: 8_000, maxRate: 4_000_000,
    args: ({ sampleRate }) => [path.join(HERE, 'synthsource.js'), String(Math.round(sampleRate))],
    alwaysAvailable: true,
  },
};

/** Is the program this driver needs actually on the box? */
export function available(kind) {
  const d = DRIVERS[kind];
  if (!d) return false;
  if (d.alwaysAvailable) return true;
  // An absolute command (the synthetic driver runs this very Node) is checked directly.
  if (path.isAbsolute(d.command)) return executable(d.command);
  return (process.env.PATH || '').split(path.delimiter).some((dir) => executable(path.join(dir, d.command)));
}

function executable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

/** Every driver, with whether it could actually run here. */
export function list() {
  return Object.entries(DRIVERS).map(([kind, d]) => ({
    kind,
    name: d.name,
    command: d.command,
    format: d.format,
    available: available(kind),
    defaults: d.defaults,
    minRate: d.minRate,
    maxRate: d.maxRate,
  }));
}

/**
 * A running radio: a process, a ring it fills, and the tuning it was started with.
 *
 * Retuning restarts the process. Every one of these programs takes its frequency on
 * the command line and none of them can be retuned in flight, which is a real cost —
 * about a second of dead air on an RTL — and the honest way to present it is a source
 * that says it is restarting rather than a UI that pretends the knob is continuous.
 */
export class Radio extends EventEmitter {
  constructor({ kind, ringSeconds = 60, ringDir = os.tmpdir(), log = () => {} }) {
    super();
    this.driver = DRIVERS[kind];
    if (!this.driver) throw new Error(`no driver ${kind}`);
    this.kind = kind;
    this.ringSeconds = ringSeconds;
    this.ringDir = ringDir;
    this.log = log;
    this.proc = null;
    this.ring = null;
    this.tuning = null;
    this.status = 'stopped';
    this.lastError = null;
  }

  get label() { return `${this.driver.name} @ ${(this.tuning.centerHz / 1e6).toFixed(4)} MHz`; }
  get format() { return this.driver.format; }
  get sampleRate() { return this.tuning.sampleRate; }
  get centerHz() { return this.tuning.centerHz; }
  get durationS() { return this.ring ? this.ring.durationS : 0; }
  get samples() { return this.ring ? this.ring.head : 0; }

  get live() { return true; }
  windowS() { return this.ring ? this.ring.windowS() : [0, 0]; }

  /**
   * What the radio still has, nearest to what was asked for.
   *
   * The ring throws when a moment has been overwritten, which is right for it — the
   * samples are gone and pretending otherwise draws a confident picture of a signal
   * that was never like that. But a display can lose that race honestly: between the
   * client deciding which moment to draw and this read happening, a few milliseconds
   * of history can expire. Clamping to the oldest surviving sample shows a moment
   * slightly newer than the one asked for, which is the truthful answer to "show me as
   * far back as you can", and the clock is clamped to the same window anyway.
   */
  read(start, count) {
    if (!this.ring) return new Float32Array(count * 2);
    const [first] = this.ring.window();
    return this.ring.read(Math.max(start, first), count);
  }

  async start(tuning = {}) {
    const d = this.driver;
    const t = { ...d.defaults, ...tuning };
    if (t.sampleRate < d.minRate || t.sampleRate > d.maxRate) {
      throw new Error(`${d.name} does not do ${(t.sampleRate / 1e6).toFixed(3)} MS/s ` +
                      `(it does ${(d.minRate / 1e6).toFixed(3)}–${(d.maxRate / 1e6).toFixed(1)})`);
    }
    this.stop();
    this.tuning = t;

    // Devices that are configured before they are read from, rather than by flags.
    for (const step of (d.tune ? d.tune(t) : [])) {
      await run(step.command, step.args, 5000).catch((e) => {
        throw new Error(`could not set up the ${d.name}: ${e.message}`);
      });
    }

    this.ring = new Ring({
      path: path.join(this.ringDir, `sdrflex-ring-${process.pid}-${Date.now()}.iq`),
      format: d.format, sampleRate: t.sampleRate, centerHz: t.centerHz,
      seconds: this.ringSeconds, label: this.label,
    });

    const args = d.args(t);
    this.log(`${d.command} ${args.join(' ')}`);
    const proc = spawn(d.command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    this.status = 'starting';

    proc.stdout.on('data', (b) => {
      // Bytes already in the pipe keep arriving after the ring has been closed, so the
      // teardown order is not something this handler can assume.
      if (!this.ring || this.proc !== proc) return;
      if (this.status !== 'running') { this.status = 'running'; this.emit('status', this.status); }
      this.ring.write(b);
    });
    // These programs say useful things on stderr — overruns, gain settings, what device
    // they found — and the first line of it is usually the reason a radio did not start.
    proc.stderr.on('data', (b) => {
      const s = b.toString().trim();
      if (s) { this.lastError = s.split('\n').pop(); this.log(`${d.command}: ${s}`); }
    });
    proc.on('error', (e) => {
      this.status = 'failed';
      this.lastError = e.code === 'ENOENT'
        ? `${d.command} is not installed on this machine`
        : e.message;
      this.emit('status', this.status);
    });
    proc.on('exit', (code, signal) => {
      if (this.status === 'stopped') return;          // we asked it to
      this.status = 'failed';
      this.lastError = this.lastError || `${d.command} exited (${signal || code})`;
      this.emit('status', this.status);
    });

    // Give it long enough to either produce a sample or fail to start. Reporting "it
    // is running" before anything has come out is how you end up staring at an empty
    // waterfall wondering whether the antenna is connected.
    await new Promise((resolve) => {
      const done = () => { clearInterval(iv); clearTimeout(to); resolve(); };
      const iv = setInterval(() => { if (this.status !== 'starting') done(); }, 20);
      const to = setTimeout(done, 3000);
    });
    if (this.status === 'failed') {
      const why = this.lastError;
      this.stop();
      throw new Error(why);
    }
    if (this.status === 'starting') {
      // it did not crash but has produced nothing; let it keep trying and say so
      this.log(`${d.name} has not produced samples yet`);
    }
    return this;
  }

  stop() {
    const proc = this.proc;
    this.status = 'stopped';
    this.proc = null;
    if (proc) {
      proc.stdout.removeAllListeners('data');
      proc.stderr.removeAllListeners('data');
      try { proc.kill('SIGTERM'); } catch { /* already gone */ }
    }
    if (this.ring) { this.ring.close(); this.ring = null; }
  }

  /** Retune by restarting. History does not survive it — a new center is a new medium. */
  async retune(changes) {
    return this.start({ ...this.tuning, ...changes });
  }
}

function run(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (b) => { err += b.toString(); });
    p.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? `${command} is not installed` : e.message)));
    p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `${command} exited ${code}`)));
    setTimeout(() => { p.kill(); reject(new Error(`${command} timed out`)); }, timeoutMs);
  });
}
