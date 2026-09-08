// One message on the wire.
//
// A spectrum is 1024 float32s thirty times a second, and JSON would spend about six
// bytes and a parse on each of those numbers to deliver four bytes of information.
// So a message is a small JSON header followed by the sample arrays themselves, and
// nothing that is already binary is ever turned into text.
//
// The header does not have to name where the arrays go. The encoder walks the value,
// swaps every typed array it finds for a placeholder, and appends the bytes; the
// decoder walks the same shape and puts them back. Nesting therefore costs nothing —
// `{ records: [{ bytes }] }` travels as readily as `{ data }`, which matters because
// the engine's return shapes were designed without a wire in mind and should not have
// to change now that there is one.
//
//   [u32 header length][header JSON][payload][payload]…
//
// Everything is padded to eight bytes so a Float32Array can be laid over the buffer
// where it sits, with no copy. That is the difference between a frame costing a view
// and a frame costing an allocation and a memcpy, sixty times a second.

const TYPES = {
  f32: Float32Array, f64: Float64Array,
  u8: Uint8Array, i8: Int8Array,
  u16: Uint16Array, i16: Int16Array,
  u32: Uint32Array, i32: Int32Array,
};
const TAG = new Map(Object.entries(TYPES).map(([k, C]) => [C, k]));

const pad8 = (n) => (n + 7) & ~7;

/** Depth-first, replacing typed arrays with `{$b: index}` and collecting their bytes. */
function extract(value, bins) {
  if (value == null || typeof value !== 'object') return value;
  const tag = TAG.get(value.constructor);
  if (tag) {
    bins.push({ tag, view: new Uint8Array(value.buffer, value.byteOffset, value.byteLength) });
    return { $b: bins.length - 1 };
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    // a DataView or a bare buffer: send it as bytes and hand back bytes
    const u8 = value instanceof ArrayBuffer
      ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    bins.push({ tag: 'u8', view: u8 });
    return { $b: bins.length - 1 };
  }
  if (Array.isArray(value)) return value.map((v) => extract(v, bins));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = extract(v, bins);
  return out;
}

function restore(value, bins) {
  if (value == null || typeof value !== 'object') return value;
  if (typeof value.$b === 'number') return bins[value.$b];
  if (Array.isArray(value)) return value.map((v) => restore(v, bins));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = restore(v, bins);
  return out;
}

/** A message object in, one ArrayBuffer out. */
export function encode(msg) {
  const bins = [];
  const shape = extract(msg, bins);
  const header = new TextEncoder().encode(JSON.stringify({
    ...shape,
    $bins: bins.map((b) => ({ t: b.tag, n: b.view.byteLength })),
  }));

  const headerEnd = pad8(4 + header.byteLength);
  let total = headerEnd;
  const offsets = [];
  for (const b of bins) { offsets.push(total); total += pad8(b.view.byteLength); }

  const buf = new ArrayBuffer(total);
  const u8 = new Uint8Array(buf);
  new DataView(buf).setUint32(0, header.byteLength, true);
  u8.set(header, 4);
  bins.forEach((b, i) => u8.set(b.view, offsets[i]));
  return buf;
}

/** One ArrayBuffer in, the message back — sample arrays as views over that buffer. */
export function decode(buf) {
  if (buf instanceof Uint8Array) {
    // Node hands sockets Buffers, whose byteOffset is rarely zero: copy out the slice
    // this message actually occupies so the views below can be laid over it directly.
    const copy = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return decode(copy);
  }
  const dv = new DataView(buf);
  const hlen = dv.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hlen)));
  const specs = header.$bins || [];
  delete header.$bins;

  let off = pad8(4 + hlen);
  const bins = specs.map((s) => {
    const C = TYPES[s.t];
    if (!C) throw new Error(`unknown array type ${s.t}`);
    const view = new C(buf, off, s.n / C.BYTES_PER_ELEMENT);
    off += pad8(s.n);
    return view;
  });
  return restore(header, bins);
}

/** Roughly what a message will cost, without building it — for logs and metrics. */
export function sizeOf(buf) { return buf.byteLength; }
