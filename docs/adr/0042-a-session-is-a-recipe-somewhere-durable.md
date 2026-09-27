# ADR-0042: A saved session is the recipe, written somewhere durable — not a live engine held open

**Status:** Accepted — extends [ADR-0032](0032-a-flowgraph-is-a-program.md) and the
resume recipe it already implies

## Decision

**A session is a name, a timestamp and a recipe**, stored as a few kilobytes of JSON and
replayed onto a capture when it is opened. It is the same recipe `web/src/resume.js`
already writes down every three seconds — the same nodes, the same hand-turned
parameters, the same refusal to store anything derived — with somewhere to keep it and a
way to find it again.

**The server does not hold sessions open.** Nothing survives a disconnect on the box. A
`Session` in `server/session.js` is still one engine per socket, created on connect and
disposed on close, and that stays true.

**Where a session is stored depends on whether there is a box**, and nothing else changes
with it. With a server, sessions are files in `.sessions` inside the capture directory,
over HTTP. Without one they are in the browser's own storage. The record is byte-identical
either way.

## Why not the live session

The other design was the obvious one: the server keeps the engine alive after the socket
drops, hands out a session id, and a returning client reattaches to the work still
running. It is rejected for four reasons, and the first is on its own sufficient.

**This tool runs with no server at all.** `web/index.html` opened off a disk, the hosted
copy on GitHub Pages, `?engine=mock` — in all three the engine is in the tab and there is
no process to hold anything. A session that lives in a server process is a feature the
primary deployment cannot have, and "your work is saved, unless you are using it the way
most people use it" is not a feature.

**It inverts [ADR-0029](0029-the-client-owns-the-clock.md).** A held session holds a
playhead, a view, a selection, a zoom. Those belong to whoever is watching; that is the
whole of ADR-0029 and the reason every read carries the moment it wants. A server that
resumes you where you were is a server with a clock.

**It stores derived values, which [ADR-0017](0017-auto-manual-parameters.md) spends its
length arguing against.** A live engine holds measured deviations, fitted symbol periods,
estimated line periods and the evidence strings that go with them. Bringing those back is
bringing back a measurement of a signal rather than a measurement *from* it, and the
failure is silent: a number that was right about a capture that has since been replaced.
Replaying a recipe re-derives every one of them and attaches fresh evidence.

**And it is a large claim about what the server is.** Lifetimes, eviction, a memory
budget, what happens when two clients attach to one session, what a reconnect is allowed
to assume. All of that, to avoid re-running a chain that rebuilds in under a second.

What the live session would genuinely buy is a long-running decode you do not want to
repeat. Nothing in this tool is one: the expensive things here are bounded by the length
of a capture, and the capture is still on the disk.

## Why the recipe was already most of the answer

`resume.js` exists because a reload lost everything, and what it writes is already a
document in every sense but the name: it has a version, it is a few kilobytes, it
survives being copied between machines, and it has a replayer with a test suite arguing
that a rebuilt graph is the same graph. What it did not have was a *name*. One slot,
overwritten every three seconds, in one browser.

So the whole of this decision is: that record, with a name on it, in a place that is not
one slot. `web/src/sessions.js` adds no new description of a graph.

## Why the two stores, and why the same shape

On a box, sessions on the box means the work follows you between browsers and machines,
which is the point of having a box. In a tab with nothing behind it, the browser is the
only place there is. Both write the same record, so a session moves between them by being
copied — `curl host:8722/sessions/<id>` is a backup, and pasting one into another browser's
storage is a restore. A format that needed converting between the two would be two
formats.

## Over HTTP, not over the socket

The dispatch table in `server/session.js` is deliberately *the set of calls `MockEngine`
already had* — that is the entire point of the exercise recorded at the top of that file,
and it is only meaningful if the calls do not grow to make it true. A saved session is a
document, not a graph operation. It goes over the thing already serving documents, next
to `/version`, and the side effect is that it can be backed up with `curl` by somebody who
has never opened the page.

## Where the files go, which is not arbitrary

Inside the capture directory, in `.sessions`. That is the directory somebody mounted. A
sessions directory beside the source tree is a sessions directory inside the image, and
the first `docker compose up --build` after a week's work would delete exactly the thing
this feature exists to keep. `SDRFLEX_SESSIONS` overrides it; a box with no capture
directory keeps no sessions and says so, and the tab falls back to its own storage.

The library's scan only picks up files with sample extensions and skips anything that is
not a file, so a subdirectory of JSON is invisible to it — asserted, not assumed.

## This is the first thing the server writes for a client

Worth saying plainly, because there is no authentication in front of it
([main.js](../../server/main.js) on binding). Three rules keep the new surface small:

- **An id becomes a path only after matching `ID_RE`**, which is `[a-z0-9-]` and nothing
  else. That takes `..`, `/` and every separator with it. A name typed by a person is run
  through `idFor` before it is ever an id, and the server checks again rather than
  trusting that it was.
- **The only thing ever written is one `.json` per id in that one directory**, through a
  temporary file and a rename, so a full disk cannot leave a half-written session where a
  whole one was.
- **A body over a megabyte is refused before it is read**, by `content-length` where there
  is one and by counting where there is not.

## Saving is a thing you ask for

Named sessions do not autosave. This tool has no undo, and a session that wrote itself
down continuously would eventually write down the state you were about to abandon, over
the state you meant to keep. So the name carries an asterisk when the graph has moved
since it was written, which is the oldest convention there is for exactly this.

The three-second autosave stays, unchanged, doing the job it was built for: recovering
from a crash or a mis-clicked reload. The two are different problems and the tell is that
one of them offers rather than acts.

## Consequences

- `hello` carries `sessions`, and the client picks its store from that rather than
  probing. A probe cannot tell "this box keeps no sessions" from "this is not a box" —
  on a static host, `GET /sessions` answers with a 404 *page*, which parses as neither.
- **A live radio cannot be saved**, and says so rather than appearing in a list as
  something that will never open. `resume.canReplay` already declined to restore one; this
  declines earlier, where the person can do something about it.
- The strip's text control grows `commit: 'enter'`. A sync word wants to commit as you
  type — every character narrows the framing and you watch it happen. A name does not:
  committing "w", "wo", "wor" saves three times and calls the work "wor" on the way.

## Would change our mind

Something genuinely long-running and genuinely not worth repeating — a decode over hours
of recording, a search across a library rather than a capture. That is a *job* with a
result worth keeping, which is a different thing from a session, and it would want its
own record saying what was run and what came back. It would not want the engine held
open either.
