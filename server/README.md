# Running the engine on a box

The client and the engine are served from the same place on purpose. A page served from
somewhere else has to negotiate CORS, and — the trap that actually bites — a page served
over HTTPS may not open a `ws://` socket at all: it fails with a console line about
mixed content and no other symptom. Same origin means there is nothing to configure.

## Directly

```
node server/main.js
```

No install step. There are no dependencies — the client is ES modules the browser loads
as they are, and the server is Node's own `http`, `net` and `crypto`. Node 22 or newer.

| Variable | Default | What it does |
|---|---|---|
| `SDRFLEX_PORT` | `8722` | Port to listen on |
| `SDRFLEX_BIND` | `auto` | Address to bind. `auto` picks the Tailscale interface if there is one, otherwise loopback — never every interface |
| `SDRFLEX_CAPTURES` | `./captures` | Directory of captures to offer |
| `SDRFLEX_WEB` | `../web` | The client to serve |
| `SDRFLEX_RINGS` | the system temp directory | Where live recordings are kept |

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

| Driver | Needs | From |
|---|---|---|
| RTL-SDR | `rtl_sdr` | `rtl-sdr` |
| ADALM-PLUTO | `iio_readdev`, `iio_attr` | `libiio-utils` |
| USRP (UHD) | `uhd_rx_cfile` | `uhd-host` |
| SoapySDR (anything else) | `rx_sdr` | `soapysdr-tools` |
| Synthetic signal | nothing | built in |

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

### Windows, WSL and a Pluto

This is three network namespaces stacked — Windows, WSL, and the container — and the
Pluto is on the far side of all three. Do it in that order, and stop at the first thing
that fails.

**1. Can Windows see it?** With the Pluto plugged in and its driver installed, a
network adapter appears with an address on `192.168.2.x`. `ping 192.168.2.1` from
PowerShell.

**2. Can WSL see it?** This is the step that usually fails. WSL2 is NAT'd behind its
own virtual switch and cannot reach the Windows host's Pluto adapter by default. The
fix is mirrored networking — in `%USERPROFILE%\.wslconfig`:

```
[wsl2]
networkingMode=mirrored
```

then `wsl --shutdown` and start it again. Now `ping 192.168.2.1` and
`iio_info -u ip:192.168.2.1` from inside WSL. If `iio_info` prints the device tree,
everything after this is straightforward. (Mirrored networking needs Windows 11 22H2 or
newer with WSL 2.0+. The alternative is `usbipd-win` to attach the USB device to WSL
directly, which then needs a WSL kernel with the USB-ethernet modules built in — more
work, and only worth it if mirrored mode is not available to you.)

**3. Then, and only then, add the container.** Docker Desktop puts the container in yet
another namespace, and host networking on Docker Desktop for Windows is not the same
thing it is on Linux. Two ways through:

- **Run the server in WSL directly**, no container: `node server/main.js`. Nothing to
  configure, and it is the path that has actually been tested.
- **Install Docker Engine inside WSL** (not Docker Desktop) and add
  `network_mode: host` to the service. Then the container shares WSL's network, which
  step 2 has already established can reach the Pluto.

**One more thing that will bite.** If Tailscale runs on Windows rather than inside WSL,
WSL has no `100.x` address, so `SDRFLEX_BIND=auto` finds no tailnet and falls back to
loopback — reachable from WSL and from nowhere else. Either run Tailscale inside WSL
too, or bind to the WSL address and forward the port from Windows with
`netsh interface portproxy`.

**Recommendation:** get to the end of step 2, run `node server/main.js`, and open a
radio. Containerize afterwards if you want it supervised. Adding Docker before the
Pluto works means debugging two problems as one.

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
