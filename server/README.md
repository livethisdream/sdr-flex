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

## Is it working?

The page tells you which engine it is using — `window.sdrflex.remote` is `true` when it
is talking to a server. `?engine=mock` forces the in-tab engine, which is a complete
tool rather than a degraded mode, and is what the browser tests run against.

If nothing is listening, the page falls back to the in-tab engine in about 150 ms
rather than hanging.
