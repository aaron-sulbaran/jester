// Cutouts of the player and the overlay replay.
//
// During a round, each camera frame gives a small crop of the body part that plays the object (or the
// whole body). Two masks decide which pixels stay:
// - the tracker's person mask, which removes the room;
// - a part shape built from the landmarks, which removes the rest of the body: the head is an ellipse that
//   stops at the chin (no neck or shoulders), a hand is cut at the wrist, a foot just above the ankle.
// Edges are soft (the mask is sampled smoothly and blurred by one pixel) so the outline reads clean.
// The crop is flipped to the mirror view the player saw. After the round, the replay draws the clip again
// and puts the player's cutout where the object was, shifted by the player's measured lag so it lands on
// the object instead of trailing it. The replay is recorded in the browser as a video file; nothing is
// uploaded. Blind mode's reveal reuses this.

import type { BodyPart, LandmarkObject } from "../../engine/src/index.ts";
import { soundTrack } from "./sound.ts";
import { withDuration } from "./webmDuration.ts";

/** A binary person mask, as Lisa's tracker gives it: 0/1 per cell over the whole camera image. */
export interface PersonMask { width: number; height: number; data: Uint8Array }

export interface Cutout {
  /** Clip time when this frame was captured. */
  clipMs: number;
  image: HTMLCanvasElement;
  /** Where the player's torso sits in the image (cutAnchor), so the reveal can stand them on the subject's torso. */
  anchor?: CutAnchor | null;
}

/**
 * Where a cutout came from in the camera frame, in image-height units with x scaled by aspect: the crop
 * square, and the player's torso centre and length (shoulder centre to hip centre) when both are seen.
 */
export interface CutAnchor { region: { cx: number; cy: number; side: number }; torso: { x: number; y: number; len: number } | null }

/** Shoulder and hip centres, from landmarks seen well enough. */
export interface Torso { shoulder: { x: number; y: number }; hip: { x: number; y: number } }

const SIDE = 256; // pixels of the stored square crop (was 160: a tall reveal upscaled it about 7x and looked blurred)

type P = { x: number; y: number };
const pt = (l: LandmarkObject | undefined, aspect: number): P | null => (l && (l.visibility ?? 1) >= 0.5 ? { x: l.x * aspect, y: l.y } : null);
const mid = (ps: (P | null)[]): P | null => { const ok = ps.filter((p): p is P => !!p); return ok.length ? { x: ok.reduce((s, p) => s + p.x, 0) / ok.length, y: ok.reduce((s, p) => s + p.y, 0) / ok.length } : null; };
const dist = (a: P | null, b: P | null) => (a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0);
const sub = (a: P, b: P): P => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: P, b: P, k = 1): P => ({ x: a.x + k * b.x, y: a.y + k * b.y });
const unit = (a: P): P => { const n = Math.hypot(a.x, a.y) || 1; return { x: a.x / n, y: a.y / n }; };

/**
 * The part's shape as a signed distance in image-height units (x scaled by aspect): negative inside,
 * positive outside. Null for the whole body, which the person mask alone cuts out.
 */
type Shape =
  | { kind: "ellipse"; c: P; rx: number; ry: number; angle: number }
  | { kind: "capsules"; segs: [P, P][]; r: number; cut: { o: P; d: P } | null };

function signedDistance(s: Shape, p: P): number {
  if (s.kind === "ellipse") {
    const cos = Math.cos(-s.angle), sin = Math.sin(-s.angle);
    const dx = p.x - s.c.x, dy = p.y - s.c.y;
    const u = (dx * cos - dy * sin) / s.rx, v = (dx * sin + dy * cos) / s.ry;
    return (Math.hypot(u, v) - 1) * Math.min(s.rx, s.ry);
  }
  let d = Infinity;
  for (const [a, b] of s.segs) {
    const ab = sub(b, a), ap = sub(p, a);
    const t = Math.max(0, Math.min(1, (ap.x * ab.x + ap.y * ab.y) / (ab.x * ab.x + ab.y * ab.y || 1)));
    d = Math.min(d, Math.hypot(ap.x - t * ab.x, ap.y - t * ab.y) - s.r);
  }
  // Keep only the side of the cut line the part is on (drops the forearm or the shin).
  if (s.cut) d = Math.max(d, -((p.x - s.cut.o.x) * s.cut.d.x + (p.y - s.cut.o.y) * s.cut.d.y));
  return d;
}

