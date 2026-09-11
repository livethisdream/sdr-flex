#!/usr/bin/env python3
# LoRa, by way of gr-lora_sdr.
#
# A flowgraph is a program: samples in on stdin, records out on stdout, one JSON object
# per line. That is the same contract rtl_433 and dump1090 already satisfy, which is why
# this needs no new machinery on the engine side — only a way to say that what has to be
# installed is a GNU Radio module rather than a binary on PATH (ADR-0013, ADR-0032).
#
# It is written by hand rather than exported from GNU Radio Companion on purpose. A .grc
# export carries a GUI, a throttle and a sample-rate variable that only make sense live;
# what is wanted here is the receive chain and nothing else.
#
#   python3.12 lora.py --rate 250000 --sf 7 --bw 125000 --cr 1
#
# stdin is complex float32, which is what the engine converts to.

import argparse
import json
import sys

from gnuradio import gr, blocks
from gnuradio import lora_sdr


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--rate', type=float, required=True)
    p.add_argument('--sf', type=int, default=7)            # spreading factor, 7..12
    p.add_argument('--bw', type=int, default=125_000)
    p.add_argument('--cr', type=int, default=1)            # coding rate 4/(4+cr)
    p.add_argument('--center', type=float, default=868_100_000)
    p.add_argument('--sync', type=lambda s: int(s, 0), default=0x12)
    p.add_argument('--crc', type=int, default=1)
    p.add_argument('--implicit-header', action='store_true')
    p.add_argument('--pay-len', type=int, default=255)
    a = p.parse_args()

    tb = gr.top_block('lora rx', catch_exceptions=False)
    src = blocks.file_descriptor_source(gr.sizeof_gr_complex, 0, False)
    rx = lora_sdr.lora_sdr_lora_rx(
        center_freq=int(a.center), bw=a.bw, cr=a.cr, has_crc=bool(a.crc),
        impl_head=a.implicit_header, pay_len=a.pay_len, samp_rate=int(a.rate),
        sf=a.sf, sync_word=[a.sync], soft_decoding=False, ldro_mode=2,
        # its own console printing off: this program's stdout is a record stream
        print_rx=[False, False])
    sink = blocks.message_debug()
    tb.connect(src, rx)
    tb.msg_connect((rx, 'out'), (sink, 'store'))
    tb.run()

    n = sink.num_messages()
    for i in range(n):
        msg = sink.get_message(i)
        payload = bytes(pmt_to_bytes(msg))
        print(json.dumps({
            'text': payload.decode('utf-8', 'replace'),
            'hex': payload.hex(),
            'bytes': len(payload),
            'sf': a.sf, 'bw': a.bw, 'cr': f'4/{4 + a.cr}',
        }), flush=True)
    print(f'{n} frame(s) at SF{a.sf}, BW {a.bw / 1000:.0f} kHz', file=sys.stderr)


def pmt_to_bytes(msg):
    """The payload out of gr-lora_sdr's message port, whichever shape it arrives in."""
    import pmt
    if pmt.is_pair(msg):
        vec = pmt.cdr(msg)
        if pmt.is_u8vector(vec):
            return pmt.u8vector_elements(vec)
    if pmt.is_u8vector(msg):
        return pmt.u8vector_elements(msg)
    if pmt.is_symbol(msg):
        return pmt.symbol_to_string(msg).encode()
    return str(msg).encode()


if __name__ == '__main__':
    main()
