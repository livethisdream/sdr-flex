# ADR-0008: SigMF is the native capture and annotation format

**Status:** Accepted

## Decision

SigMF is the first-class format for IQ input, for recordings we produce, and for
annotation round-tripping. Other formats (raw, WAV-IQ, vendor formats) are supported
via import shims that synthesize SigMF metadata.

## Why

- It is the only real interchange standard in the field, and it already has the
  fields we need: sample rate, center frequency, absolute start time, and a
  first-class annotation list with time-frequency extents.
- Its annotation model maps almost exactly onto ours (ADR-0007), so findings made in
  this tool are readable by other tools, and vice versa.
- Choosing a proprietary project format for captures would isolate the tool from the
  existing ecosystem for no benefit.

## Cost

- SigMF's metadata is coarser than our internal `StreamType` in places, so a lossless
  round trip needs a namespaced extension (`sdrflex:*`) for anything it can't express.
- Some captures in the wild have sloppy or wrong metadata; the import path needs to
  tolerate and let the user correct it.

## Note

The *project* file is separate and is not SigMF (see ADR-0009). SigMF describes the
signal; the project describes the analysis. Conflating them would make projects
un-diffable and captures un-shareable.
