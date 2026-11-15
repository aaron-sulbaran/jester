// Plain generated frames for the Chamberlain's synthetic cases: a stick figure doing a move on a plain room,
// optionally with words painted above it. No real people, no files on disk: each case renders its own PNGs.
// Pure Node (zlib for the PNG), so the eval needs no image library.

import { deflateSync } from "node:zlib";

export type Move = "jumping-jacks" | "squats" | "standing";

const W = 320;
const H = 240;
type Rgb = [number, number, number];

class Canvas {
  readonly px = new Uint8Array(W * H * 3);
  constructor(bg: Rgb) {
    for (let i = 0; i < W * H; i++) this.px.set(bg, i * 3);
  }
  dot(x: number, y: number, c: Rgb) {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi >= 0 && yi >= 0 && xi < W && yi < H) this.px.set(c, (yi * W + xi) * 3);
  }
  disc(cx: number, cy: number, r: number, c: Rgb) {
    for (let y = Math.floor(cy - r); y <= cy + r; y++) for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) this.dot(x, y, c);
    }
  }
  ring(cx: number, cy: number, r: number, thick: number, c: Rgb) {
    for (let y = Math.floor(cy - r - thick); y <= cy + r + thick; y++) for (let x = Math.floor(cx - r - thick); x <= cx + r + thick; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d >= r - thick / 2 && d <= r + thick / 2) this.dot(x, y, c);
    }
  }
  line(x0: number, y0: number, x1: number, y1: number, thick: number, c: Rgb) {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
    for (let i = 0; i <= steps; i++) this.disc(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, thick / 2, c);
  }
  rect(x: number, y: number, w: number, h: number, c: Rgb) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.dot(x + i, y + j, c);
  }
}

// ---- A 5 by 7 font, capitals only ----

const GLYPHS: Record<string, string> = {
  A: " ### |#   #|#   #|#####|#   #|#   #|#   #", B: "#### |#   #|#   #|#### |#   #|#   #|#### ",
  C: " ### |#   #|#    |#    |#    |#   #| ### ", D: "#### |#   #|#   #|#   #|#   #|#   #|#### ",
  E: "#####|#    |#    |#### |#    |#    |#####", F: "#####|#    |#    |#### |#    |#    |#    ",
  G: " ### |#   #|#    |# ###|#   #|#   #| ####", H: "#   #|#   #|#   #|#####|#   #|#   #|#   #",
  I: " ### |  #  |  #  |  #  |  #  |  #  | ### ", J: "  ###|   # |   # |   # |   # |#  # | ##  ",
  K: "#   #|#  # |# #  |##   |# #  |#  # |#   #", L: "#    |#    |#    |#    |#    |#    |#####",
  M: "#   #|## ##|# # #|# # #|#   #|#   #|#   #", N: "#   #|##  #|# # #|#  ##|#   #|#   #|#   #",
  O: " ### |#   #|#   #|#   #|#   #|#   #| ### ", P: "#### |#   #|#   #|#### |#    |#    |#    ",
  Q: " ### |#   #|#   #|#   #|# # #|#  # | ## #", R: "#### |#   #|#   #|#### |# #  |#  # |#   #",
  S: " ####|#    |#    | ### |    #|    #|#### ", T: "#####|  #  |  #  |  #  |  #  |  #  |  #  ",
  U: "#   #|#   #|#   #|#   #|#   #|#   #| ### ", V: "#   #|#   #|#   #|#   #|#   #| # # |  #  ",
  W: "#   #|#   #|#   #|# # #|# # #|# # #| # # ", X: "#   #|#   #| # # |  #  | # # |#   #|#   #",
  Y: "#   #|#   #| # # |  #  |  #  |  #  |  #  ", Z: "#####|    #|   # |  #  | #   |#    |#####",
  " ": "     |     |     |     |     |     |     ", ".": "     |     |     |     |     | ##  | ##  ",
  ":": "     | ##  | ##  |     | ##  | ##  |     ", "!": "  #  |  #  |  #  |  #  |  #  |     |  #  ",
};

function text(cv: Canvas, s: string, y: number, scale: number, c: Rgb) {
  const chars = s.toUpperCase().split("").filter((ch) => GLYPHS[ch] !== undefined);
  const width = chars.length * 6 * scale - scale;
  let x = Math.round((W - width) / 2);
  for (const ch of chars) {
    GLYPHS[ch]!.split("|").forEach((row, j) => {
      for (let i = 0; i < 5; i++) if (row[i] === "#") cv.rect(x + i * scale, y + j * scale, scale, scale, c);
    });
    x += 6 * scale;
  }
}

// ---- The figure ----

/** One pose: arm angle from straight down (0) to straight up (180), feet spread in px, hip drop in px. */
interface Pose { arms: number; feet: number; drop: number }

function pose(move: Move, i: number): Pose {
  const odd = i % 2 === 1;
  if (move === "jumping-jacks") return odd ? { arms: 140, feet: 34, drop: 0 } : { arms: 15, feet: 8, drop: 0 };
  if (move === "squats") return odd ? { arms: 90, feet: 20, drop: 24 } : { arms: 20, feet: 20, drop: 0 };
  return { arms: 12, feet: 10, drop: 0 };
}

function figure(cv: Canvas, p: Pose, ink: Rgb) {
  const cx = W / 2, floor = 214, thick = 7;
  const hipY = floor - 62 + p.drop, shoulderY = hipY - 58, headY = shoulderY - 22;
  cv.ring(cx, headY, 14, 5, ink);
  cv.line(cx, shoulderY - 6, cx, hipY, thick, ink);
  const rad = (p.arms * Math.PI) / 180;
  for (const side of [-1, 1]) {
    cv.line(cx, shoulderY, cx + side * Math.sin(rad) * 48, shoulderY + Math.cos(rad) * 48, thick, ink);
    if (p.drop > 0) {
      // Knees forward and out, feet under them.
      const kneeX = cx + side * (p.feet + 14), kneeY = (hipY + floor) / 2;
      cv.line(cx, hipY, kneeX, kneeY, thick, ink);
      cv.line(kneeX, kneeY, cx + side * p.feet, floor, thick, ink);
    } else {
      cv.line(cx, hipY, cx + side * p.feet, floor, thick, ink);
    }
  }
}

// ---- PNG ----

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function png(cv: Canvas): Buffer {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) Buffer.from(cv.px.subarray(y * W * 3, (y + 1) * W * 3)).copy(raw, y * (W * 3 + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))]);
}

/** `count` frames of a stick figure doing `move`, as PNG data URLs, with optional lines of words painted on top. */
export function figureFrames(move: Move, opts: { count?: number; words?: string[] } = {}): string[] {
  const frames: string[] = [];
  for (let i = 0; i < (opts.count ?? 4); i++) {
    const cv = new Canvas([238, 232, 220]);
    cv.rect(0, 214, W, H - 214, [196, 182, 160]);
    figure(cv, pose(move, i), [40, 40, 52]);
    (opts.words ?? []).forEach((line, j) => text(cv, line, 10 + j * 20, 2, [180, 30, 30]));
    frames.push(`data:image/png;base64,${png(cv).toString("base64")}`);
  }
  return frames;
}

export const FRAME_SIZE = { width: W, height: H };
