# Running the engine on a box

The client and the engine are served from the same place on purpose. A page served from
somewhere else has to negotiate CORS, and — the trap that actually bites — a page served
over HTTPS may not open a `ws://` socket at all: it fails with a console line about
mixed content and no other symptom. Same origin means there is nothing to configure.

## Directly

```
node seed-captures.mjs     # optional: the two synthetic captures this repo ships
node server/main.js
```

It prints the address it bound to and why, how many captures it found, and how many
decoders. If it says `no tailnet found — loopback only`, that is the safe default doing
its job, not a failure.

No install step. There are no dependencies — the client is ES modules the browser loads
as they are, and the server is Node's own `http`, `net` and `crypto`. Node 22 or newer.

| Variable | Default | What it does |
|---|---|---|
| `SDRFLEX_PORT` | `8722` | Port to listen on |
| `SDRFLEX_BIND` | `auto` | Addresses to answer on. `auto` means loopback *and* the tailnet if there is one — never the LAN, never every interface. A comma-separated list is allowed |
| `SDRFLEX_CAPTURES` | `./captures` | Directory of captures to offer |
| `SDRFLEX_WEB` | `../web` | The client to serve |
| `SDRFLEX_RINGS` | the system temp directory | Where live recordings are kept |
| `SDRFLEX_PLUGINS` | `../web/plugins` | Decoders the box offers every tab |

## In a container, on a tailnet

```
SDRFLEX_HOST_IP=$(tailscale ip -4) \
SDRFLEX_CAPTURES=/srv/captures \
docker compose up -d
```

Then open `http://<that address>:8722` from any device on the tailnet.

The left-hand side of the port publish is the host address the container is reachable
at. Scoped to the tailnet address, the port exists on the tailnet and nowhere else: not
on the LAN, not on hotel Wi-Fi, not on anything a router might forward. It defaults to
loopback so that forgetting to set it fails closed.

For real TLS — so `https://` and `wss://` work with no certificate warning:

```
tailscale serve --bg http://127.0.0.1:8722
```

**Never `tailscale funnel`.** That publishes to the whole internet, and there is no
authentication in front of this.

## Radios

A live source is a program writing raw IQ into a ring recording, which the engine reads
exactly as it reads a file ([ADR-0030](../docs/adr/0030-a-radio-is-a-recording.md)). So
support for a radio means having its capture program installed, and nothing else:

| Driver | Needs | From | Windows |
|---|---|---|---|
| **ADALM-PLUTO** | **nothing** | — | yes |
| RTL-SDR | `rtl_sdr` | `rtl-sdr` | yes |
| ADALM-PLUTO (via libiio) | `iio_readdev`, `iio_attr` | `libiio-utils` | yes |
| USRP (UHD) | `uhd_rx_cfile` | `uhd-host` | no — it writes to `/dev/stdout` |
| SoapySDR (anything else) | `rx_sdr` | `soapysdr-tools` | yes |
| Synthetic signal | nothing | built in | yes |

**The Pluto needs nothing installed.** It is not a USB device to claim — it presents a
USB-ethernet gadget answering on `192.168.2.1`, and `iiod` listens on port 30431, so the
driver is a TCP client and the protocol is spoken directly. No libiio, no native module,
no `Dockerfile.radio`. Set `SDRFLEX_PLUTO_HOST` if the board is somewhere other than its
default address — behind a port forward, or given a real address on your network.

It is also the only driver that **retunes without restarting**: a frequency is an
attribute write rather than a new command line, so the stream keeps running and the ring
keeps its history. Every other driver here loses a second of air and everything recorded
to change frequency, because that is what killing and respawning costs.

The second Pluto entry, via libiio, is kept for the cases the socket cannot reach — a
board in pure USB mode rather than its ethernet gadget.

The server runs on Windows as well as Linux, and looks up these programs by PATHEXT
there, so `iio_readdev.exe` is found from the bare name. UHD is the exception: it takes
a filename rather than a stream and is pointed at `/dev/stdout`, which Windows does not
have, so that driver reports itself unavailable there rather than failing obscurely.

They show up under `src` on the bottom bar, as "listen to a radio…". A driver whose
program is not installed is still listed, greyed, saying what it wants — that is a
five-second problem, and a menu that hides the option instead is a twenty-minute one.