function headShape(p: (i: number) => P | null, shoulderW: number): Shape | null {
  const nose = p(0), eyes = mid([p(2), p(5)]), ears = mid([p(7), p(8)]);
  const anchor = ears ?? eyes ?? nose;
  if (!anchor) return null;
  // Head width: ear to ear, or from the eyes when the head is turned, or from the shoulders.
  const e = Math.max(dist(p(7), p(8)), 2.2 * dist(p(2), p(5)), 0.38 * shoulderW);
  if (!(e > 0)) return null;
  const eyeY = eyes?.y ?? nose!.y - 0.1 * e;
  const mouth = mid([p(9), p(10)]);
  const chin = (mouth?.y ?? eyeY + 0.45 * e) + 0.28 * e; // stops at the chin, so no neck or shoulders
  const top = eyeY - 0.95 * e; // room for hair
  // Tilt with the eye line, kept within a quarter turn.
  let angle = 0;
  const le = p(2), re = p(5);
  if (le && re) { angle = Math.atan2(le.y - re.y, le.x - re.x); if (angle > Math.PI / 2) angle -= Math.PI; if (angle < -Math.PI / 2) angle += Math.PI; }
  return { kind: "ellipse", c: { x: anchor.x, y: (top + chin) / 2 }, rx: 0.7 * e, ry: (chin - top) / 2, angle };
}

function handShape(p: (i: number) => P | null, shoulderW: number, elbow: number, wrist: number, pinky: number, index: number, thumb: number): Shape | null {
  const w = p(wrist), k = mid([p(pinky), p(index)]);
  if (!w) return null;
  // Direction along the hand: wrist to knuckles, or the forearm's direction when the knuckles are lost.
  const e = p(elbow);
  const dir = k && dist(w, k) > 1e-4 ? unit(sub(k, w)) : e ? unit(sub(w, e)) : { x: 0, y: -1 };
  const L = Math.max(k ? dist(w, k) : 0, 0.16 * shoulderW, 0.02);
  const r = Math.max(0.5 * L, 0.6 * dist(p(pinky), p(index)));
  const segs: [P, P][] = [[w, add(w, dir, 1.4 * L)]];
  const t = p(thumb);
  if (t) segs.push([w, t]);
  // Cut at the wrist, so the forearm drops out.
  return { kind: "capsules", segs, r, cut: { o: add(w, dir, 0.05 * L), d: dir } };
}

function footShape(p: (i: number) => P | null, shoulderW: number, knee: number, ankle: number, heel: number, toe: number): Shape | null {
  const a = p(ankle), h = p(heel), t = p(toe);
  if (!a || (!h && !t)) return null;
  const len = Math.max(dist(h, t), dist(a, t ?? h), 0.15 * shoulderW, 0.02);
  const r = 0.3 * len;
  const segs: [P, P][] = [];
  if (h && t) segs.push([h, t]);
  if (h) segs.push([a, h]);
  if (t) segs.push([a, t]);
  // Cut just above the ankle, along the shin, so the leg drops out.
  const k = p(knee);
  const down = k ? unit(sub(a, k)) : { x: 0, y: 1 };
  return { kind: "capsules", segs, r, cut: { o: add(a, down, -0.5 * r), d: down } };
}

