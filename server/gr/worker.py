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
  {"op": "tuner", "path", "format", "rate", "k0", "count", "taps", "decim", "offset"}
      -> {"ok", "bytes"}, then `count` complex64 on fd 3: the JS tuner's absolute output
         samples k0 .. k0+count-1, sample for sample and in the same phase
  {"op": "stereo", ...the FM demod's fields, "audio_decim", "mode", "deemph_us", "runin_s"}
      -> {"ok", "bytes"}, then 2*count float32: stereo frames k0 .. k0+count-1, L and R
         interleaved, at the FM rate / audio_decim
  {"op": "fm", ...the tuner's fields, "scale"}
      -> {"ok", "bytes"}, then `count` float32: the JS FM demod's outputs k0 .. k0+count-1,
         in hertz times `scale` (gain / deviation)
"""
import cmath
import json
import math
import os
import sys

from gnuradio import analog, blocks, fft, filter as grfilter, gr
from gnuradio.filter import firdes

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


def capture_source(path, fmt, start, count):
    """`count` complex samples of a capture from sample `start`, scaled as capture.js scales them."""
    if fmt == 'cf32':
        return [blocks.file_source(COMPLEX, path, False, start, count)]
    if fmt == 'cs16':
        src = blocks.file_source(gr.sizeof_short, path, False, start * 2, count * 2)
        return [src, blocks.interleaved_short_to_complex(False, False, 32768.0)]
    if fmt == 'cu8':
        src = blocks.file_source(1, path, False, start * 2, count * 2)
        return [src, blocks.uchar_to_float(), blocks.add_const_ff(-127.5),
                blocks.multiply_const_ff(1 / 127.5), 'deinterleave']
    raise ValueError(f'no GNU Radio source for {fmt} yet')


def tuner_chain(tb, req, k0, count):
    """Blocks producing the JS tuner's absolute outputs k0 .. k0+count-1; returns the last block.

    capture.js's tuner makes absolute output k from inputs k*decim - ntaps .. k*decim - 1, with
    its mixer's phase referenced to the capture's sample 0 (engine.js, `_readIQ`). GNU Radio's
    freq_xlating_fir_filter_ccf starts with ntaps-1 zeros of history and references its mixer
    to the first sample it is fed, plus half the filter. So the input starts early enough that
    the first `skip` outputs, the ones made partly of that history, can be discarded, and the
    result is turned by the difference in phase reference. Measured to agree with the JS tuner
    at correlation 1.000000 (web/test/grtuner.test.mjs).
    """
    fs, decim = float(req['rate']), int(req['decim'])
    taps = [float(t) for t in req['taps']]
    nt, f = len(taps), float(req['offset'])
    skip = -(-(nt - 1) // decim)
    start = k0 * decim - 1 - skip * decim
    # Two decimation periods more than the arithmetic says: GNU Radio's decimating filter
    # can produce one output fewer than (n - ntaps) / decim suggests, depending on phase,
    # and the caller's `head` cuts the output at exactly what it promised either way.
    need = (skip + count - 1) * decim + nt + 2 * decim
    # A reply promises a byte count before the flowgraph runs, so a span that runs off
    # either end of the file is refused here rather than delivered short.
    per = {'cf32': 8, 'cs16': 4, 'cu8': 2}.get(req['format'], 0)
    have = os.path.getsize(req['path']) // per if per else 0
    if start < 0 or start + need > have:
        raise ValueError(f'span {start}+{need} is outside the capture (0..{have})')
    turn_by = -2 * math.pi * math.fmod(f * (start - (nt - 1) / 2), fs) / fs
    chain = capture_source(req['path'], req['format'], start, need)
    prev = chain[0]
    for blk in chain[1:]:
        if blk == 'deinterleave':
            de = blocks.deinterleave(gr.sizeof_float)
            to_c = blocks.float_to_complex()
            tb.connect(prev, de)
            tb.connect((de, 0), (to_c, 0))
            tb.connect((de, 1), (to_c, 1))
            prev = to_c
        else:
            tb.connect(prev, blk)
            prev = blk
    xl = grfilter.freq_xlating_fir_filter_ccf(decim, taps, f, fs)
    drop = blocks.skiphead(COMPLEX, skip)
    turn = blocks.multiply_const_cc(cmath.exp(1j * turn_by))
    tb.connect(prev, xl, drop, turn)
    return turn


def finish(tb, last, itemsize, count):
    """`last -> head(count) -> data pipe`, promised, run, and the promise kept."""
    cut = blocks.head(itemsize, count)
    sink = blocks.file_descriptor_sink(itemsize, os.dup(DATA_FD))
    tb.connect(last, cut, sink)
    reply({'ok': True, 'bytes': count * itemsize})
    tb.run()
    keep_promise(cut, count, itemsize)


def op_tuner(req):
    """The JS tuner's absolute outputs k0 .. k0+count-1, sample for sample and in phase."""
    tb = gr.top_block()
    count = int(req['count'])
    finish(tb, tuner_chain(tb, req, int(req['k0']), count), COMPLEX, count)


def op_fm(req):
    """The JS FM demod's outputs k0 .. k0+count-1: the tuner, then quadrature_demod_cf.

    The JS discriminator makes output k from tuner outputs k-1 and k, in hertz, scaled by
    gain / deviation. quadrature_demod_cf starts with one zero of history, so its first output
    pairs that zero with its first input and is discarded; fed the tuner from k0-1, its next
    output is the JS demod's k0. Its gain carries the radians-to-hertz and the scaling.
    Measured to agree with the JS demod to 3e-7 rms (web/test/grfm.test.mjs).
    """
    tb = gr.top_block()
    count = int(req['count'])
    finish(tb, fm_chain(tb, req, int(req['k0']), count), gr.sizeof_float, count)


def keep_promise(cut, count, itemsize):
    """The reply promised `count` items. If the flowgraph made fewer, pad with zeros so the
    data pipe stays in step, and say so on stderr: a short read would otherwise leave the
    server waiting for bytes that are never coming."""
    made = cut.nitems_written(0)
    if made < count:
        sys.stderr.write(f'short by {count - made} items; padded\n')
        os.write(DATA_FD, bytes((count - made) * itemsize))


def fm_chain(tb, req, k0, count):
    """Blocks producing the JS FM demod's outputs k0 .. k0+count-1; returns the last block."""
    tuned = tuner_chain(tb, req, k0 - 1, count + 1)
    fs_out = float(req['rate']) / int(req['decim'])
    demod = analog.quadrature_demod_cf(fs_out / (2 * math.pi) * float(req['scale']))
    drop = blocks.skiphead(gr.sizeof_float, 1)
    tb.connect(tuned, demod, drop)
    return drop


def op_stereo(req):
    """Stereo frames k0 .. k0+count-1 from the FM demod, interleaved L, R.

    GNU Radio's own blocks, arranged as its wfm_rcv_pll arranges them: a complex band-pass
    on the 19 kHz pilot, a PLL locked to it, the PLL squared for a 38 kHz reference, L-R
    mixed down by it, both paths low-passed and decimated, the matrix, de-emphasis. Not
    wfm_rcv_pll itself, because it demodulates FM on its own and cannot decode as mono; here
    the FM demod is SDR Flex's node and mono is a decision the pilot evidence makes.

    Frame k is centered on FM sample k*decim, as the JS decoder's is. The filters' delays are
    known from their lengths, so the input starts early by those, plus a run-in for the PLL
    to lock, and the outputs made before it are discarded.
    """
    count, k0, d = int(req['count']), int(req['k0']), int(req['audio_decim'])
    fs = float(req['rate']) / int(req['decim'])          # the FM demod's rate
    mono = req.get('mode') == 'mono'
    tau = float(req.get('deemph_us', 75)) * 1e-6
    win = fft.window.WIN_HAMMING
    lpf = firdes.low_pass(1.0, fs, 15000, 1500, win, 6.76)
    d_lpf = (len(lpf) - 1) // 2
    if mono:
        delay = d_lpf
    else:
        pilot = firdes.complex_band_pass(1.0, fs, 18980, 19020, 1500, win, 6.76)
        carrier = firdes.band_pass(-2.0, fs, 37600, 38400, 400, win, 6.76)
        samp_delay = (len(pilot) - 1) // 2 + (len(carrier) - 1) // 2
        delay = d_lpf + samp_delay
    runin = int(float(req.get('runin_s', 0.1)) * fs)
    skip = -(-(delay + runin) // d)
    start = k0 * d + delay - skip * d                      # FM sample the input starts at
    n_in = (skip + count) * d + len(lpf) + 2 * d
    tb = gr.top_block()
    mpx = fm_chain(tb, req, start, n_in)
    mono_lpf = grfilter.fft_filter_fff(d, lpf, 1)
    if mono:
        tb.connect(mpx, mono_lpf)
        left = right = mono_lpf
        add = sub = None
    else:
        pilot_bpf = grfilter.fir_filter_fcc(1, pilot)
        pll = analog.pll_refout_cc(0.001, 2 * math.pi * 19200 / fs, 2 * math.pi * 18800 / fs)
        square = blocks.multiply_cc(1)
        imag = blocks.complex_to_imag(1)
        carrier_bpf = grfilter.fft_filter_fff(1, carrier, 1)
        delayed = blocks.delay(gr.sizeof_float, samp_delay)
        mix = blocks.multiply_ff(1)
        diff_lpf = grfilter.fft_filter_fff(d, lpf, 1)
        tb.connect(mpx, pilot_bpf, pll)
        tb.connect(pll, (square, 0)); tb.connect(pll, (square, 1))
        tb.connect(square, imag, carrier_bpf, (mix, 1))
        tb.connect(mpx, delayed)
        tb.connect(delayed, (mix, 0))
        tb.connect(delayed, mono_lpf)
        tb.connect(mix, diff_lpf)
        add, sub = blocks.add_ff(1), blocks.sub_ff(1)
        tb.connect(mono_lpf, (add, 0)); tb.connect(diff_lpf, (add, 1))
        tb.connect(mono_lpf, (sub, 0)); tb.connect(diff_lpf, (sub, 1))
        left, right = add, sub
    weave = blocks.interleave(gr.sizeof_float, 1)
    for port, side in enumerate((left, right)):
        last = side
        if tau > 0:
            emph = analog.fm_deemph(fs=fs / d, tau=tau)
            tb.connect(side, emph)
            last = emph
        tb.connect(last, (weave, port))
    drop = blocks.skiphead(gr.sizeof_float, 2 * skip)
    tb.connect(weave, drop)
    finish(tb, drop, gr.sizeof_float, 2 * count)


OPS = {'ping': op_ping, 'tone': op_tone, 'tuner': op_tuner, 'fm': op_fm, 'stereo': op_stereo}


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
