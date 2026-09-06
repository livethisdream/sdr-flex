// WebGL2 waterfall: a ring-buffer texture of dB values, colored in the shader so
// the dB range and colormap are free to change every frame. Falls back to a 2D
// canvas so the page is never blank.

import { lut } from './colormap.js';

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = vec2(p.x*0.5+0.5, p.y*0.5+0.5); gl_Position = vec4(p,0.0,1.0); }`;

const FS = `#version 300 es
precision highp float;
in vec2 uv; out vec4 frag;
uniform sampler2D data;     // R32F, dB
uniform sampler2D cmap;     // 256x1 RGB
uniform float rows, writeRow, dbMin, dbMax, viewLo, viewHi;
void main(){
  // uv.y == 1 at top of screen == newest row
  float back = (1.0 - uv.y) * rows;
  float r = mod(writeRow - back, rows);
  // zoom is a view transform: the same rows, a narrower slice of them
  float x = viewLo + uv.x * (viewHi - viewLo);
  float db = texture(data, vec2(x, (r + 0.5) / rows)).r;
  float t = clamp((db - dbMin) / max(dbMax - dbMin, 0.001), 0.0, 1.0);
  frag = vec4(texture(cmap, vec2(t, 0.5)).rgb, 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

export class Waterfall {
  constructor(canvas, rows = 320) {
    this.canvas = canvas;
    this.rows = rows;
    this.bins = 0;
    this.writeRow = 0;
    this.filled = 0;          // rows of real history since the last clear
    this.dbMin = -74;
    this.dbMax = -18;
    this.viewLo = 0;
    this.viewHi = 1;
    this.gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
    if (this.gl) { try { this._initGL(); } catch (e) { this.gl = null; } }
    if (!this.gl) this._initFallback();
    this.setColormap('Viridis');
  }

  _initGL() {
    const gl = this.gl;
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    this.prog = prog;

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.uni = {
      rows: gl.getUniformLocation(prog, 'rows'),
      writeRow: gl.getUniformLocation(prog, 'writeRow'),
      dbMin: gl.getUniformLocation(prog, 'dbMin'),
      dbMax: gl.getUniformLocation(prog, 'dbMax'),
      viewLo: gl.getUniformLocation(prog, 'viewLo'),
      viewHi: gl.getUniformLocation(prog, 'viewHi'),
    };
    gl.uniform1i(gl.getUniformLocation(prog, 'data'), 0);
    gl.uniform1i(gl.getUniformLocation(prog, 'cmap'), 1);

    this.cmapTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.cmapTex);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.LINEAR);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
  }

  _initFallback() {
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.img = null;
    this.off = document.createElement('canvas');
    this.offCtx = this.off.getContext('2d', { alpha: false });
  }

  _ensure(bins) {
    if (bins === this.bins) return;
    this.bins = bins;
    this.writeRow = 0;
    this.filled = 0;
    if (this.gl) {
      const gl = this.gl;
      if (this.dataTex) gl.deleteTexture(this.dataTex);
      this.dataTex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.dataTex);
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
      const blank = new Float32Array(bins * this.rows).fill(-160);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, bins, this.rows, 0, gl.RED, gl.FLOAT, blank);
    } else {
      this.off.width = bins;
      this.off.height = this.rows;
      this.img = this.offCtx.createImageData(bins, this.rows);
      this._clearFallback();
    }
  }

  /** Unfilled rows read as the colormap floor, matching what the shader shows. */
  _clearFallback() {
    if (!this.img) return;
    const d = this.img.data;
    const r = this.cmapLut[0], g = this.cmapLut[1], b = this.cmapLut[2];
    for (let i = 0; i < d.length; i += 4) { d[i] = r; d[i+1] = g; d[i+2] = b; d[i+3] = 255; }
  }

  setColormap(name) {
    const first = !this.cmapLut;
    this.cmapName = name;
    this.cmapLut = lut(name);
    if (!first && !this.gl) this._clearFallback();
    if (this.gl) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.cmapTex);
      const rgba = new Uint8Array(256 * 4);
      for (let i = 0; i < 256; i++) {
        rgba[i*4] = this.cmapLut[i*3]; rgba[i*4+1] = this.cmapLut[i*3+1];
        rgba[i*4+2] = this.cmapLut[i*3+2]; rgba[i*4+3] = 255;
      }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    }
  }

  setRange(dbMin, dbMax) { this.dbMin = dbMin; this.dbMax = dbMax; }

  /** Visible slice of the span, as fractions. Zooming re-reads stored rows. */
  setViewRange(lo, hi) { this.viewLo = lo; this.viewHi = hi; }

  /** Forget the history. Another channel's rows are not this channel's past. */
  clear() {
    this.writeRow = 0;
    this.filled = 0;
    if (!this.bins) return;
    if (this.gl) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.dataTex);
      const blank = new Float32Array(this.bins * this.rows).fill(-160);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, this.bins, this.rows, 0, gl.RED, gl.FLOAT, blank);
    } else {
      this._clearFallback();
    }
  }

  push(row) {
    this._ensure(row.length);
    this.filled = Math.min(this.rows, this.filled + 1);
    if (this.gl) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.dataTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, this.writeRow, row.length, 1, gl.RED, gl.FLOAT, row);
      this.writeRow = (this.writeRow + 1) % this.rows;
    } else {
      const d = this.img.data, W = this.bins;
      d.copyWithin(W * 4, 0, W * 4 * (this.rows - 1));
      const span = Math.max(this.dbMax - this.dbMin, 0.001);
      for (let x = 0; x < W; x++) {
        let t = (row[x] - this.dbMin) / span;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const c = (t * 255) | 0, o = x * 4, s = c * 3;
        d[o] = this.cmapLut[s]; d[o+1] = this.cmapLut[s+1]; d[o+2] = this.cmapLut[s+2];
      }
    }
  }

  /** Re-paint. Cheap on GL (range/colormap are shader uniforms). */
  draw() {
    if (!this.bins) return;
    if (this.gl) {
      const gl = this.gl;
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w; this.canvas.height = h;
      }
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.useProgram(this.prog);
      gl.uniform1f(this.uni.rows, this.rows);
      gl.uniform1f(this.uni.writeRow, this.writeRow);
      gl.uniform1f(this.uni.dbMin, this.dbMin);
      gl.uniform1f(this.uni.dbMax, this.dbMax);
      gl.uniform1f(this.uni.viewLo, this.viewLo);
      gl.uniform1f(this.uni.viewHi, this.viewHi);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else {
      const w = Math.max(1, this.canvas.clientWidth), h = Math.max(1, this.canvas.clientHeight);
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w; this.canvas.height = h;
      }
      this.offCtx.putImageData(this.img, 0, 0);
      const sx = this.viewLo * this.bins;
      const sw = Math.max(1, (this.viewHi - this.viewLo) * this.bins);
      this.ctx.imageSmoothingEnabled = false;
      this.ctx.drawImage(this.off, sx, 0, sw, this.rows, 0, 0, w, h);
    }
  }
}
