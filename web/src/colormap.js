// Perceptually uniform colormaps. Jet is included but labelled legacy: it invents
// false edges at cyan and yellow and hides real structure in the green.

const STOPS = {
  Viridis: [[68,1,84],[59,82,139],[33,145,140],[94,201,98],[253,231,37]],
  Inferno: [[0,0,4],[87,16,110],[188,55,84],[249,142,9],[252,255,164]],
  Magma:   [[0,0,4],[81,18,124],[183,55,121],[252,137,97],[252,253,191]],
  Cividis: [[0,32,76],[60,84,136],[124,123,120],[192,168,98],[255,221,41]],
  'Jet (legacy)': [[0,0,131],[0,60,255],[0,255,255],[255,255,0],[255,0,0],[128,0,0]],
};

export const COLORMAPS = Object.keys(STOPS);

/** 256-entry RGB lookup table as Uint8Array(256*3). */
export function lut(name) {
  const s = STOPS[name] || STOPS.Viridis;
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
  const s = STOPS[name] || STOPS.Viridis;
  return `linear-gradient(to top, ${s.map((c) => `rgb(${c[0]},${c[1]},${c[2]})`).join(',')})`;
}
