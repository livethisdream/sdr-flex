# ADR-0027: Sinks are nodes; views are tabs

**Status:** Accepted — supersedes the "audio is a subscription" position taken while
building wave 1

## Decision

Anything that **consumes** a stream and takes it out of the graph is a **node**: the
audio sink, and later the file writer, the network sink, the recorder. Anything that
**renders** what a node produced is a **view**, and views are tabs on the node that
produced them.

So `core.audio` is an operation in the palette, reached by the same gesture as every
other operation, with the same tab, the same ✕, and its volume and squelch as ordinary
node parameters in the strip.

## Why

The first version put listening on the transport bar as a speaker button, on the
argument that "a detector produces a real-valued stream, and listening to one is a
subscription to it, the same way the spectrum view is". That argument is wrong, and
the way it was wrong is worth keeping:

**A view renders what a node produced. A sink consumes it.** The spectrum view does
not change what exists — remove it and the graph is unchanged. Remove an audio sink and
something real stops happening. In every dataflow system, including the one we compile
to, a sink is a block, and it is a block precisely because it is where data leaves the
graph.

The practical evidence arrived immediately: the speaker button crowded the transport
until the scrubber was pushed off a phone screen. That is the usual shape of this
mistake — a thing that belongs in the model gets bolted onto the chrome, and the chrome
runs out of room. It is the same failure the tool exists to avoid
([vision](../01-vision.md)); the pile of bolted-on features is the specific complaint
that started the project.

Everything else follows for free rather than being designed:

- **Discovery** is the `+` menu on a `real` node, the one gesture the tool teaches.
- **Parameters** land in the strip, with auto/manual available like anything else.
- **Removal** is the ✕ that already removes blocks, and removing the detector above it
  takes the sink with it, because that is what removing a subtree means.
- **A mixer** is what you get when two channels each have a sink. There is no mixer
  feature to design — the graph already expressed it.
- **A pinned clip's audio** follows the clip, because the sink reads through its parent
  and `effectiveTime` already knows about pinning.
- **Multiple sinks on one detector** is meaningless and is prevented by nothing, which
  is fine; it is also harmless.

The one thing a sink needs that a middle-of-the-chain block does not is to be visible
from somewhere else, because audio outlives the tab it was started on. That is a live
level bar on its tab and a speaker mark on its channel's breadcrumb entry — two marks,
no new surface.

## Cost

- **A tab with no picture.** The Listen pane is a status, not a chart: what a sink is
  doing is *whether* it is doing it, and how loudly. Repeating its parent's waveform
  there would be a second copy of the tab next door.
- **A browser will only open an audio context from a gesture.** Adding the node is that
  gesture, which is lucky rather than designed — a sink that could be restored from a
  project file will need the first play to be a user action anyway.
- **`audio` becomes a stream kind** in ADR-0006's vocabulary that nothing consumes. That
  is what "terminal" looks like in a type system that filters the palette by input type:
  nothing declares `in: audio`, so nothing can follow it, with no special case.

## Would change our mind

If sinks turn out to need controls that must be reachable while looking at something
else — a panic mute across every channel, say — that is one global control, not a
retreat to the transport for all of them.
