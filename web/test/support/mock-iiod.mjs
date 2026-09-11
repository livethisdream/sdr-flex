// A stand-in for the iiod a Pluto runs.
//
// The point of it is that it is faithful enough for libiio's *own* tools — `iio_info`,
// `iio_attr`, `iio_readdev` — so testing our client against it is not testing our
// client against our own guess at the protocol. `pluto-context.xml` beside it is not
// hand-written either: it is what a real iiod emitted for a Pluto-shaped context.
//
// Every framing detail here was read off the wire between real libiio and real iiod,
// including the one that is easy to get wrong: a value reply ends with a newline after
// its payload and a READBUF reply does not.
//
// The port is fixed at 30431 in the tests because libiio 0.25's `ip:` URI has no
// syntax for a port — `ip:host:port` is treated as a hostname and never resolves.
import net from 'node:net';
import fs from 'node:fs';

export function serve({ port = 0, xmlPath, samples }) {
  const XML = fs.readFileSync(xmlPath, 'utf8');
  const attrs = new Map([
    ['iio:device1/OUTPUT/altvoltage0/frequency', '2400000000'],
    ['iio:device1/INPUT/voltage0/sampling_frequency', '2000000'],
    ['iio:device1/INPUT/voltage0/rf_bandwidth', '2000000'],
    ['iio:device1/INPUT/voltage0/gain_control_mode', 'slow_attack'],
    ['iio:device1/INPUT/voltage0/hardwaregain', '30.000000 dB'],
  ]);
  const log = [];
  const live = new Set();
  let cursor = 0;

  const srv = net.createServer((s) => {
    live.add(s);
    s.on('close', () => live.delete(s));
    let buf = Buffer.alloc(0);
    let pending = null;
    const ok = (n) => s.write(String(n) + '\n');
    // <length>\n<payload>\n — the trailing newline is not decoration; without it the
    // real client's next read starts one byte early and the session desyncs.
    const data = (str) => { s.write(String(str.length) + '\n'); s.write(str); s.write('\n'); };

    s.on('data', (b) => {
      buf = Buffer.concat([buf, b]);
      for (;;) {
        if (pending) {
          if (buf.length < pending.len) return;
          const value = buf.subarray(0, pending.len).toString('latin1').replace(/\0+$/, '');
          buf = buf.subarray(pending.len);
          attrs.set(pending.key, value);
          ok(pending.len);
          pending = null;
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.subarray(0, i).toString('latin1');
        buf = buf.subarray(i + 2);
        log.push(line);
        const p = line.split(' ');

        switch (p[0]) {
          case 'VERSION': s.write('0.25.v0.25  \n'); break;
          case 'PRINT': data(XML); break;
          case 'TIMEOUT': ok(0); break;
          case 'READ': {
            const v = attrs.get(`${p[1]}/${p[2]}/${p[3]}/${p[4]}`);
            if (v == null) ok(-2); else data(v + '\0');
            break;
          }
          case 'WRITE': {
            const len = parseInt(p[5], 10);
            if (!Number.isFinite(len)) { ok(-22); break; }
            pending = { key: `${p[1]}/${p[2]}/${p[3]}/${p[4]}`, len };
            break;
          }
          case 'OPEN': ok(0); break;
          case 'CLOSE': ok(0); break;
          case 'READBUF': {
            const want = parseInt(p[2], 10);
            const out = Buffer.alloc(want);
            for (let k = 0; k < want; k++) out[k] = samples[(cursor + k) % samples.length];
            cursor = (cursor + want) % samples.length;
            s.write(String(want) + '\n');
            s.write('00000003\n');
            s.write(out);
            break;
          }
          case 'EXIT': s.end(); return;
          default: ok(-22);
        }
      }
    });
    s.on('error', () => {});
  });

  // `server.close()` stops it accepting and leaves every open connection alive, which
  // keeps the process running long after a test has finished with it.
  const stop = () => { for (const s of live) s.destroy(); live.clear(); srv.close(); };

  return new Promise((res) => srv.listen(port, '127.0.0.1', () =>
    res({ server: srv, port: srv.address().port, log, attrs, stop })));
}