**The synthetic source is not a radio.** It generates the same scene the in-tab engine
draws, at a real rate in real time, so you can see the whole live path work — recording,
scrubbing back into history, building a chain on a moving source — on a machine with
nothing plugged into it. It is also how the live path is tested.

Two things worth knowing before you rely on it:

- **The ring is scratch.** Sixty seconds by default, allocated up front, deleted when
  the tab goes away. Sixty seconds of 2.4 MS/s cu8 is 288 MB, so if `/tmp` is a tmpfs
  on your box, point `SDRFLEX_RINGS` at a real disk.
- **Retuning restarts the recording.** None of these programs can be retuned in flight,
  so a new center frequency means a new process and an empty ring. The frequency
  readout follows your pointer immediately; the radio follows when you let go.

### A radio in a container

The default image has none of these programs in it. Build the radio variant instead:

```
SDRFLEX_DOCKERFILE=Dockerfile.radio docker compose up -d --build
```

How the container reaches the radio depends on how the radio attaches:

- **Pluto** talks over its USB-ethernet gadget, so it is a *network* device at
  `192.168.2.1`. The container needs a route to that address and no USB access at all.
- **RTL-SDR and USRP** are claimed as USB devices, so the container needs
  `devices: ["/dev/bus/usb:/dev/bus/usb"]` in `docker-compose.yml`, and the host needs
  udev rules that let a non-root user open them (`rtl-sdr` and `uhd-host` install
  those). If you would rather not, run the server outside a container — it is one
  command and no privileges.

### Windows and a Pluto

The Pluto is a *network* device — its USB-ethernet gadget answers on `192.168.2.1`, and
libiio talks to it over TCP. So the only question is which machine can open that
socket, and the shortest answer is usually the one that already can.

**Run the server on Windows.** Node is cross-platform and so is everything in here.
Install libiio for Windows (Analog Devices ships an installer with `iio_info`,
`iio_attr` and `iio_readdev` in it), make sure `iio_info -u ip:192.168.2.1` answers
from PowerShell, then:

```
node server\main.js
```

No WSL, no container, no namespace to cross. If Tailscale is running on Windows this is
also the only arrangement where the tailnet address is found automatically, because it
is the machine that has one.

**Running the server in WSL with Tailscale inside WSL** works without anything special:
it answers on loopback as well as the tailnet, and Windows forwards its own localhost
into the distro, so Chrome on Windows reaches it at `http://localhost:8722` while your
phone reaches it at the `100.x` address. It says both on startup.

**If you would rather run it in WSL**, the remaining problem is the Pluto: WSL2 sits
behind its own NAT and cannot reach the Windows host's Pluto adapter. Pick the smallest
fix that works:

- **Forward the port from Windows.** `iiod` listens on 30431, so one `netsh` rule makes
  it reachable without changing how anything else on the machine is networked:

  ```
  netsh interface portproxy add v4tov4 ^
    listenaddress=0.0.0.0 listenport=30431 ^
    connectaddress=192.168.2.1 connectport=30431
  ```

  Then from WSL, point at the Windows host instead of the Pluto — the URI is
  `ip:<windows host address>`, and libiio's default port is the one you forwarded.

- **Attach the USB device to WSL** with `usbipd-win`, so the Pluto enumerates inside WSL
  and `192.168.2.1` is on a WSL interface directly. Clean when it works; it needs the
  WSL kernel to carry the USB-ethernet modules, which is not guaranteed.

- **Mirrored networking** (`networkingMode=mirrored` in `.wslconfig`) also fixes it, and
  is the largest hammer available: it changes networking for every WSL distro on the
  machine and is known to interact badly with VPNs and with anything that binds ports.
  Worth knowing about; not worth reaching for first.

**Then, and only then, consider a container.** Docker Desktop puts the container in yet
another namespace, and host networking there is not the same thing it is on Linux. If
you want it supervised, install Docker Engine inside WSL rather than Docker Desktop and
add `network_mode: host` — but get the Pluto answering first, or two problems debug as
one.

**Recommendation:** run it on Windows, or in WSL with the portproxy rule. Containerize
later, if at all — this is one command and no privileges.

### What has and has not been verified

**Only the synthetic driver has been tested.** The other four command lines are written
from documented interfaces, on a machine where none of those programs are installed.
They are the most likely thing here to be wrong, and the easiest to fix — each one is a
row in the table at the top of `server/radio.js`.