function partShape(lms: readonly LandmarkObject[], part: BodyPart, aspect: number): Shape | null {
  const p = (i: number) => pt(lms[i], aspect);
  const shoulderW = dist(p(11), p(12));
  switch (part) {
    case "head": return headShape(p, shoulderW);
    case "rightHand": return handShape(p, shoulderW, 14, 16, 18, 20, 22);
    case "leftHand": return handShape(p, shoulderW, 13, 15, 17, 19, 21);
    case "rightFoot": return footShape(p, shoulderW, 26, 28, 30, 32);
    case "leftFoot": return footShape(p, shoulderW, 25, 27, 29, 31);
    default: return null;
  }
}

/** The square region (center and side, in image-height units with x scaled by aspect) around the part. */
export function partRegion(lms: readonly LandmarkObject[], part: BodyPart, aspect: number): { cx: number; cy: number; side: number } | null {
  const shape = partShape(lms, part, aspect);
  let x0: number, x1: number, y0: number, y1: number;
  if (shape?.kind === "ellipse") {
    const R = Math.max(shape.rx, shape.ry);
    x0 = shape.c.x - R; x1 = shape.c.x + R; y0 = shape.c.y - R; y1 = shape.c.y + R;
  } else if (shape) {
    const ps = shape.segs.flat();
    x0 = Math.min(...ps.map((q) => q.x)) - shape.r; x1 = Math.max(...ps.map((q) => q.x)) + shape.r;
    y0 = Math.min(...ps.map((q) => q.y)) - shape.r; y1 = Math.max(...ps.map((q) => q.y)) + shape.r;
  } else {
    if (part !== "body") return null;
    const vis = lms.map((l) => pt(l, aspect)).filter((q): q is P => !!q);
    if (vis.length < 5) return null;
    const xs = vis.map((q) => q.x), ys = vis.map((q) => q.y);
    x0 = Math.min(...xs); x1 = Math.max(...xs); y0 = Math.min(...ys) - 0.04; y1 = Math.max(...ys);
  }
  const side = 1.12 * Math.max(x1 - x0, y1 - y0);
  if (!(side > 0.02)) return null;
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, side };
}

/** The torso of `lms` placed in the crop `cutFrame` makes for the same frame and part. */
export function cutAnchor(lms: readonly LandmarkObject[], part: BodyPart, aspect: number): CutAnchor | null {
  if (part !== "body") return null;
  const region = partRegion(lms, part, aspect);
  if (!region) return null;
  const [a, b, c, d] = [11, 12, 23, 24].map((i) => pt(lms[i], aspect));
  if (!a || !b || !c || !d) return { region, torso: null };
  const sh = mid([a, b])!, hp = mid([c, d])!;
  return { region, torso: { x: (sh.x + hp.x) / 2, y: (sh.y + hp.y) / 2, len: dist(sh, hp) } };
}

/** A separable box blur of an n by n alpha grid, radius r. */
function blurAlpha(src: Float32Array, n: number, r: number): Float32Array {
  const tmp = new Float32Array(n * n), out = new Float32Array(n * n);
  for (let pass = 0; pass < 2; pass++) {
    const from = pass === 0 ? src : tmp, to = pass === 0 ? tmp : out;
    for (let a = 0; a < n; a++) {
      let sum = 0, cnt = 0;
      const at = (b: number) => (pass === 0 ? from[a * n + b]! : from[b * n + a]!);
      for (let b = 0; b <= Math.min(n - 1, r); b++) { sum += at(b); cnt++; }
      for (let b = 0; b < n; b++) {
        to[pass === 0 ? a * n + b : b * n + a] = sum / cnt;
        const add = b + r + 1, drop = b - r;
        if (add < n) { sum += at(add); cnt++; }
        if (drop >= 0) { sum -= at(drop); cnt--; }
      }
    }
  }
  return out;
}

/** The binary mask sampled between cells, so its staircase edge becomes a soft ramp. */
function sampleMask(mask: PersonMask, nx: number, ny: number): number {
  const fx = nx * mask.width - 0.5, fy = ny * mask.height - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= mask.width || y >= mask.height ? 0 : mask.data[y * mask.width + x]!);
  return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
}

