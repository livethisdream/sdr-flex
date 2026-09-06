# Architecture Decision Records

Short records of decisions that are expensive to reverse. Each states the decision,
why, what it costs, and what would make us change our minds.

| # | Decision | Status |
|---|---|---|
| [0001](0001-client-server-split.md) | Client-server split; GUI has no privileged path | Accepted |
| [0002](0002-selection-is-the-primitive.md) | Selection is the primitive; the flowgraph is derived | Accepted |
| [0003](0003-gnuradio-in-worker-processes.md) | GNU Radio runs in worker processes, one per source | Accepted |
| [0004](0004-flowgraph-splitting-at-taps.md) | Split flowgraphs at taps, not per block | Accepted |
| [0005](0005-all-sources-are-time-indexed.md) | All sources are time-indexed media; live is recorded | Accepted |
| [0006](0006-semantic-stream-types.md) | Semantic stream types drive the palette | Accepted |
| [0007](0007-stream-context-and-provenance.md) | Context and provenance travel with every stream | Accepted |
| [0008](0008-sigmf-native.md) | SigMF is the native capture and annotation format | Accepted |
| [0009](0009-command-log.md) | All state changes go through a command log | Accepted |
| [0010](0010-hot-vs-cold-parameters.md) | Parameters declare hot vs. cold | Accepted |
| [0011](0011-web-client-first.md) | Web client first, WebGL rendering, native shell later | Accepted |
| [0012](0012-server-side-display-rendering.md) | Display rendering is server-side and lossy | Accepted |
| [0013](0013-external-decoders-as-subprocesses.md) | External decoders are first-class subprocess plugins | Accepted |
| [0014](0014-rust-data-plane.md) | The hot path never touches Python | Accepted |
| [0015](0015-licensing-posture.md) | Licensing posture: Apache-2.0 core, GPL-3 workers | Accepted |
| [0016](0016-performance-envelope.md) | Pluto class now, ~60 MS/s tier later; source layer is not SoapySDR | Accepted |
| [0017](0017-auto-manual-parameters.md) | Every derived value has an auto/manual state | Accepted |
| [0018](0018-contextual-menus-and-view-tabs.md) | Contextual menus over sidebars; views are tabs | Accepted |
| [0019](0019-settings-surfaces.md) | Settings have four homes; none is a left pane | Accepted |
| [0020](0020-views-that-share-an-axis.md) | Views that share an axis are one view | Accepted |
| [0021](0021-mock-engine-first.md) | The client is built first, against a mock engine | Accepted |
| [0022](0022-conversational-control.md) | Language is a peer client, not a replacement for the GUI | Accepted |
| [0023](0023-frequency-makes-a-channel.md) | Frequency makes a channel; time is a property of one | Accepted |
| [0024](0024-composable-decode-chain.md) | The transparent decode path is composable single-purpose nodes | Accepted |
| [0025](0025-golden-capture-conformance.md) | A demod or decoder ships with a golden capture, or it does not ship | Accepted |
| [0026](0026-decoder-packs.md) | A decoder ships as a pack — manifest, fixtures and version pin | Proposed |
