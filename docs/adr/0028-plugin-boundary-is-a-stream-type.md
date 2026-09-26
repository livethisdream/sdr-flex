# ADR-0028: A plugin is defined by the stream types it sits between, not by how it runs

**Status:** Accepted — narrows ADR-0013, which conflated "plugin" with "subprocess"

## Decision

A plugin declares `in` and `out` as **semantic stream types** ([ADR-0006](0006-semantic-stream-types.md)).
How it executes — an ES module in the page, a subprocess, a GNU Radio hierarchical
block — is an implementation detail of that one plugin, not the definition of the
category.

The first kind to ship is `js`: an ES module the user drops on the window, exporting a
`manifest` and a `decode(data, params)`. It runs in the client, needs no server, and
was shipped in M0.

## Why

ADR-0013 was written from the `rtl_433` end of the chain, where a plugin eats IQ or
audio. Everything hard about that decision — sample-rate negotiation, format
conversion, supervising a process that might segfault mid-stream, the license
boundary — is a property of *that end*, not of plugins.

The late end has none of it. `gr-bbc`'s decoder is `decode(packet, msg_bytes,
cod_bytes) → [messages]`: eight kilobytes in, a handful of records out. No rate, no
format, no throughput, nothing to supervise. Wrapping that in a subprocess protocol
because "plugins are subprocesses" would be pure ceremony.

Two things follow, and both are worth having:

- **Plugins ship before the engine does.** A `bytes → events` plugin runs in a static
  page. We had written off any plugin system until M5 on the grounds that M0 cannot
  spawn processes; that was true and irrelevant.
- **The type system starts earning its keep.** `bytes` and `events` were declared in
  ADR-0006 in the first week and nothing had needed them. A plugin needs somewhere to
  plug in, and "after the slicer, before the records" is exactly where.

The reference implementation is a port of `gr-bbc`'s concurrent-code decoder, chosen
because it is somebody else's algorithm solving somebody else's problem — the honest
test of an extension point is a thing you did not design it around.

## Cost

- **A `js` plugin runs with the page's privileges.** There is no sandbox, and a sandbox
  a real decoder could work inside would be a research project. This is a tool you run
  on your own machine against your own captures; the control is that you choose the
  file, and pretending otherwise would be theatre. A hosted multi-user deployment would
  need a different answer and does not exist.
- **Four kinds to maintain** (`js`, `process`, `gr_hier`, `grc`) rather than one. They
  share the manifest, the type filter and the parameter model; only execution differs.
- **A plugin author can now write something slow** and the frame loop will feel it. The
  late-stage boundary makes that unlikely — kilobytes — but nothing prevents it.

## What this does not change

- External *processes* are still opaque, still marked, still supervised (ADR-0013).
- A GNU Radio OOT module still needs the engine to be GNU Radio. `gr_hier` remains
  gated on M2; this ADR only stops that from being the definition of the word.
- Conformance (ADR-0025) applies to plugins too: a golden capture and an expected
  record set, or it is not shipped.

## Would change our mind

If real plugins turn out to cluster at the IQ end after all — if `bytes → events` is a
one-off that only concurrent codes need — then the late boundary is a special case and
ADR-0013's framing was right. The test is whether the second and third `js` plugins
arrive without being asked for.

## Addendum: what the second plugin settled, and what it exposed

The second `js` plugin is a DTMF decoder, and it reads **`real`** — not `bytes`, and not
IQ. So the prediction above is answered in the middle: plugins do not cluster at the IQ
end, and `bytes → events` was not the whole of it either. The boundary is a stream type,
which is what this ADR said; it is just not one stream type.

Getting there exposed that **the decision had only ever been half-implemented.** The
manifest declared `in`, the palette filtered on it, `Identify` planned on it — and the
runner ignored it, fetching bytes whatever it said. A plugin declaring `real` was
therefore offered in the menu, built a node, and then reported "nothing upstream has
produced bytes yet", which is wrong and unhelpful about being wrong. It was invisible
because the only plugin that existed read bytes.

Worth naming, because it was not a conversion that was missing. The bytes a plugin used
to receive are the *output of a slicer*, several nodes downstream of the audio — not a
serialized form of it. There was never a buffer for a plugin to reinterpret, so "let the
plugin convert" was never the alternative it looked like. Which node's output a plugin
gets is the whole question, and the manifest had been answering it all along.

`Graph.pluginFeed` is the fix: read the parent by its kind, and pass the facts a decoder
cannot derive — the sample rate, above all — as a third argument to `decode`.

**`out` is now bounded where `in` was widened**, which is the opposite move and the right
one. A plugin returns records. A manifest declaring `out: 'real'` is declaring itself a
*stage*, and everything downstream would read its samples through `readSpan`, on demand,
cached, on the engine's clock. Nothing routes a read through a JS function, so such a
node builds, appears in the menu and produces nothing — this same failure, one level up.
It is refused at load with the reason. A general block that produces a stream is a real
thing to want; it is a different piece of work and not this one.
