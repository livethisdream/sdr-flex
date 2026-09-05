# ADR-0002: Selection is the primitive; the flowgraph is derived

**Status:** Accepted

## Decision

The user's model is a **tree of narrowing selections** over the time-frequency plane.
The GNU Radio flowgraph is compiled from that tree. Graph editing is one-way:
tree → flowgraph. The compiled graph is viewable read-only and exportable as `.grc`,
but is never the thing the user authors.

## Why

Signal analysis is iterative narrowing. The user thinks "*this* piece of spectrum,
during *that* burst, demodulated *this* way." That's a tree. Making them express it
as a bipartite graph of blocks and connections is an extra translation step performed
by the human — which is exactly what makes GRC unsuitable for exploration, and what
makes SDRangel's data flow hard to intuit.

## Cost

- The tree cannot express everything a DAG can. Feedback loops, multi-input blocks
  (correlators, diversity combining), and merges are not natural children of a parent.
- Users arriving from GNU Radio will ask for graph editing, repeatedly.

## Mitigation

The node model is a **DAG with a designated primary parent**. The tree is the primary
parent spanning tree; secondary inputs are allowed and drawn as dashed links in the
tree pane. This covers most multi-input blocks without abandoning the tree as the
navigational model. Genuinely graph-shaped work is a `grc` plugin — you build it in
GRC, wrap it in a manifest, and it becomes a single node in the tree.

## Would change our mind

If more than a small minority of real analyses need structure the tree can't hold,
even with secondary inputs. Revisit after M5, with evidence from actual projects.