/**
 * Crop one frame. `source` is the camera image (or null for the simulated player, which is drawn as a
 * stick figure instead). Returns a square canvas, mirrored, transparent everywhere but the chosen part.
 */
export function cutFrame(
  source: CanvasImageSource | null, sourceW: number, sourceH: number,
  lms: readonly LandmarkObject[], part: BodyPart, mask: PersonMask | null,
): HTMLCanvasElement | null {
  const aspect = sourceW / sourceH;
  const r = partRegion(lms, part, aspect);
  if (!r) return null;
  const shape = partShape(lms, part, aspect);
  const out = document.createElement("canvas");
  out.width = out.height = SIDE;
  const ctx = out.getContext("2d", { willReadFrequently: true })!;
  // Mirror, so the cutout moves the way the player saw themself move.
  ctx.translate(SIDE, 0); ctx.scale(-1, 1);
  const px = (v: number) => (v / aspect) * sourceW, py = (v: number) => v * sourceH; // region units to source pixels
  const sx = px(r.cx - r.side / 2), sy = py(r.cy - r.side / 2), sw = px(r.side), sh = py(r.side);
  if (source) {
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, SIDE, SIDE);
  } else {
    // Simulated player: draw its stick figure inside the region.
    ctx.strokeStyle = "#6fd3ff"; ctx.lineWidth = 6; ctx.lineCap = "round";
    const to = (l: LandmarkObject) => [((l.x * aspect - (r.cx - r.side / 2)) / r.side) * SIDE, ((l.y - (r.cy - r.side / 2)) / r.side) * SIDE] as const;
    for (const [a, b] of [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [15, 19], [16, 20], [16, 22], [15, 21], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [27, 31], [28, 32], [27, 29], [28, 30], [29, 31], [30, 32]]) {
      const la = lms[a!], lb = lms[b!];
      if (!la || !lb) continue;
      const [x0, y0] = to(la), [x1, y1] = to(lb);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
    const [hx, hy] = to(lms[0]!);
    ctx.beginPath(); ctx.arc(hx, hy, SIDE * 0.08, 0, Math.PI * 2); ctx.stroke();
  }
  if (!shape && !(source && mask)) return out;

  // Keep-alpha per output pixel: person mask times part shape, each with a soft edge.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const img = ctx.getImageData(0, 0, SIDE, SIDE);
  const keep = new Float32Array(SIDE * SIDE);
  const edge = (1.5 * r.side) / SIDE; // about a pixel and a half of the crop
  for (let y = 0; y < SIDE; y++) {
    for (let x = 0; x < SIDE; x++) {
      // Output pixel (x, y) is mirrored: it came from source column sx + (SIDE - 1 - x + 0.5) / SIDE * sw.
      const nx = (sx + ((SIDE - 0.5 - x) / SIDE) * sw) / sourceW, ny = (sy + ((y + 0.5) / SIDE) * sh) / sourceH;
      let k = source && mask ? sampleMask(mask, nx, ny) : 1;
      if (shape && k > 0) k *= Math.max(0, Math.min(1, 0.5 - signedDistance(shape, { x: nx * aspect, y: ny }) / edge));
      keep[y * SIDE + x] = k;
    }
  }
  // Soften the edge: two passes of a box blur (close to a gaussian, about 3 px of the crop each way), then
  // pull the edge in a little, so the mask's steps and its flicker from frame to frame fade out, and no
  // fringe of the player's room shows round them.
  const soft = blurAlpha(blurAlpha(keep, SIDE, 3), SIDE, 3);
  for (let p = 0; p < SIDE * SIDE; p++) {
    const t = Math.max(0, Math.min(1, (soft[p]! - 0.3) / 0.6));
    const i = p * 4 + 3;
    img.data[i] = Math.round(img.data[i]! * t * t * (3 - 2 * t));
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

export interface Box { cx: number; cy: number; w: number; h: number }

/** One player in the replay: their cutouts, placed on their subject's box. */
export interface RevealLayer {
  cutouts: readonly Cutout[];
  /** The player's measured lag: their move at clip time t happened at t + lagMs. */
  lagMs: number;
  /** Cutouts were captured in a slowed play time: replay time ms is play time ms * timeScale (default 1). */
  timeScale?: number;
  /** Where the subject is at replay time ms, normalized like the clip. */
  boxAt: (ms: number) => Box | null;
  /** A person's cutout is the whole body sized to the box; a thing's is sized up so a small ball still shows a hand. */
  kind: "person" | "thing";
  /**
   * For a person: the subject's shoulder and hip centres at replay time ms (normalized like the clip). With it,
   * each cutout's torso is stood on the subject's, at one scale fixed for the whole reveal (see steadyOf).
   */
  torsoAt?: (ms: number) => Torso | null;
  /** Sideways offset in cutout widths, so players sharing a role stand side by side (default 0). */
  spread?: number;
  /** Name tag drawn above the cutout, e.g. "Alex 87". */
  tag?: string;
  color?: string;
  /** Glow around the cutout in its colour, in px (default 12; 0 for none). */
  glow?: number;
  /** Font family for the name tag (default system-ui). */
  tagFont?: string;
}

export interface RevealOptions {
  canvas: HTMLCanvasElement;
  durationMs: number;
  layers: readonly RevealLayer[];
  /** Draw the clip at replay time ms (the original video frame, or a drawn scene). */
  drawBackground: (ctx: CanvasRenderingContext2D, ms: number) => void;
  /** Optional clock, e.g. a playing video; default is wall time from the start. */
  clock?: { start(): void | Promise<void>; now(): number; stop?(): void };
  onProgress?: (share: number) => void;
}

/** The cutout captured nearest to clip time `ms`, if one is within 150 ms. */
function nearest(cutouts: readonly Cutout[], ms: number): Cutout | null {
  let lo = 0, hi = cutouts.length - 1;
  if (hi < 0) return null;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cutouts[m]!.clipMs <= ms) lo = m; else hi = m; }
  const best = Math.abs(cutouts[lo]!.clipMs - ms) <= Math.abs(cutouts[hi]!.clipMs - ms) ? cutouts[lo]! : cutouts[hi]!;
  // Up to 0.6 s away: the camera or its mask drops frames now and then, and a held picture beats a blink.
  return Math.abs(best.clipMs - ms) <= 600 ? best : null;
}

