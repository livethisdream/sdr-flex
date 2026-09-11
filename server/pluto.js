// A Pluto, as a source.
//
// Everything specific to the ADALM-PLUTO lives here: which device tunes, which device
// streams, what the attributes are called. `iiod.js` below it knows only the protocol,
// and would serve any IIO device — which is the point, because the next AD936x board
// is the same three attribute names and a different product sticker.
//
// Nothing here needs libiio installed. The board is on the other end of a TCP socket
// and the only dependency is that something brought its network interface up.

import { Iiod, parseContext, parseFormat } from './iiod.js';

/** The AD936x attribute names, which are the same across every board that uses one. */
const PHY = 'ad9361-phy';
const RX = 'cf-ad9361-lpc';

export class PlutoSource {
  constructor({ host = '192.168.2.1', port, log = () => {} } = {}) {
    this.host = host;
    this.port = port;
    this.log = log;
    // Two connections, not one.
    //
    // A READBUF blocks on the server until the buffer fills, so a control command sent
    // down the same socket meanwhile has its reply eaten by the read that was already
    // waiting — the symptom is a retune that reports an unintelligible answer and a
    // session that never recovers. iiod is happy to hold several connections, so the
    // stream gets one and everything else gets the other, and retuning while streaming
    // becomes possible rather than merely not crashing.
    this.ctrl = null;
    this.stream = null;
    this.running = false;
    this.format = 'cs12';
    this.dropped = 0;
  }

  /**
   * Connect, tune, and start handing over buffers.
   *
   * Tuning is attribute writes rather than a restart, which is the thing this buys
   * over shelling out: the process-based driver had to kill and respawn `iio_readdev`
   * for every new frequency, and that is a second of dead air and an emptied ring.
   * Here the LO moves and the stream keeps running.
   */
  async start({ centerHz, sampleRate, gain = null, bandwidthHz = null, bufferSamples = 32768 }, onData) {
    const c = new Iiod({ host: this.host, port: this.port });
    await c.connect();
    this.ctrl = c;

    const ctx = parseContext(await c.print());
    const phy = ctx.devices.find((d) => d.name === PHY);
    const rx = ctx.devices.find((d) => d.name === RX);
    if (!phy || !rx) {
      c.disconnect();
      throw new Error(`that is not a Pluto — it has ${ctx.devices.map((d) => d.name).join(', ') || 'no devices'}`);
    }

    const scan = rx.channels.filter((ch) => ch.scan).sort((a, b) => a.scan.index - b.scan.index);
    if (scan.length < 2) { c.disconnect(); throw new Error('the receive device has no I and Q to stream'); }
    const fmt = parseFormat(scan[0].scan.format);
    // 12-in-16 and 16-in-16 are both int16 on the wire; only the full-scale differs.
    this.format = fmt.storage === 16 && fmt.bits <= 12 ? 'cs12' : 'cs16';
    this.log(`${scan.length} scan elements, format ${scan[0].scan.format} → ${this.format}`);

    await c.setTimeout_(5000);
    await this.tune({ centerHz, sampleRate, gain, bandwidthHz });

    // one bit per enabled scan element
    const mask = (((1 << scan.length) - 1) >>> 0).toString(16).padStart(8, '0');
    const bytes = bufferSamples * scan.length * (fmt.storage / 8);

    const d = new Iiod({ host: this.host, port: this.port });
    await d.connect();
    this.stream = d;
    await d.setTimeout_(5000);
    await d.open(rx.id, bufferSamples, mask);
    this.rxId = rx.id;
    this.phyId = phy.id;
    this.running = true;

    // The read loop. iiod blocks until the buffer is full, so this paces itself to the
    // sample rate with no timer of its own — which is the correct way to be paced by a
    // radio and the reason there is no clock in here.
    (async () => {
      while (this.running) {
        let b;
        try { b = await d.readBuf(rx.id, bytes); }
        catch (err) {
          if (this.running) { this.log(`stream stopped: ${err.message}`); this.error = err.message; }
          break;
        }
        if (!b.length) break;
        onData(b);
      }
      this.running = false;
    })();

    return { format: this.format, sampleRate, centerHz };
  }

  /** Retune without restarting anything. Three attribute writes, on the control link. */
  async tune({ centerHz, sampleRate, gain = null, bandwidthHz = null }) {
    const c = this.ctrl;
    if (!c) throw new Error('not connected');
    const phyId = this.phyId || 'iio:device1';
    if (sampleRate != null) {
      await c.writeAttr(phyId, 'INPUT', 'voltage0', 'sampling_frequency', Math.round(sampleRate));
      await c.writeAttr(phyId, 'INPUT', 'voltage0', 'rf_bandwidth',
                        Math.round(bandwidthHz || sampleRate)).catch(() => {});
    }
    if (centerHz != null) {
      await c.writeAttr(phyId, 'OUTPUT', 'altvoltage0', 'frequency', Math.round(centerHz));
    }
    // Automatic unless told otherwise: a radio that arrives with the gain at whatever
    // it was last set to is a radio that looks broken half the time.
    await c.writeAttr(phyId, 'INPUT', 'voltage0', 'gain_control_mode',
                      gain == null ? 'slow_attack' : 'manual').catch(() => {});
    if (gain != null) {
      await c.writeAttr(phyId, 'INPUT', 'voltage0', 'hardwaregain', gain).catch(() => {});
    }
  }

  /** What the board says it is doing, as opposed to what it was asked to do. */
  async actual() {
    const c = this.ctrl;
    if (!c) return null;
    const phyId = this.phyId || 'iio:device1';
    const num = async (kind, chn, attr) => {
      try { return parseFloat(await c.readAttr(phyId, kind, chn, attr)); } catch { return null; }
    };
    return {
      centerHz: await num('OUTPUT', 'altvoltage0', 'frequency'),
      sampleRate: await num('INPUT', 'voltage0', 'sampling_frequency'),
      bandwidthHz: await num('INPUT', 'voltage0', 'rf_bandwidth'),
      gain: await num('INPUT', 'voltage0', 'hardwaregain'),
    };
  }

  stop() {
    this.running = false;
    const ctrl = this.ctrl, stream = this.stream;
    this.ctrl = null;
    this.stream = null;
    // The stream link is blocked in a READBUF that will not return until the radio has
    // filled a buffer, so it is dropped rather than asked politely to stop.
    if (stream) stream.disconnect();
    if (ctrl) { try { ctrl.exit(); } catch { /* already gone */ } }
  }
}