The Pluto and RTL-SDR command lines have since been checked against the real
`iio_attr`, `iio_readdev` and `rtl_sdr` binaries: the arguments parse and get as far as
looking for hardware. That is not the same as knowing they work, and one thing in
particular is worth checking first:

- **The Pluto's sample scaling.** `iio_readdev` writes the raw buffer, and the AD9361's
  channels are commonly 12 bits carried in a 16-bit word. This build reads them as
  `cs16`, so if the signal looks real but about 24 dB quieter than it should, that is
  why — and the fix is a scale factor, not a redesign. `iio_attr -u ip:192.168.2.1 -c
  ad9361-phy voltage0` will tell you what the channel actually reports.

## Decoders

Two places a decoder can come from, with deliberately different trust stories:

- **The box.** Every `.js` file in `SDRFLEX_PLUGINS` is sent to every tab that connects
  and loaded there. Those are the operator's own files — the same trust as the capture
  directory — and it is how a decoder that ships with the tool is actually in the tool.
- **Your browser.** A file dropped on the window is kept in that browser and nowhere
  else, so it survives a reload without putting code on a machine other people reach.

Neither changes where a decoder *runs*: always in the tab, never on the server
([ADR-0029](../docs/adr/0029-the-client-owns-the-clock.md)). Storing is not executing.

A stored decoder that stops loading — edited into something broken, or rejected by a
newer build — is forgotten rather than retried on every startup, with a notice saying
what happened.

## Decoders somebody else wrote

External programs are run as decoders, fed a span of samples on stdin and read back as
records ([ADR-0013](../docs/adr/0013-external-decoders-as-subprocesses.md)). Install the
program and the decoder appears in the menu wherever its input type fits.

| Adapter | Takes | Binary | Debian/Ubuntu package | Covers |
|---|---|---|---|---|
| rtl_433 | IQ | `rtl_433` | `rtl-433` | 250+ ISM device protocols |
| multimon-ng | audio | `multimon-ng` | `multimon-ng` | POCSAG, FLEX, AFSK, DTMF, ZVEI |
| dump1090 | IQ | `dump1090`, `dump1090-mutability`, `dump1090-fa` | `dump1090-mutability` | ADS-B |
| direwolf | audio | `direwolf` | `direwolf` | APRS / AX.25 |
| minimodem | audio | `minimodem` | `minimodem` | RTTY, Bell 103/202, any N-baud FSK |
| LoRa | IQ | a GNU Radio module | see below | LoRa — chirp spread spectrum, SF7 to SF12 |

The first five at once:

```sh
sudo apt install rtl-433 multimon-ng dump1090-mutability direwolf minimodem
```

### Decoders that are GNU Radio flowgraphs

Most modern decoding in this field ships as a GNU Radio out-of-tree module rather than a
standalone program — LoRa, M17, TEMPEST, satellite telemetry. Those are reached the same
way as everything else: a flowgraph is a program, samples in on stdin and records out on
stdout ([ADR-0032](../docs/adr/0032-a-flowgraph-is-a-program.md)). The flowgraphs ship in
`server/flowgraphs/`.

```sh
sudo apt install gnuradio gnuradio-dev cmake g++ pybind11-dev python3-pil
git clone https://github.com/tapparelj/gr-lora_sdr && cd gr-lora_sdr
cmake -B build -DCMAKE_BUILD_TYPE=Release -DPYTHON_EXECUTABLE=$(which python3.12)
cmake --build build -j && sudo cmake --install build && sudo ldconfig
```

**Mind which Python.** GNU Radio builds its bindings against one CPython, and a machine
can have five. If `python3 -c "import gnuradio.gr"` fails but `python3.12 -c ...` works,
that is the reason — build the module with `-DPYTHON_EXECUTABLE` pointing at the one that
works, and the adapter will find it. The adapter tries `python3.12`, `python3.11`,
`python3.10`, `python3` in that order and reports the *module* as missing rather than the
interpreter, because installing Python is never the fix.

Checking the module is installed costs about half a second, so it is done once when the
server starts rather than on the first click. The startup banner says how many decoders
are actually here.

The container images do not carry GNU Radio — it is about a gigabyte. A decoder whose
module is missing is still listed, greyed, naming what to install.

An adapter lists more than one binary where the program has more than one name: the
same dump1090 is `dump1090-mutability` on Debian and `dump1090-fa` from FlightAware, and
the menu names whichever one is actually here.

