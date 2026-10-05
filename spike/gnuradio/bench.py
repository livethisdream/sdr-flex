#!/usr/bin/env python3
"""Spike: can GNU Radio be SDR Flex's engine within its latency budgets?

Measures the same chain the JS engine runs for a broadcast station — tuner, FM demod,
stereo decode — on a real capture, three ways:

  A. on demand: a fresh flowgraph over one 0.25 s block (+30 ms margins), timed end to
     end. This is the shape scrubbing and the block cache need.
  B. streaming: one long-running flowgraph over 20 s of input, as a multiple of real time.
  C. interactivity: a retune on a running flowgraph (set_center_freq), and a structural
     change (lock, disconnect/connect a block, unlock).

    python3 bench.py <capture.sigmf-data> <sample_rate> <offset_hz>
"""
import sys, time, statistics
import numpy as np
from gnuradio import gr, blocks, analog, filter as grfilter
from gnuradio.filter import firdes

path, FS, OFF = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
iq = np.memmap(path, dtype=np.complex64, mode='r')
DECIM = 2                      # 500 kS/s -> 250 kS/s, as the JS tuner chooses for 200 kHz
RATE = FS / DECIM
TAPS = firdes.low_pass(1.0, FS, 100e3, 25e3)
BLOCK_S, MARGIN_S = 0.25, 0.03

def chain(tb, src, sink_l, sink_r, center=OFF):
    xl = grfilter.freq_xlating_fir_filter_ccf(DECIM, TAPS, center, FS)
    rx = analog.wfm_rcv_pll(demod_rate=RATE, audio_decimation=5, deemph_tau=75e-6)    # FM + pilot PLL + stereo, 50 kS/s out
    tb.connect(src, xl, rx)
    tb.connect((rx, 0), sink_l)
    tb.connect((rx, 1), sink_r)
    return xl, rx

def on_demand(t0):
    n0 = int((t0 - MARGIN_S) * FS); n = int((BLOCK_S + 2 * MARGIN_S) * FS)
    t = time.perf_counter()
    tb = gr.top_block()
    src = blocks.vector_source_c(iq[n0:n0 + n].tolist() if False else np.asarray(iq[n0:n0 + n]), False)
    l, r = blocks.vector_sink_f(), blocks.vector_sink_f()
    chain(tb, src, l, r)
    tb.run()
    out = len(l.data())
    return (time.perf_counter() - t) * 1000, out

print(f"GNU Radio {gr.version()}  capture {len(iq)/FS:.1f} s at {FS/1e3:.0f} kS/s  offset {OFF/1e3:.0f} kHz")

# A. on demand, 12 blocks across the capture (first one includes any warm-up)
times = []
for k in range(12):
    ms, out = on_demand(5 + k * 6.0)
    times.append(ms)
print(f"A. on-demand 0.25 s block: first {times[0]:.0f} ms, then median {statistics.median(times[1:]):.0f} ms "
      f"(min {min(times[1:]):.0f}, max {max(times[1:]):.0f}), {out} stereo frames out")

# B. streaming: 20 s through one flowgraph, as fast as it will go
n = int(20 * FS); n0 = int(10 * FS)
tb = gr.top_block()
src = blocks.vector_source_c(np.asarray(iq[n0:n0 + n]), False)
l, r = blocks.null_sink(gr.sizeof_float), blocks.null_sink(gr.sizeof_float)
chain(tb, src, l, r)
t = time.perf_counter(); tb.run(); el = time.perf_counter() - t
print(f"B. streaming: 20 s of input in {el*1000:.0f} ms = {20/el:.0f}x real time")

# C. interactivity on a running, throttled flowgraph
tb = gr.top_block()
src = blocks.vector_source_c(np.asarray(iq[n0:n0 + int(5 * FS)]), True)
thr = blocks.throttle(gr.sizeof_gr_complex, FS)
probe = blocks.probe_signal_f()
l = blocks.null_sink(gr.sizeof_float)
xl = grfilter.freq_xlating_fir_filter_ccf(DECIM, TAPS, OFF, FS)
rx = analog.wfm_rcv_pll(demod_rate=RATE, audio_decimation=5, deemph_tau=75e-6)
tb.connect(src, thr, xl, rx); tb.connect((rx, 0), probe); tb.connect((rx, 1), l)
tb.start(); time.sleep(1.0)
sets = []
for k in range(20):
    t = time.perf_counter(); xl.set_center_freq(OFF + (k % 2) * 10e3); sets.append((time.perf_counter() - t) * 1e6)
print(f"C1. retune call (set_center_freq): median {statistics.median(sets):.0f} µs")
# structural: swap in an extra block between the tuner and the receiver
swaps = []
for k in range(5):
    t = time.perf_counter()
    tb.lock()
    tb.disconnect(xl, rx)
    gain = blocks.multiply_const_cc(1.0)
    tb.connect(xl, gain, rx)
    tb.unlock()
    swaps.append((time.perf_counter() - t) * 1000)
    tb.lock(); tb.disconnect(xl, gain); tb.disconnect(gain, rx); tb.connect(xl, rx); tb.unlock()
print(f"C2. structural change (lock, insert a block, unlock): median {statistics.median(swaps):.1f} ms, max {max(swaps):.1f} ms")
# buffer latency: how much audio sits in flight between input and output
print(f"C3. default buffer: {gr.prefs().get_long('DEFAULT', 'buffer_size', 32768) if hasattr(gr.prefs(), 'get_long') else 'n/a'} bytes per edge")
tb.stop(); tb.wait()