const median = (xs: number[]) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[v.length >> 1]! : NaN; };

/**
 * One fixed placement per player for the whole reveal: a single scale (the subject's typical torso over the
 * player's typical torso, so a small player is scaled up once and a big one down once, never again), and the
 * player's torso centre steadied over neighbouring frames. Worked out once per layer and canvas size.
 */
interface Steady { k: number; centre: Map<Cutout, P>; raw: Map<Cutout, P>; torsoPx: number }
const steadyCache = new WeakMap<readonly Cutout[], { key: string; steady: Steady | null }>();

function steadyOf(layer: RevealLayer, W: number, H: number): Steady | null {
  const key = `${W}x${H}`;
  const hit = steadyCache.get(layer.cutouts);
  if (hit && hit.key === key) return hit.steady;
  let steady: Steady | null = null;
  const withTorso = layer.cutouts.filter((c) => c.anchor?.torso);
  if (layer.torsoAt && withTorso.length >= 3) {
    // The subject's torso in canvas pixels, sampled at the moments the player was captured.
    const ts = 1 / (layer.timeScale ?? 1);
    const subject: number[] = [];
    for (const c of layer.cutouts) {
      const t = layer.torsoAt((c.clipMs - Math.max(0, layer.lagMs)) * ts);
      if (t) subject.push(Math.hypot((t.shoulder.x - t.hip.x) * W, (t.shoulder.y - t.hip.y) * H));
    }
    const player = median(withTorso.map((c) => c.anchor!.torso!.len));
    const k = median(subject) / player;
    if (subject.length >= 3 && k > 0 && Number.isFinite(k)) {
      // Torso centre relative to the crop centre, for frames whose torso was not seen.
      const off = { x: median(withTorso.map((c) => c.anchor!.torso!.x - c.anchor!.region.cx)), y: median(withTorso.map((c) => c.anchor!.torso!.y - c.anchor!.region.cy)) };
      const raw = layer.cutouts.map((c) => {
        const a = c.anchor;
        if (!a) return null;
        return a.torso ? { x: a.torso.x, y: a.torso.y } : { x: a.region.cx + off.x, y: a.region.cy + off.y };
      });
      // Average the centre over about a fifth of a second either side, which takes out the landmark jitter.
      const centre = new Map<Cutout, P>(), rawOf = new Map<Cutout, P>();
      layer.cutouts.forEach((c, i) => {
        if (!raw[i]) return;
        rawOf.set(c, raw[i]!);
        let sx = 0, sy = 0, n = 0;
        for (let j = i; j >= 0 && c.clipMs - layer.cutouts[j]!.clipMs <= 200; j--) if (raw[j]) { sx += raw[j]!.x; sy += raw[j]!.y; n++; }
        for (let j = i + 1; j < layer.cutouts.length && layer.cutouts[j]!.clipMs - c.clipMs <= 200; j++) if (raw[j]) { sx += raw[j]!.x; sy += raw[j]!.y; n++; }
        centre.set(c, { x: sx / n, y: sy / n });
      });
      steady = { k, centre, raw: rawOf, torsoPx: median(subject) };
    }
  }
  steadyCache.set(layer.cutouts, { key, steady });
  return steady;
}