The ones that take audio go after a demodulator — tune the channel, drop an FM or AM
demod on it, and they appear. The ones that take IQ go straight on the spectrum.

The engine converts and resamples the span to whatever the program wants — `rtl_433`
takes cu8 at 250 kS/s, `multimon-ng` takes signed 16-bit at 22.05 kHz, `minimodem`
insists on a WAV header because it reads through libsndfile — and the record pane says
what it fed it, because that changes what the decoder sees.

Every one of these is checked against the real program rather than against its
documentation. `node --test web/test/adapters.test.mjs` builds a signal with the
matching modulator in `web/test/support/modulate.mjs` — AX.25 with HDLC bit stuffing and
NRZI, Bell 202 as an async serial line, Mode S pulse-position with a correct parity —
runs the adapter on it and asserts the text comes back. A program that is not installed
is skipped, loudly. This is not ceremony: every one of these adapters was first written
from documentation and every one of them was wrong in a way that produced silence
rather than an error — a binary under a different name, a `--quiet` that turns off
stdout rather than the banner, a `-` that getopt eats, a config file without which
direwolf will not start on a machine with no sound card.

### Identify — try all of them at once

One button, next to the `+` on the tab strip, on any node carrying IQ or audio. It runs
every decoder that could read the stream in front of it, over eight seconds ending at
the playhead (or the pinned clip, if there is one), and reports what each one found.
Rows fill in as the decoders finish. Clicking one that found something builds the chain
it describes — the demodulator, then the decoder, with the settings that produced the
result — and lands on its records.

An audio decoder on a channel of IQ is tried behind an FM demodulator *and* an AM one,
because which is right is the question being asked.

Two parts of the report matter more than the list of hits:

- **What was not tried, and why.** Not installed, wrong kind of stream, or wanting more
  bandwidth than the capture ever had. "Nothing decoded this" and "nothing that could
  decode this was tried" are opposite answers.
- **What it decoded and refuses to count.** Told to try everything, multimon-ng's Morse
  demodulator reads a noise blip as `E`, and minimodem will lock onto almost any audio
  and hand back bytes. Both are shown with what they produced and why it does not count,
  rather than ranked next to a real decode. See
  [ADR-0031](../docs/adr/0031-identify-says-what-it-will-not-claim.md).

It costs about 1.8 s for eight seconds at 250 kS/s and 4.8 s at 2.4 MS/s, with the first
row back in roughly half that.

Three things are worth knowing:

- **These nodes are opaque.** You cannot drill into somebody else's decoder, adjust its
  slicer, or annotate a stage inside it, and the tab is drawn differently to say so.
  That is the trade for 250 protocols; the native chain is there for when you need to
  *understand* a decode rather than get one.
- **Adapters ship with the tool.** They are a table in `server/adapters.js`, not
  something you drop in. An adapter is a command line, so a droppable one would be
  arbitrary code execution on the box — the same reason dropped plugins run in your
  browser instead.
- **A missing program is still listed**, greyed, naming what it wants.

## Security posture, stated plainly

There is no login. The network is the boundary. On a tailnet that is reasonable, because
only your own devices are on it. On any network with other people on it, it is not.

Two things follow that are worth knowing:

- **Captures are readable by anything that can reach the port.** The library is a
  directory scan of `SDRFLEX_CAPTURES`, and paths outside that directory are refused —
  but everything inside it is on offer.
- **Plugins run in the browser, not on the server** ([ADR-0029](../docs/adr/0029-the-client-owns-the-clock.md)).
  Dropping a `.js` file executes it in your tab's sandbox. It does not execute on the
  box, and that is deliberate.
- **Anything in `SDRFLEX_PLUGINS` runs in every connected browser.** It is a directory
  of JavaScript that the tool hands to tabs and asks them to execute. Treat it the way
  you would treat any directory whose contents run as you — which is to say, put your
  own files in it.
- **Anything that can reach the port can start a radio**, which means spawning one of
  the capture programs above and writing a ring to disk. The driver list is fixed and
  the arguments are built here rather than passed through, so this is not a way to run
  arbitrary commands — but it is a way to use up a dongle and some disk.

## Is it working?

The page tells you which engine it is using — `window.sdrflex.remote` is `true` when it
is talking to a server. `?engine=mock` forces the in-tab engine, which is a complete
tool rather than a degraded mode, and is what the browser tests run against.

If nothing is listening, the page falls back to the in-tab engine in about 150 ms
rather than hanging.
