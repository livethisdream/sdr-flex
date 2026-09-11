#!/usr/bin/env python3
# The transmitter half, used to build the golden capture and nothing else.
#
# ADR-0025 wants a fixture nobody transmitted, regenerable, with its provenance written
# down. Every other fixture in this repository is synthesized by `fixtures/make.mjs` from
# a fixed seed, and this one cannot be: a LoRa frame is chirp spread spectrum wrapped in
# whitening, Hamming coding, interleaving, a Gray map, a header and a CRC, and writing
# that in JavaScript to test somebody else's decoder would be testing our reimplementation
# of it. So the encoder is the decoder's own, which also makes the check two-sided — if
# either half drifts the other stops agreeing.
#
# Deterministic: no noise, no channel model, one payload, a fixed frame count.
#
#   python3.12 lora-tx.py --text "…" --out lora.cf32 --frames 3

import argparse
import os
import sys
import time

import pmt
from gnuradio import gr, blocks
from gnuradio import lora_sdr

p = argparse.ArgumentParser()
p.add_argument('--text', required=True)
p.add_argument('--out', required=True)
p.add_argument('--rate', type=float, default=250_000)
p.add_argument('--sf', type=int, default=7)
p.add_argument('--bw', type=int, default=125_000)
p.add_argument('--cr', type=int, default=1)
p.add_argument('--frames', type=int, default=3)
p.add_argument('--every-ms', type=int, default=120)
a = p.parse_args()

rate = int(a.rate)
tb = gr.top_block('lora tx', catch_exceptions=False)
tx = lora_sdr.lora_sdr_lora_tx(bw=a.bw, cr=a.cr, has_crc=True, impl_head=False,
                               samp_rate=rate, sf=a.sf, ldro_mode=2,
                               frame_zero_padd=1280, sync_word=[0x12])
# A strobe rather than a file source: the transmitter takes a message, and one payload
# repeated is what a beacon looks like anyway.
strobe = blocks.message_strobe(pmt.intern(a.text), a.every_ms)
head = blocks.head(gr.sizeof_gr_complex, int(rate * a.every_ms / 1000.0 * a.frames))
sink = blocks.file_sink(gr.sizeof_gr_complex, a.out, False)
tb.msg_connect((strobe, 'strobe'), (tx, 'in'))
tb.connect(tx, head, sink)

# The strobe never stops on its own, so waiting on the flowgraph would wait forever.
# The head block decides when there is enough; watch the file it is filling and stop.
want_bytes = int(rate * a.every_ms / 1000.0 * a.frames) * 8      # gr_complex is 8 bytes
tb.start()
deadline = time.time() + 60
while time.time() < deadline:
    time.sleep(0.05)
    try:
        if os.path.getsize(a.out) >= want_bytes:
            break
    except OSError:
        pass
tb.stop()
tb.wait()
print(f'wrote {a.out}: SF{a.sf}, BW {a.bw // 1000} kHz, {a.frames} frame(s) at {rate / 1000:.0f} kS/s',
      file=sys.stderr)
