# ADR-0012: Display rendering is server-side, resolution-aware, and lossy

**Status:** Accepted

## Decision

The server, not the client, decides what the client can draw.

- FFT, windowing, and averaging happen server-side; the client receives magnitude bins.
- Time-series arrive as **min/max envelope pairs** decimated to the client's pixel width.
- Large media get a **multi-resolution pyramid** built on ingest; an overview of a 4 GB
  file is a pyramid read, not a 4 GB scan.
- **Zoom is a server query**, not a client-side transform: zooming re-requests the
  window at the new resolution.
- Display streams are **lossy, newest-wins**. A slow client drops frames and is told
  so via a gap in the sequence number. `events` streams are the exception — reliable
  and buffered, because a dropped decoded message is a lost result, not a dropped frame.

## Why

- Raw IQ cannot cross the wire at useful rates, and shouldn't: a 2048-pixel-wide
  waterfall needs 2048 numbers per row regardless of the source rate.
- Zoom-as-query is what makes UC-2.1 possible (instant overview of a huge file) and
  it composes with ADR-0005 — zooming into live history and into a file are the same
  operation, because both are backed by a medium.
- Lossy display is the only way to guarantee the invariant that keeps everything else
  honest: **the DSP path never blocks on the display path.** A stalled browser tab
  must not stall a decoder.

## Cost

- The client cannot re-render at a new zoom without a round trip. Mitigated by
  keeping the last few pyramid levels client-side, so small zooms are instant and only
  large jumps hit the server.
- Pyramid construction costs I/O and disk on ingest.
- The server needs to know the client's pixel geometry — an extra piece of state the
  client must keep current on resize.

## Would change our mind

If round-trip zoom feels bad even with client-side pyramid caching, push more levels
to the client. The split point is tunable; the direction (server owns the source of
truth for pixels) is not.
