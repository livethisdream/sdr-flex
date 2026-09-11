# Adding a decoder

Three ways, and which one you want depends on where the code runs.

| | runs | you add it by | trust |
|---|---|---|---|
| **Plugin** | your browser | dropping a `.js` file on the window, or `SDRFLEX_PLUGINS` | anybody can hand you one; it is sandboxed |
| **Adapter** | the box | a directory named by `SDRFLEX_ADAPTERS` | yours, on your machine, on purpose |
| **Built in** | either | a pull request | ours |

A **plugin** takes a stream type and returns records, in JavaScript, in the tab
([ADR-0028](adr/0028-plugin-boundary-is-a-stream-type.md)). See [plugins](04-plugins.md).

An **adapter** runs a program. That is the rest of this page.

---

## The contract

An adapter is a program that reads samples on stdin and writes records on stdout. That is
all it is. `rtl_433`, `dump1090`, `direwolf`, `minimodem` and a GNU Radio flowgraph all
satisfy it, and the engine handles everything either side: reading the span out of the
graph, resampling and converting it to whatever the program wants, running it, reading it
back, and putting the records in a pane.

**You never write a converter.** The manifest says what the program needs and the engine
derives the chain, then tells the user what it did — because resampling changes what a
decoder sees, and "why does this find nothing here and everything in the same signal
saved to a file" is a bad afternoon ([ADR-0013](adr/0013-external-decoders-as-subprocesses.md)).

## Where it goes

```sh
export SDRFLEX_ADAPTERS=~/sdrflex-decoders
```

```
~/sdrflex-decoders/
  my-decoder/
    adapter.json          the manifest — or adapter.mjs, when it needs functions
    flowgraph.py          optional, named by the manifest
    fixture.json          optional, and the golden capture beside it
    capture.sigmf-data
    capture.sigmf-meta
    README.md
```

One directory per decoder. The server reads them at startup and says how many loaded;
one that does not load is named with the reason and skipped, so a typo in your manifest
does not take the other decoders with it.

**A world-writable directory is refused.** An adapter is a command line — anything that
can write there can run programs on your box, so the directory's permissions *are* the
control. `chmod o-w` it.

## The manifest

Everything required, with `rtl_433` as the example:

```json
{
  "id": "ext.my433",
  "name": "rtl_433, my way",
  "group": "Decode",
  "in": "iq",
  "out": "events",
  "blurb": "what it shows in the menu",
  "command": ["rtl_433"],
  "wants": { "format": "cu8", "rate": 250000 },
  "params": [
    { "id": "protocol", "default": "", "label": "only protocol",
      "placeholder": "e.g. 40", "hint": "empty means all of them" }
  ],
  "args": [
    "-r", "cu8:-", "-s", "{rate}", "-f", "{centerHz}", "-F", "json", "-M", "level",
    { "if": "protocol", "then": ["-R", "{param:protocol}"] }
  ],
  "parse": "jsonl",
  "title": ["model", "type", "codes"]
}
```

| field | |
|---|---|
| `id` | starts with `ext.`; defaults to `ext.<directory name>` |
| `in` / `out` | `iq`, `real`, `bits`, `bytes`, `events` — decides where it appears in the menu |
| `command` | candidate binaries, in preference order. Several because one program has several names: `dump1090`, `dump1090-mutability`, `dump1090-fa` |
| `wants.format` | `cu8`, `cs8`, `cs16`, `cf32`, `s16` |
| `wants.rate` | what the program needs on stdin |
| `wants.container` | `wav`, for a program that reads through libsndfile and will not take headerless samples on a pipe |
| `params` | the knobs. The parameter strip draws one it has never heard of |
| `args` | the command line. `{rate}`, `{centerHz}`, `{dir}`, `{param:id}` are substituted |
| `parse` | `jsonl` — one JSON object per line — or `lines` |
| `title` | which field is the headline of a record, in order of preference |
| `sweep` | what "try everything" means for this decoder, used by **Identify** |
| `recordsOn` | `"stderr"`, for a program whose stdout is not records — see below |

**A flag whose value is empty is left out, with its flag.** That is what the `if` form is
for: "restrict to one protocol" and "restrict to no protocol" are different command
lines, and `-R ''` is neither of them.

**A rate that follows a knob** is said without writing a function:

```json
"wants": { "format": "cf32", "ratePerParam": { "param": "bw", "times": 2, "default": 125000 } }
```

That is LoRa: sampled at a whole multiple of its bandwidth, so the bandwidth knob decides
what the decoder is fed.

## When the records are not on stdout

`m17-demod` writes decoded **voice** to stdout and its link setup frame to stderr. Set
`"recordsOn": "stderr"` and the engine stops keeping stdout — it counts the bytes and
hands the count to your parser instead. That is not tidiness: a few seconds of 8 kHz audio
coerced into a JavaScript string is wrong, and on a long capture it is a way to run the
server out of memory.

```js
recordsOn: 'stderr',
parse: (stdout, stderr, spec, meta) => {
  const seconds = meta.outBytes / 2 / 8000;
  // …read the records out of stderr…
}
```

**Say what you dropped.** The M17 adapter puts the decoded duration on the record, because
"there were two seconds of voice here and this node does not carry it" is useful and
silence is not. Carrying decoded audio back into the graph is a real gap; an adapter
produces records today.

