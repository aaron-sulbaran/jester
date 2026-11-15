// MediaRecorder writes WebM with no length in its header, so a <video> shows no seek bar and other players
// may not open the file at all. This writes the length in: it reads the last frame's time from the clusters
// and adds a Duration to the Segment's Info. Anything unexpected leaves the file exactly as it was.

const SEGMENT = 0x18538067, INFO = 0x1549a966, CLUSTER = 0x1f43b675, BLOCK_GROUP = 0xa0;
const TIMECODE_SCALE = 0x2ad7b1, DURATION = 0x4489, CLUSTER_TIME = 0xe7, SIMPLE_BLOCK = 0xa3, BLOCK = 0xa1;
const SEEK_HEAD = 0x114d9b74, CUES = 0x1c53bb6b;

/** An EBML variable length number at `p`: its value (marker bit kept for ids), length, and whether it means "unknown size". */
function vint(b: Uint8Array, p: number, id: boolean) {
  const first = b[p]!;
  let len = 1, mask = 0x80;
  while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
  if (len > 8 || p + len > b.length) return null;
  let v = id ? first : first & (mask - 1), allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) { v = v * 256 + b[p + i]!; if (b[p + i] !== 0xff) allOnes = false; }
  return { v, len, unknown: !id && allOnes };
}

function uint(b: Uint8Array, p: number, n: number) { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[p + i]!; return v; }

/** An element: id bytes, an 8 byte size, then the data. */
function element(id: number, data: Uint8Array): Uint8Array {
  const idBytes: number[] = [];
  for (let x = id; x > 0; x = Math.floor(x / 256)) idBytes.unshift(x & 0xff);
  const out = new Uint8Array(idBytes.length + 8 + data.length);
  out.set(idBytes, 0);
  out[idBytes.length] = 0x01;
  for (let i = 0, n = data.length; i < 7; i++, n = Math.floor(n / 256)) out[idBytes.length + 7 - i] = n & 0xff;
  out.set(data, idBytes.length + 8);
  return out;
}

/** The WebM bytes with a Duration in the header, or null when the file is not laid out the way MediaRecorder writes it. */
export function webmWithDuration(b: Uint8Array): Uint8Array<ArrayBuffer> | null {
  let info: { start: number; data: number; end: number } | null = null;
  let scale = 1_000_000, cluster = 0, last = -1;
  let p = 0;
  while (p < b.length) {
    const id = vint(b, p, true); if (!id) break;
    const size = vint(b, p + id.len, false); if (!size) break;
    const data = p + id.len + size.len;
    const end = size.unknown ? b.length : Math.min(b.length, data + size.v);
    switch (id.v) {
      case SEGMENT: case CLUSTER: case BLOCK_GROUP:
        p = data; continue; // step inside
      case SEEK_HEAD: case CUES:
        return null; // byte offsets elsewhere would break if the header grew
      case INFO: {
        if (size.unknown) return null;
        info = { start: p, data, end };
        for (let q = data; q < end;) {
          const cid = vint(b, q, true), csz = cid && vint(b, q + cid.len, false);
          if (!cid || !csz) return null;
          const cd = q + cid.len + csz.len;
          if (cid.v === DURATION) return null; // already has one
          if (cid.v === TIMECODE_SCALE) scale = uint(b, cd, csz.v);
          q = cd + csz.v;
        }
        break;
      }
      case CLUSTER_TIME: cluster = uint(b, data, size.v); break;
      case SIMPLE_BLOCK: case BLOCK: {
        const track = vint(b, data, false);
        if (track && data + track.len + 2 <= b.length) {
          const rel = (b[data + track.len]! << 24 >> 16) | b[data + track.len + 1]!; // signed 16 bit
          last = Math.max(last, cluster + rel);
        }
        break;
      }
    }
    p = end;
  }
  if (!info || last < 0) return null;
  // The last frame's start plus about one frame, in the file's own time units.
  const units = last + Math.round(33_000_000 / scale);
  const value = new Uint8Array(8);
  new DataView(value.buffer).setFloat64(0, units);
  const children = b.subarray(info.data, info.end);
  const body = new Uint8Array(children.length + 2 + 1 + 8);
  body.set(children, 0);
  body.set([0x44, 0x89, 0x88], children.length); // Duration, size 8
  body.set(value, children.length + 3);
  const newInfo = element(INFO, body);
  const out = new Uint8Array(b.length - (info.end - info.start) + newInfo.length);
  out.set(b.subarray(0, info.start), 0);
  out.set(newInfo, info.start);
  out.set(b.subarray(info.end), info.start + newInfo.length);
  // A Segment with a known size must grow by the same amount; MediaRecorder writes "unknown", which needs nothing.
  const seg = findSegment(out);
  if (seg && !seg.unknown) return null;
  return out;
}

function findSegment(b: Uint8Array) {
  let p = 0;
  while (p < b.length) {
    const id = vint(b, p, true), size = id && vint(b, p + id.len, false);
    if (!id || !size) return null;
    if (id.v === SEGMENT) return size;
    p += id.len + size.len + size.v;
  }
  return null;
}

/** The recording with its length written in, or the recording as it was when that is not possible. */
export async function withDuration(blob: Blob): Promise<Blob> {
  if (!/webm/i.test(blob.type)) return blob;
  try {
    const fixed = webmWithDuration(new Uint8Array(await blob.arrayBuffer()));
    return fixed ? new Blob([fixed], { type: blob.type }) : blob;
  } catch {
    return blob;
  }
}