/** Where a cutout goes: its torso centre on the subject's, at the player's one fixed scale; null to fall back to the box. */
function torsoPlacement(layer: RevealLayer, c: Cutout, W: number, H: number, ms: number, b: Box) {
  const st = steadyOf(layer, W, H), a = c.anchor;
  const cs = st?.centre.get(c);
  if (!st || !a || !cs) return null;
  const t = layer.torsoAt?.(ms);
  const tx = t ? ((t.shoulder.x + t.hip.x) / 2) * W : b.cx * W, ty = t ? ((t.shoulder.y + t.hip.y) / 2) * H : b.cy * H;
  const r = a.region, side = r.side * st.k;
  // The image is mirrored, so the torso's place across it is measured from the crop's right edge.
  const u = (r.cx + r.side / 2 - cs.x) / r.side, v = (cs.y - (r.cy - r.side / 2)) / r.side;
  return { x: tx - u * side, y: ty - v * side, side, cx: tx };
}

/**
 * Cutouts come about 15 times a second, so between two of them the body would stand still and then jump. This is
 * how far to move the shown cutout at capture time `t` so the player's torso glides from where it is in one
 * cutout to where it is in the next (the picture still changes at the midpoint; only its place glides).
 */
function glide(layer: RevealLayer, shown: Cutout, t: number, st: Steady): P {
  const cs = layer.cutouts;
  let lo = 0, hi = cs.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cs[m]!.clipMs <= t) lo = m; else hi = m; }
  const a = cs[lo]!, b = cs[hi]!;
  if (a === b || t < a.clipMs || t > b.clipMs || b.clipMs - a.clipMs > 250) return { x: 0, y: 0 };
  // Where each cutout's torso lands relative to the dancer's (the image is mirrored, so x flips).
  const body = (c: Cutout): P | null => {
    const r = st.raw.get(c), m = st.centre.get(c);
    return r && m ? { x: -(r.x - m.x) * st.k, y: (r.y - m.y) * st.k } : null;
  };
  const pa = body(a), pb = body(b);
  if (!pa || !pb) return { x: 0, y: 0 };
  const u = (t - a.clipMs) / (b.clipMs - a.clipMs), d = sub(pb, pa);
  const k = shown === a ? u : shown === b ? u - 1 : 0;
  return { x: d.x * k, y: d.y * k };
}

