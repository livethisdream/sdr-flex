#!/usr/bin/env python3
"""Spike: a persistent GNU Radio worker driven over stdin/stdout.

One JSON request per line in; one JSON header line out, followed by `bytes` of raw
float32 when the reply carries samples. The process stays up, so the cost of importing
GNU Radio and of the first flowgraph is paid once rather than per request.

Requests:
  {"op": "open", "path": ..., "rate": ...}
  {"op": "block", "center": Hz, "t0": s, "seconds": s, "margin": s}
      -> interleaved L/R float32 at 50 kS/s from tuner -> wfm_rcv_pll
  {"op": "live", "center": Hz, "t0": s}          start a throttled, running chain
  {"op": "retune", "center": Hz}                 -> how long until the output reflects it
  {"op": "stop"}
"""
import json, sys, time
import numpy as np
from gnuradio import gr, blocks, analog, filter as grfilter
from gnuradio.filter import firdes

out = sys.stdout.buffer
state = {}


def reply(head, payload=None):
    if payload is not None:
        head['bytes'] = payload.nbytes
    out.write((json.dumps(head) + '\n').encode())
    if payload is not None:
        out.write(payload.tobytes())
    out.flush()


def receiver(center):
    fs = state['rate']
    decim = 2
    taps = firdes.low_pass(1.0, fs, 100e3, 25e3)
    xl = grfilter.freq_xlating_fir_filter_ccf(decim, taps, center, fs)
    rx = analog.wfm_rcv_pll(demod_rate=fs / decim, audio_decimation=5, deemph_tau=75e-6)
    return xl, rx


def op_block(req):
    fs, iq = state['rate'], state['iq']
    margin = req.get('margin', 0.03)
    n0 = max(0, int((req['t0'] - margin) * fs))
    n = int((req['seconds'] + 2 * margin) * fs)
    t = time.perf_counter()
    tb = gr.top_block()
    src = blocks.vector_source_c(np.asarray(iq[n0:n0 + n]), False)
    xl, rx = receiver(req['center'])
    l, r = blocks.vector_sink_f(), blocks.vector_sink_f()
    tb.connect(src, xl, rx)
    tb.connect((rx, 0), l)
    tb.connect((rx, 1), r)
    tb.run()
    L, R = np.array(l.data(), np.float32), np.array(r.data(), np.float32)
    k = int(margin * 50_000)
    L, R = L[k:len(L) - k], R[k:len(R) - k]
    lr = np.empty(2 * len(L), np.float32)
    lr[0::2], lr[1::2] = L, R
    reply({'ok': True, 'ms': (time.perf_counter() - t) * 1000, 'frames': len(L), 'rate': 50_000}, lr)


def op_live(req):
    fs, iq = state['rate'], state['iq']
    n0 = int(req['t0'] * fs)
    tb = gr.top_block()
    src = blocks.vector_source_c(np.asarray(iq[n0:n0 + int(8 * fs)]), True)
    thr = blocks.throttle(gr.sizeof_gr_complex, fs)
    xl, rx = receiver(req['center'])
    # The level of the left channel, smoothed over ~10 ms: what a meter on screen would read.
    sq = blocks.multiply_ff()
    avg = blocks.moving_average_ff(500, 1 / 500)
    probe = blocks.probe_signal_f()
    tb.connect(src, thr, xl, rx)
    tb.connect((rx, 0), (sq, 0)); tb.connect((rx, 0), (sq, 1))
    tb.connect(sq, avg, probe)
    tb.connect((rx, 1), blocks.null_sink(gr.sizeof_float))
    tb.start()
    time.sleep(1.5)
    state.update(tb=tb, xl=xl, probe=probe)
    reply({'ok': True, 'level': probe.level()})


def op_retune(req):
    probe, xl = state['probe'], state['xl']
    before = probe.level()
    t = time.perf_counter()
    xl.set_center_freq(req['center'])
    # Poll the meter until it has moved most of the way to its new level.
    seen = []
    while time.perf_counter() - t < 1.0:
        v = probe.level()
        seen.append(((time.perf_counter() - t) * 1000, v))
        time.sleep(0.0005)
    settled = seen[-1][1]
    target = before + 0.9 * (settled - before)
    hit = next((ms for ms, v in seen if (v - target) * (settled - before) >= 0), None)
    reply({'ok': True, 'before': before, 'after': settled, 'ms_to_90pct': hit})


def main():
    for line in sys.stdin:
        req = json.loads(line)
        try:
            if req['op'] == 'open':
                state['rate'] = float(req['rate'])
                state['iq'] = np.memmap(req['path'], dtype=np.complex64, mode='r')
                reply({'ok': True, 'seconds': len(state['iq']) / state['rate']})
            elif req['op'] == 'block':
                op_block(req)
            elif req['op'] == 'live':
                op_live(req)
            elif req['op'] == 'retune':
                op_retune(req)
            elif req['op'] == 'stop':
                if 'tb' in state:
                    state['tb'].stop(); state['tb'].wait()
                reply({'ok': True})
                return
        except Exception as e:  # a spike reports, it does not crash the driver
            reply({'ok': False, 'error': repr(e)})


if __name__ == '__main__':
    main()
