# ADR-0017: Every derived value is a parameter with an auto/manual state

**Status:** Accepted

## Decision

Derivation is not a one-time convenience — it is a **per-parameter mode**. Every
parameter that *can* be derived carries an explicit state:

- **auto** — the engine derives it, and **re-derives it whenever anything upstream
  changes**. Shown with a `⟲` glyph and a slightly recessed value.
- **manual** — the user pinned it. It is **sticky**: upstream can change all it likes,
  the value stays. Shown with a `🔒` and a full-contrast value.

Typing into an auto field, or dragging its control, promotes it to manual. A `⟲`
click demotes it back.

The same applies one level up, at **decoder selection**: `Identify` is the auto mode
of choosing a decoder. Choosing one yourself and pinning its protocol is the manual
mode. Neither is the "real" way to use the tool.

## Why

The original framing — "derived by default, overridable on demand" — was too weak for
an exploratory tool. It described the *initial* value and said nothing about what
happens next, which is where the whole difficulty lives.

Consider: you pin a PWM slicer's symbol period to 417 µs, then widen the tuner's
filter to see if there's more signal at the edges. Should the symbol period be
re-estimated? **Absolutely not** — you were holding it fixed on purpose, and
re-guessing it silently destroys the comparison you were running.

Now consider: you drag the tuner box to a different signal entirely. Should the
symbol period be re-estimated? **Absolutely yes** — the old value is meaningless.

The tool cannot tell these apart. The user can, trivially, and it costs them one
click to say so. Making the mode explicit and visible is what turns "helpful
defaults" into a controllable instrument. Exploration is a sequence of *held* and
*varied* quantities, and the tool has to know which is which.

## Auto must show its work

An estimator returns a value **and its evidence**. Clicking the `⟲` opens that
evidence as a view: the pulse-width histogram behind a symbol period, the
autocorrelation behind a baud rate, the amplitude bimodality behind a slicer
threshold, the occupancy curve behind a filter width.

In an exploratory tool the estimator's reasoning is data too, and often more
informative than its answer — a bimodal histogram with two nearly equal peaks tells
you something a single number cannot. Hiding it would make auto a black box in a tool
whose whole premise is that black boxes are the problem.

## Manifest surface

```yaml
params:
  - id: symbol_us
    type: float
    unit: µs
    auto:
      estimator: pulse_width_autocorr    # named, pluggable
      evidence: histogram                # opens as a view tab
    default: auto
    hot: true
```

A parameter with no `auto:` block is manual-only and shows no `⟲`. An estimator is
itself a plugin, so a third party can supply a better symbol-period guesser without
touching the slicer.

## Cost

- Two states per parameter to render, persist, and reason about.
- The re-derivation cascade needs care: an upstream change may re-derive a dozen
  downstream auto values at once, and doing that mid-drag would thrash. Auto values
  re-derive on gesture *end*, not continuously.
- Estimators can be wrong confidently. Mitigated by always showing the evidence, and
  by an estimator being able to return low confidence, which renders the value in the
  warning color rather than as fact.

## Consequence for the command log

Auto/manual state is part of a node's parameters, so it serializes into the project
file ([ADR-0009](0009-command-log.md)) and a handoff reproduces exactly which
quantities were held and which were free. That is most of what "reproducible
analysis" actually means.
