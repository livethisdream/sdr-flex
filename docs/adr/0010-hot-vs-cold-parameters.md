# ADR-0010: Parameters declare hot vs. cold

**Status:** Accepted

## Decision

Every parameter in a block manifest declares `hot: true|false`.

- **Hot** — pushed to the running block via a message port or setter. No rebuild.
  Sub-frame latency. Safe for direct manipulation.
- **Cold** — changing it requires rebuilding the containing fragment and everything
  downstream of it (ADR-0004).

The client renders these differently: hot parameters get drag handles, sliders, and
live scrubbing; cold parameters get a discrete control with a rebuild badge.

## Why

Direct manipulation is the whole feel of the product. Dragging a tuner box must move
the child spectrum *now*, at frame rate, or the "drill in" workflow feels sluggish
and the premise (ADR-0002) fails.

But some changes genuinely can't be hot — changing decimation changes the output rate,
which invalidates every downstream block's configuration. Pretending otherwise
produces either a lie (silent glitches) or paralysis (everything feels risky).

Declaring it makes the distinction **visible and honest**: the user learns which
knobs are free and which cost 300 ms, and is never surprised.

## Cost

- Plugin authors have to think about it and can get it wrong. A parameter falsely
  marked hot produces subtle corruption rather than a clean error.
- Two code paths per parameter in the compiler.

## Mitigation

`PATCH /nodes/{n}` returns `{rebuilt: bool}`, so the client can detect a mismatch
between prediction and reality and log it. Built-in blocks are the reference; a debug
mode that forces every change cold is a useful bisect tool for plugin authors.

## Note

Tuner `center_hz` and `bandwidth_hz` are hot; tuner `decimation` is cold. The common
gesture — dragging the selection box sideways — is therefore free, and only resizing
it far enough to cross a decimation boundary costs a rebuild.
