# Separation of each decoder on a stereo test signal in two pilot/subcarrier conventions.
import numpy as np, json, subprocess, sys
from gnuradio import gr, blocks, analog
FS, N = 250_000, 250_000
t = np.arange(N) / FS
L, R = np.sin(2*np.pi*400*t), np.sin(2*np.pi*3000*t)
def mpx(conv):
    f = np.sin if conv == 'standard (sin/sin)' else np.cos
    return 0.45*(L+R)/2 + 0.09*f(2*np.pi*19000*t) + 0.45*(L-R)/2*f(2*np.pi*38000*t)
def amp(x, fs, hz, pad):
    x = x[pad:len(x)-pad]; n = np.arange(len(x)); a = 2*np.pi*hz*n/fs
    return 2*abs(np.sum(x*np.exp(-1j*a)))/len(x)
def sep(l, r, fs):
    pad = int(0.1*fs)
    return min(20*np.log10(amp(l,fs,400,pad)/amp(l,fs,3000,pad)), 20*np.log10(amp(r,fs,3000,pad)/amp(r,fs,400,pad)))
out = {}
for conv in ['standard (sin/sin)', 'sigid (cos/cos)']:
    m = mpx(conv)
    iq = np.exp(1j*2*np.pi*75_000*np.cumsum(m)/FS).astype(np.complex64)
    tb = gr.top_block(); src = blocks.vector_source_c(iq, False)
    rx = analog.wfm_rcv_pll(demod_rate=FS, audio_decimation=5, deemph_tau=75e-6)
    l, r = blocks.vector_sink_f(), blocks.vector_sink_f()
    tb.connect(src, rx); tb.connect((rx,0), l); tb.connect((rx,1), r); tb.run()
    out[conv] = {'gnuradio_db': round(float(sep(np.array(l.data()), np.array(r.data()), 50_000)), 1)}
    np.asarray(m, np.float32).tofile(f'/tmp/spike/mpx_{conv.split()[0]}.f32')
print(json.dumps(out))