## When a manifest is not enough

Name the file `adapter.mjs` and default-export the same object, with real functions:

```js
export default {
  id: 'ext.odd', name: 'Odd', in: 'real', out: 'events',
  command: ['oddball'],
  wants: { format: 's16', rate: 22050 },
  args: ({ rate, params }) => ['--rate', String(rate), ...(params.mode ? ['--mode', params.mode] : [])],
  // stdout and stderr, because one of these needs both
  parse: (stdout, stderr) => stdout.split('\n').filter(Boolean).map((text) => ({ text })),
  // a config file written fresh per run, in a directory that goes away with the run
  files: ({ params }) => [{ name: 'odd.conf', text: `MODE ${params.mode}\n` }],
};
```

No extra trust is involved: the JSON form already names a command to run.

## A GNU Radio module

Most modern decoding in this field is a GNU Radio out-of-tree module rather than a
standalone program. A flowgraph satisfies the same contract, so it is the same manifest
plus two fields ([ADR-0032](adr/0032-a-flowgraph-is-a-program.md)):

```json
{
  "command": ["python3.12", "python3.11", "python3"],
  "module": "gnuradio.my_oot",
  "flowgraph": "flowgraph.py"
}
```

- **`module`** is what "installed" means. For every other adapter that is a name on PATH;
  for a flowgraph the command is an interpreter, which is always there, and what actually
  has to exist is a module inside it. The engine asks the interpreter to import it.
- **`command` is a list, and the order matters.** GNU Radio builds its bindings against
  one CPython and a machine can have five. If `python3 -c "import gnuradio.gr"` fails and
  `python3.12 -c` works, that is why — and the tool reports the *module* as missing, never
  Python, because installing Python is never the fix.

The flowgraph itself:

```python
#!/usr/bin/env python3
import json, sys
from gnuradio import gr, blocks
from gnuradio import my_oot

tb = gr.top_block('rx', catch_exceptions=False)
src = blocks.file_descriptor_source(gr.sizeof_gr_complex, 0, False)   # stdin, no temp file
rx  = my_oot.receiver(...)
sink = blocks.message_debug()
tb.connect(src, rx)
tb.msg_connect((rx, 'out'), (sink, 'store'))
tb.run()                              # returns when stdin closes

for i in range(sink.num_messages()):
    print(json.dumps({'text': ..., 'hex': ...}), flush=True)
```

- `file_descriptor_source(…, 0, …)` reads fd 0 — the span arrives on the pipe, there is no
  temp file and no seeking. Match the sample type to `wants.format`: `gr.sizeof_gr_complex`
  for `cf32`, `gr.sizeof_float` for `s16` read as floats, `gr.sizeof_short` for `s16`.
- stdout is the record stream; **stderr is diagnostics** and is only surfaced when nothing
  decoded. Turn off any console printing the module does of its own.
- `tb.run()` returns when stdin closes. A flowgraph with a `message_strobe` or any other
  free-running source in it will not return, and needs `tb.start()` and a stop condition.
- Write it by hand. A GNU Radio Companion export carries a GUI, a throttle and a live
  sample-rate variable, none of which belong in a job that reads a span and exits.

**Hier blocks:** they are plain Python classes, so instantiate and connect them — but
check whether the payload leaves on a **stream** port or a **message** port, and do not
trust introspection. `gr-lora_sdr`'s receiver has both, and `message_ports_out()` reports
none of them because hier ports do not show up there. Read the installed
`lora_sdr_lora_rx.py` and look for `message_port_register_hier_out`.

## Ship a golden capture with it

An adapter with no fixture is an adapter nobody can tell has broken
([ADR-0025](adr/0025-golden-capture-conformance.md)). Put `fixture.json` and the capture
in the pack:

```json
{
  "name": "what this protects",
  "why": "one paragraph on what breaks if this test goes away",
  "capture": "capture.sigmf-data",
  "needs": "ext.my433",
  "chain": [{ "op": "ext.my433", "params": { "protocol": "40" } }],
  "expect": { "records": 2, "noError": true, "fieldContains": { "model": ["Acurite"] } }
}
```

**Generate the capture, do not record one.** A synthesized signal has an unambiguous
answer to who transmitted it and whether it can be redistributed. Where writing a
modulator would mostly be reimplementing the protocol you are trying to test — LoRa, say —
use the decoder's own transmitter instead: the check is then two-sided, and if either half
drifts the other stops agreeing.

**And ship a control.** A decoder that finds something at every setting has found nothing.
The LoRa fixture's control is that the same capture read at the wrong spreading factor
returns nothing at all.

## What it looks like when it works

- The decoder is in the menu wherever its input type fits, badged **yours** rather than
  **ext**, so a decoder you added misbehaving and one that shipped misbehaving are
  distinguishable at a glance.
- **Identify** runs it along with everything else, and will say why it was skipped if it
  cannot read the stream in front of it
  ([ADR-0031](adr/0031-identify-says-what-it-will-not-claim.md)).
- A missing program is still listed, greyed, naming what to install.
- The node is **opaque** — you cannot drill into somebody else's decoder, and the tab is
  drawn differently to say so. That is the trade for hundreds of protocols you did not
  write; the native chain is there for when you need to *understand* a decode rather than
  get one.
