// Perceptually uniform colormaps. Jet is included but labeled legacy: it invents
// false edges at cyan and yellow and hides real structure in the green.
//
// Every sequential map runs dark to bright, which is why a waterfall is dark whatever
// the rest of the interface is doing: the floor of the map *is* the background, and
// inverting it to suit a light theme would throw away the mapping people know. Paper
// is the one map built the other way round, for anyone who wants a light plot too —
// it is the choice, and the plot follows it rather than following the theme.
const STOPS = {
  Inferno: [[0,0,4],[87,16,110],[188,55,84],[249,142,9],[252,255,164]],
  Viridis: [[68,1,84],[59,82,139],[33,145,140],[94,201,98],[253,231,37]],
  Magma:   [[0,0,4],[81,18,124],[183,55,121],[252,137,97],[252,253,191]],
  Cividis: [[0,32,76],[60,84,136],[124,123,120],[192,168,98],[255,221,41]],
  Paper:   [[252,252,253],[186,206,222],[104,150,186],[42,80,132],[14,22,46]],
  'Jet (legacy)': [[0,0,131],[0,60,255],[0,255,255],[255,255,0],[255,0,0],[128,0,0]],
};

/**
 * The color of "nothing here" for a map — its first stop, which is what an unfilled
 * waterfall row already shows. The plot's background is this, so the trace above the
 * waterfall and the rows below it sit on one continuous surface.
 */
export function floorColor(name) {
  const c = (STOPS[name] || STOPS[DEFAULT_COLORMAP])[0];
  return { rgb: `rgb(${c[0]},${c[1]},${c[2]})`, r: c[0], g: c[1], b: c[2],
           // Rec. 709 luma, which is close enough to decide black text or white
           lum: (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255 };
}

export const COLORMAPS = Object.keys(STOPS);

/**
 * The one named here, and the one every fallback below reaches for.
 *
 * It was a literal in four places — three fallbacks in this file, the waterfall's own
 * constructor, and the viewport's defaults — and changing "the default colormap" meant
 * finding all five. One of them was missed, so the waterfall was built Viridis and only
 * became Inferno when something happened to set it.
 *
 * Inferno rather than Viridis, for a reason particular to a waterfall: its dark end is
 * nearly black, so an empty waterfall reads as empty and the first thing that is not
 * black is a signal. Viridis starts on a distinctly purple floor that a weak carrier has
 * to out-shout. Both are perceptually uniform and colorblind-safe, which is what usually
 * decides this and does not separate them here.
 */
export const DEFAULT_COLORMAP = 'Inferno';

/** 256-entry RGB lookup table as Uint8Array(256*3). */
export function lut(name) {
  const s = STOPS[name] || STOPS[DEFAULT_COLORMAP];
  const out = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * (s.length - 1);
    const k = Math.min(s.length - 2, Math.floor(x));
    const f = x - k;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(s[k][c] + (s[k + 1][c] - s[k][c]) * f);
  }
  return out;
}

export function cssGradient(name) {
  const s = STOPS[name] || STOPS[DEFAULT_COLORMAP];
  return `linear-gradient(to top, ${s.map((c) => `rgb(${c[0]},${c[1]},${c[2]})`).join(',')})`;
}
