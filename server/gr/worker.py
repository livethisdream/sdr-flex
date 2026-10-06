#!/usr/bin/env python3
"""The GNU Radio worker: one per session (ADR-0003), driven by the server (ADR-0044).

Control is JSON, one request per line on stdin and one reply per line on stdout, in order;
anything GNU Radio itself prints is moved to stderr so it cannot corrupt a reply.
Samples never pass through Python (ADR-0014): a flowgraph that produces them ends in a C++
`file_descriptor_sink` writing to the data pipe the server opened as fd 3, and the reply says
how many bytes to read from it. Python builds and steers flowgraphs and does nothing else.

Requests:
  {"op": "ping"}                                  -> {"ok", "gnuradio"}
  {"op": "tone", "hz", "rate", "count"}           -> {"ok", "bytes"}, then count complex64 on fd 3
                                                     (a known signal, for testing the data path)
"""
import json
import os
import sys

from gnuradio import analog, blocks, gr

DATA_FD = int(os.environ.get('SDRFLEX_GR_DATA_FD', '3'))
COMPLEX = gr.sizeof_gr_complex

# GNU Radio's C++ prints to fd 1 on its own (the first flowgraph announces its buffer
# allocator, "vmcircbuf_..."), and fd 1 is the control channel. So replies keep a private
# copy of it, and fd 1 itself is pointed at stderr, where the server logs such lines.
CONTROL = os.fdopen(os.dup(1), 'w', buffering=1)
os.dup2(2, 1)


def reply(obj):
    CONTROL.write(json.dumps(obj) + '\n')
    CONTROL.flush()


def to_pipe(src, itemsize, count, *chain):
    """Run `src -> *chain -> head(count) -> data pipe` to completion; the bytes it wrote."""
    tb = gr.top_block()
    head = blocks.head(itemsize, count)
    # A duplicate, because the sink closes its descriptor when it is destroyed and the pipe
    # has to outlive every flowgraph.
    sink = blocks.file_descriptor_sink(itemsize, os.dup(DATA_FD))
    tb.connect(src, *chain, head, sink)
    tb.run()
    return count * itemsize


def op_ping(_req):
    return {'ok': True, 'gnuradio': gr.version()}


def op_tone(req):
    rate, count = float(req['rate']), int(req['count'])
    src = analog.sig_source_c(rate, analog.GR_COS_WAVE, float(req['hz']), 1.0, 0)
    # The reply goes first, so the reader knows how much is coming before it arrives.
    reply({'ok': True, 'bytes': count * COMPLEX})
    to_pipe(src, COMPLEX, count)
    return None


OPS = {'ping': op_ping, 'tone': op_tone}


def main():
    for line in sys.stdin:
        try:
            req = json.loads(line)
            out = OPS[req['op']](req)
        except Exception as e:  # report it and keep serving: one bad request is not the session
            out = {'ok': False, 'error': f'{type(e).__name__}: {e}'}
        if out is not None:
            reply(out)


if __name__ == '__main__':
    main()