/**
 * A cutout with its glow already painted in, made once per cutout and kept: a canvas shadow blur on every
 * cutout on every frame was the most expensive part of drawing the reveal. `pad` and `scale` are shares of the
 * drawn side: the glowed picture is drawn `pad` sides left and up of the cutout, `scale` sides wide.
 */
const glowCache = new WeakMap<HTMLCanvasElement, { key: string; image: HTMLCanvasElement; pad: number; scale: number }>();
function glowed(src: HTMLCanvasElement, color: string, glow: number, side: number) {
  const blur = Math.max(0, Math.round((glow * src.width) / Math.max(1, side)));
  const key = `${color}|${blur}`;
  const hit = glowCache.get(src);
  if (hit && hit.key === key) return hit;
  const padPx = Math.ceil(blur * 1.5);
  const out = document.createElement("canvas");
  out.width = src.width + 2 * padPx; out.height = src.height + 2 * padPx;
  const o = out.getContext("2d")!;
  o.shadowColor = color; o.shadowBlur = blur;
  o.drawImage(src, padPx, padPx);
  const made = { key, image: out, pad: padPx / src.width, scale: out.width / src.width };
  glowCache.set(src, made);
  return made;
}

/** Draw every layer's cutout for replay time `ms`. */
export function drawLayers(ctx: CanvasRenderingContext2D, W: number, H: number, layers: readonly RevealLayer[], ms: number) {
  for (const layer of layers) {
    const b = layer.boxAt(ms);
    const at = ms * (layer.timeScale ?? 1) + Math.max(0, layer.lagMs);
    const c = nearest(layer.cutouts, at);
    if (!b || !c) continue;
    const boxSide = layer.kind === "person" ? Math.max(b.w * W, b.h * H) * 1.15 : Math.max(b.w * W, b.h * H, H / 6) * 1.4;
    const placed = layer.kind === "person" ? torsoPlacement(layer, c, W, H, ms, b) : null;
    const st = placed ? steadyOf(layer, W, H) : null;
    const g = st ? glide(layer, c, at, st) : { x: 0, y: 0 };
    const side = placed?.side ?? boxSide;
    const shift = (layer.spread ?? 0) * side;
    const cx = (placed?.cx ?? b.cx * W) + shift;
    const x = (placed ? placed.x + g.x : b.cx * W - side / 2) + shift, y = placed ? placed.y + g.y : b.cy * H - side / 2;
    const glow = glowed(c.image, layer.color ?? "#f5c542", layer.glow ?? 12, side);
    ctx.drawImage(glow.image, x - glow.pad * side, y - glow.pad * side, side * glow.scale, side * glow.scale);
    if (layer.tag) {
      ctx.save();
      ctx.font = `600 ${Math.round(H / 24)}px ${layer.tagFont ?? "system-ui, sans-serif"}`;
      ctx.textAlign = "center"; ctx.textBaseline = "bottom";
      // Over the dancer's head, from their steady torso, so the tag does not hop when the cutout's crop changes.
      const torso = placed && st ? layer.torsoAt?.(ms) : null;
      const ty = Math.max(H / 20, torso && st ? torso.shoulder.y * H - st.torsoPx * 0.9 : y + side * 0.06);
      ctx.lineWidth = 4; ctx.strokeStyle = "rgba(0,0,0,0.7)"; ctx.strokeText(layer.tag, cx, ty);
      ctx.fillStyle = layer.color ?? "#f5c542"; ctx.fillText(layer.tag, cx, ty);
      ctx.restore();
    }
  }
}

/** A clock for a segment, e.g. a video playing from some point; default is wall time from the segment's start. */
export interface SegmentClock { start(): void | Promise<void>; now(): number; stop?(): void; /** Lets the clock run faster (a video's playbackRate). */ setSpeed?(speed: number): void }

