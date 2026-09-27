// DTMF — the touch-tone digits, decoded off an audio stream.
//
// This ships for two reasons. It is useful on its own: a repeater, a scanner recording
// or a control tone burst is full of these, and reading them by ear is a party trick
// rather than a method. And it is the first plugin that reads `real` rather than
// `bytes`, which until recently no plugin could do — the runner fetched bytes whatever
// the manifest said, so a decoder like this one built a node and then reported "nothing
// upstream has produced bytes yet". The third argument to `decode` is what makes it
// possible: a decoder on samples cannot do arithmetic on time without the sample rate,
// and now it is told.
//
// Each digit is two sine tones at once, one from a low group and one from a high group,
// chosen so that no tone is a harmonic of any other — which is the whole design, because
// it makes a false detection off speech or music very unlikely. The grid is the keypad:
//
//            1209   1336   1477   1633 Hz
//     697      1      2      3      A
//     770      4      5      6      B
//     852      7      8      9      C
//     941      *      0      #      D
//
// Found with the Goertzel algorithm rather than an FFT. It is the right tool when you
// know the eight frequencies in advance: one recurrence per tone per sample, no buffer,
// no window, and no bins to interpolate between. Eight of them over a block is cheaper
// than one FFT of the same block and answers the only question being asked.

export const manifest = {
  id: 'ext.dtmf',
  name: 'DTMF',
  group: 'Decode',
  in: 'real',
  out: 'events',
  blurb: 'Touch-tone digits: two tones at once, read with eight Goertzel filters.',
  params: [
    // The shortest tone that counts as a keypress. ITU-T Q.24 says a receiver must
    // accept 40 ms and may reject 23 ms, so this is the standard's own floor rather
    // than a number picked to make a fixture pass.
    // Resolved to the nearest block, so the number reported on a record is what was
    // measured rather than what was asked for.
    { id: 'minMs', label: 'shortest tone', type: 'enum', default: 40, values: [20, 40, 70, 100] },
    // How much of a block's tone energy has to be in the two that were found. Eight
    // filters over noise all read about the same, so the ratio is near 2/8; over a real
    // pair it is near 1. Anywhere in the middle is the honest place for a threshold.
    { id: 'strength', label: 'tone purity', type: 'enum', default: 0.6,
      values: [0.4, 0.5, 0.6, 0.75, 0.9] },
  ],
};

const LOW = [697, 770, 852, 941];
const HIGH = [1209, 1336, 1477, 1633];
const KEYS = ['123A', '456B', '789C', '*0#D'];

// A tone must hold for a while to be a keypress, and the block is the resolution that
// is measured in. 12 ms is short enough that three of them fit inside the 40 ms the
// standard requires, and long enough that 697 Hz gets eight cycles to be sure about.
const BLOCK_MS = 12;

// The two tones of a pair are never meant to be far apart in level — a transmitter is
// allowed a few dB of "twist" and no more. Twenty dB is well past anything legitimate,
// and rejecting beyond it is what stops a single strong whistle plus a little noise in
// the other group from reading as a digit.
const MAX_TWIST = 100;

/**
 * One Goertzel filter over one block: the squared magnitude at `hz`.
 *
 * The coefficient is taken from the frequency directly rather than from the nearest FFT
 * bin. With blocks this short the bins are about 80 Hz apart and 697 does not land on
 * one; snapping to the nearest costs more than the leakage does.
 */
function goertzel(x, from, n, hz, rate) {
  const coeff = 2 * Math.cos((2 * Math.PI * hz) / rate);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = x[from + i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/** The strongest of a group, and how far clear of the next it is. */
function peak(x, from, n, freqs, rate) {
  let best = -1, at = 0, sum = 0;
  for (let i = 0; i < freqs.length; i++) {
    const m = goertzel(x, from, n, freqs[i], rate);
    sum += m;
    if (m > best) { best = m; at = i; }
  }
  return { at, mag: best, sum };
}

export function decode(samples, params = {}, info = {}) {
  const rate = info.sampleRate;
  // Said rather than guessed. A decoder on samples that assumes 8 kHz and is handed 48
  // reports every digit as a different one, which looks like a broken keypad rather
  // than like a missing number.
  if (!rate) return [{ text: 'DTMF needs to know the sample rate, and was not told one' }];

  const n = Math.min(info.count || samples.length, samples.length);
  const block = Math.round((rate * BLOCK_MS) / 1000);
  if (block < 64 || n < block) return [];

  const minMs = Number(params.minMs) || 40;
  const strength = Number(params.strength) || 0.6;
  // A tone is only ever seen on the block grid, so one that truly lasts `minMs` shows up
  // as somewhere between `minMs/BLOCK_MS` blocks and one fewer, depending on where it
  // starts. Requiring the larger count would reject a legitimate 40 ms tone about a
  // third of the time on alignment alone — and 40 ms is the shortest the standard says a
  // receiver must accept. So the rule is: keep it if it *could* have been long enough,
  // which is one block of slack, and report the measured length so the doubt is visible.
  const needBlocks = Math.max(1, Math.ceil(minMs / BLOCK_MS - 1));

  const out = [];
  let held = null, heldFrom = 0, heldBlocks = 0;

  const flush = (endBlock) => {
    if (held && heldBlocks >= needBlocks) {
      const t0 = (info.t0 || 0) + (heldFrom * block) / rate;
      out.push({ text: held, t: t0,
                 ms: +(((endBlock - heldFrom) * block * 1000) / rate).toFixed(1) });
    }
    held = null;
    heldBlocks = 0;
  };

  for (let b = 0, from = 0; from + block <= n; b++, from += block) {
    const lo = peak(samples, from, block, LOW, rate);
    const hi = peak(samples, from, block, HIGH, rate);
    const total = lo.sum + hi.sum;
    const pure = total > 0 ? (lo.mag + hi.mag) / total : 0;
    const twist = Math.max(lo.mag, hi.mag) / Math.max(1e-30, Math.min(lo.mag, hi.mag));
    const digit = pure >= strength && twist <= MAX_TWIST ? KEYS[lo.at][hi.at] : null;

    if (digit !== held) {
      flush(b);
      held = digit;
      heldFrom = b;
    }
    if (digit) heldBlocks++;
  }
  flush(Math.floor(n / block));
  return out;
}
