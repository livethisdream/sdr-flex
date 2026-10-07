#!/usr/bin/env python3
"""A decoder's input, made by GNU Radio (ADR-0013, ADR-0044).

An external decoder wants its samples at its own rate and in its own format: multimon-ng
reads 16-bit audio at 22 050 S/s, rtl_433 reads unsigned 8-bit IQ at 250 kS/s. This is the
flowgraph between SDR Flex and the program: float32 samples in on stdin, at the rate the
graph made them, resampled by GNU Radio's polyphase arbitrary resampler, scaled, converted,
and written to fd 3, which the server connects to the decoder's stdin. It runs as long as its
input does, so a decoder fed while the capture plays sees one continuous stream, with the
resampler's state carried from one feed to the next: there is no seam to cut a character or a
packet in two. Fed a whole span and closed, it is the one-shot conversion as well.

GNU Radio's C++ blocks read and write the pipes; Python builds the flowgraph and does nothing
else (ADR-0014).

  feed.py '{"kind": "real"|"iq", "from": rate, "to": rate, "format": ..., "gain": g, "wav": bool}'
"""
import json
import math
import os
import struct
import sys

from gnuradio import blocks, filter as grfilter, gr
from gnuradio.filter import pfb

# GNU Radio prints to fd 1 on its own; nothing here is a reply, so it all goes to stderr.
os.dup2(2, 1)

OUT_FD = 3
REAL_FORMATS = {'s16', 'f32'}
IQ_FORMATS = {'cf32', 'cs16', 'cs8', 'cu8'}


def wav_header(rate, fmt):
    """A streaming RIFF header: the length is unknown, so it says as much as a reader allows."""
    bits = 32 if fmt == 'f32' else 16
    code = 3 if fmt == 'f32' else 1
    rate = int(round(rate))
    return (b'RIFF' + struct.pack('<I', 0xFFFFFFFF) + b'WAVE' + b'fmt ' +
            struct.pack('<IHHIIHH', 16, code, 1, rate, rate * bits // 8, bits // 8, bits) +
            b'data' + struct.pack('<I', 0xFFFFFFFF))


def resampler(src, dst, iq):
    """GNU Radio's rational resampler when the ratio is a fraction with small terms, which is
    exact; the polyphase arbitrary resampler otherwise: a channel's rate is the capture's divided
    by its decimation, 5208.33 S/s as often as a round number."""
    if os.environ.get('SDRFLEX_FEED_RESAMPLER') != 'arb' and float(src).is_integer() and float(dst).is_integer():
        g = math.gcd(int(src), int(dst))
        interp, decim = int(dst) // g, int(src) // g
        if max(interp, decim) <= 1000:
            return (grfilter.rational_resampler_ccc if iq else grfilter.rational_resampler_fff)(interp, decim)
    r = dst / src
    return pfb.arb_resampler_ccf(r) if iq else pfb.arb_resampler_fff(r)


def build(spec):
    kind, fmt = spec['kind'], spec['format']
    src_rate, dst_rate = float(spec['from']), float(spec['to'])
    gain = float(spec.get('gain', 1.0))
    iq = kind == 'iq'
    if (fmt in IQ_FORMATS) != iq:
        raise ValueError(f'no conversion from {kind} to {fmt}')

    tb = gr.top_block()
    item = gr.sizeof_gr_complex if iq else gr.sizeof_float
    chain = [blocks.file_descriptor_source(item, 0, False)]
    if abs(src_rate - dst_rate) / dst_rate > 0.001:
        chain.append(resampler(src_rate, dst_rate, iq))
    if gain != 1.0:
        chain.append(blocks.multiply_const_cc(gain) if iq else blocks.multiply_const_ff(gain))

    sink = blocks.file_descriptor_sink
    if fmt in ('f32', 'cf32'):
        chain.append(sink(item, OUT_FD))
    elif fmt == 's16':
        chain += [blocks.float_to_short(1, 32767), sink(gr.sizeof_short, OUT_FD)]
    elif fmt == 'cs16':
        chain += [blocks.complex_to_interleaved_short(False, 32767), sink(gr.sizeof_short, OUT_FD)]
    elif fmt == 'cs8':
        chain += [blocks.complex_to_interleaved_char(False, 127), sink(1, OUT_FD)]
    elif fmt == 'cu8':
        # capture.js reads cu8 as (v - 127.5) / 127.5, so this is its inverse: I and Q
        # interleaved as floats, scaled and offset, then clamped into a byte.
        c2f, weave = blocks.complex_to_float(), blocks.interleave(gr.sizeof_float, 1)
        tb.connect(*chain, c2f)
        tb.connect((c2f, 0), (weave, 0))
        tb.connect((c2f, 1), (weave, 1))
        tb.connect(weave, blocks.multiply_const_ff(127.5), blocks.add_const_ff(127.5),
                   blocks.float_to_uchar(), sink(1, OUT_FD))
        return tb
    else:
        raise ValueError(f'no conversion to {fmt}')
    tb.connect(*chain)
    return tb


def main():
    spec = json.loads(sys.argv[1])
    tb = build(spec)
    if spec.get('wav'):
        os.write(OUT_FD, wav_header(spec['to'], spec['format']))
    tb.run()


if __name__ == '__main__':
    main()