/** Read on every tick while recording, so a button can speed up or skip the rest of a reveal. 1 is real time. */
export interface PlaybackControl { speed: number }

/** One part of a recorded video: drawn for `durationMs`, at the time its clock gives. */
export interface Segment {
  durationMs: number;
  draw: (ctx: CanvasRenderingContext2D, ms: number) => void;
  clock?: SegmentClock;
}

/**
 * Plays the segments one after another on the canvas while recording them into one video. The recorder
 * pauses while a segment's clock gets ready (a video seeking), so no dead frames land in the file.
 * Resolves with a video URL, or null if this browser cannot record (the segments still play).
 */
export async function recordSegments(canvas: HTMLCanvasElement, segments: readonly Segment[], onProgress?: (share: number) => void, control?: PlaybackControl, sound?: HTMLMediaElement | null): Promise<string | null> {
  const ctx = canvas.getContext("2d")!;
  const stream = typeof canvas.captureStream === "function" ? canvas.captureStream(30) : null;
  // The clip's own sound goes into the file too, whenever the browser lets it be tapped.
  const track = stream && sound ? await soundTrack(sound) : null;
  if (stream && track) stream.addTrack(track);
  const types = track ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"] : ["video/webm;codecs=vp9", "video/webm", "video/mp4"];
  const type = types.find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t));
  const recorder = stream && type ? new MediaRecorder(stream, { mimeType: type }) : null;
  const chunks: Blob[] = [];
  const total = segments.reduce((sum, seg) => sum + seg.durationMs, 0) || 1;
  const done = new Promise<string | null>((resolve) => {
    if (!recorder) return;
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    // The length goes into the file, so the results' seek bar works and a sent copy opens anywhere.
    recorder.onstop = async () => resolve(chunks.length ? URL.createObjectURL(await withDuration(new Blob(chunks, { type }))) : null);
  });
  let before = 0;
  for (const [k, seg] of segments.entries()) {
    seg.draw(ctx, 0);
    if (recorder?.state === "recording") recorder.pause();
    if (seg.clock) await seg.clock.start();
    if (recorder?.state === "paused") recorder.resume();
    else if (recorder && k === 0) recorder.start(250);
    const started = performance.now();
    const wall = () => performance.now() - started;
    // Without a video clock, time runs at the control's speed: virtual ms add up as (real elapsed) x (speed now).
    let virtual = 0, lastReal = started;
    const pace = () => { const t = performance.now(); virtual += (t - lastReal) * (control?.speed ?? 1); lastReal = t; return virtual; };
    const now = seg.clock ? () => seg.clock!.now() : pace;
    await new Promise<void>((next) => {
      // A timer, not requestAnimationFrame, so it still records in a background tab.
      const timer = window.setInterval(() => {
        if (control && seg.clock?.setSpeed) seg.clock.setSpeed(control.speed);
        const ms = Math.max(0, now());
        seg.draw(ctx, Math.min(ms, seg.durationMs));
        onProgress?.(Math.min(1, (before + ms) / total));
        // A stalled video clock still ends the segment a little after it should have.
        if (ms >= seg.durationMs || wall() > seg.durationMs / Math.max(1, control?.speed ?? 1) + 5000) { clearInterval(timer); seg.clock?.stop?.(); next(); }
      }, 1000 / 30);
    });
    before += seg.durationMs;
  }
  if (!recorder) return null;
  recorder.stop();
  return done;
}

/** Play the overlay once on the canvas while recording it. Resolves with a video URL (or null if recording is unsupported). */
export function recordReveal(o: RevealOptions): Promise<string | null> {
  const W = o.canvas.width, H = o.canvas.height;
  return recordSegments(o.canvas, [{
    durationMs: o.durationMs, clock: o.clock,
    draw: (ctx, ms) => { o.drawBackground(ctx, ms); drawLayers(ctx, W, H, o.layers, ms); },
  }], o.onProgress);
}
