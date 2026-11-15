// The blind mode guide as a jester puppet, drawn in code on the same 2D canvas and at the same places as
// the stick figure (the player uses the guide to find their place in the frame). Three ways to build it
// are on offer until the team picks one (`Construction`); all keep to the scrapbook look's rules from the
// frontend agent: the player's colour only (the classic purple and red stay the host's), a white die-cut
// edge or cut paper with hard offset shadows like the `#die-cut` and `#sticker` filters in app/index.html,
// thick ink outlines that read from three steps back, no gradients and no soft shadows.
//
// Depth shows the same way in all three: far-side limbs drawn first and darker, a torso that narrows as
// the body turns, a face that slides round with the turn and is gone when the back is to us, and a hat
// whose far point goes behind the head and whose bells lag behind it.
//
// Also the stage behind the guide: a navy backdrop and the shoebox floor, drawn once per size and reused.

import type { Landmark } from "../../../engine/src/index.ts";
import type { Depth, Turn } from "../../../clip/src/index.ts";

type P = [number, number];

/**
 * How the puppet is built. d: a solid 3D jester (puppet3d.ts), drawn as one die-cut sticker. a: the flat
 * jester as one die-cut sticker. b: the flat jester in layered cut paper. (The jointed paper doll is gone:
 * pins and joints read as a toy, not a body.)
 */
export type Construction = "a" | "b" | "d";
export const CONSTRUCTIONS: Record<Construction, string> = {
  d: "3D jester: a solid body of round shapes, posed in depth from the tracker, as one die-cut sticker",
  a: "Flat sticker: the jester drawn flat, one white edge and one hard shadow",
  b: "Flat cut paper: the jester drawn flat, every piece casting a hard shadow on the one below",
};
/** The stage: the frontend agent's navy backdrop and shoebox floor, with or without a flat spotlight. */
export type StageLook = "plain" | "spot";

// The look's tokens (app/src/style.css) and the frontend agent's stage colour.
const INK = "#1E1B18";
const PHOTO = "#FFFFFF";
/** --wood: the puppet's face and hands, warm like the jester sprites' skin rather than a white mask. */
const WOOD = "#EDCB8E";
const GOLD = "#F4BE1A";
const STAMP = "#D93A2B";
const NAVY = "#2E4593";
/** The shoebox's own browns: --floor-c and --side-c planks with --ceil-c seams. */
const FLOOR = "#93613A";
const SIDE = "#774C2B";
const CEIL = "#5C3A20";
/** --shade: ink at 34 percent, the look's only shadow colour. */
const SHADE = "rgba(30,27,24,0.34)";
const SHADE_ALPHA = 0.34;
/** --ticket (#FFC93C) at a given strength, for the spotlight. */
const ticketAt = (a: number) => `rgba(255,201,60,${a})`;
const SEEN = 0.5;
const TAU = Math.PI * 2;

// MediaPipe Pose landmark numbers.
const NOSE = 0, L_EAR = 7, R_EAR = 8;
const L_SHOULDER = 11, R_SHOULDER = 12, L_ELBOW = 13, R_ELBOW = 14, L_WRIST = 15, R_WRIST = 16;
const L_PINKY = 17, R_PINKY = 18, L_INDEX = 19, R_INDEX = 20;
const L_HIP = 23, R_HIP = 24, L_KNEE = 25, R_KNEE = 26, L_ANKLE = 27, R_ANKLE = 28;
const L_HEEL = 29, R_HEEL = 30, L_TOE = 31, R_TOE = 32;

// ---- Colour ----

function parseColor(color: string): [number, number, number] | null {
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(color.trim());
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? m[1]!.split("").map((c) => c + c).join("") : m[1]!;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** `color` mixed toward `toward` by `t`, like CSS color-mix in srgb. Colours it cannot read come back unchanged. */
function mix(color: string, toward: string, t: number): string {
  const a = parseColor(color), b = parseColor(toward);
  if (!a || !b) return color;
  const c = a.map((v, i) => Math.round(v + (b[i]! - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/**
 * The jester colourways players pick from beside their names, each a two-colour suit like the jester
 * sprites. The first four are the skin's player colours (--p1 to --p4) with the partners the sprites give
 * them (art/jester/jester.py, PLAYERS), so the face badges still match. The rest: --stamp with --gold,
 * orange (half --stamp, half --ticket) with --pen, and the jester art's purple with --gold. (The classic
 * purple and red together stay the host's.)
 */
export const JESTER_COLOURS: readonly { name: string; main: string; second: string }[] = [
  { name: "Pink", main: "#F47FA6", second: "#6B2FB3" },
  { name: "Blue", main: "#4F7BF0", second: "#FFC93C" },
  { name: "Yellow", main: "#FFC93C", second: "#D93A2B" },
  { name: "Green", main: "#3FBF8F", second: "#4F7BF0" },
  { name: "Red", main: "#D93A2B", second: "#F4BE1A" },
  { name: "Orange", main: "#EC8234", second: "#2848C8" },
  { name: "Purple", main: "#6B2FB3", second: "#F4BE1A" },
];

/** The colourway whose main colour is `color` (any case), if it is one. */
export function colourwayOf(color: string) {
  const key = color.trim().toLowerCase();
  return JESTER_COLOURS.find((c) => c.main.toLowerCase() === key) ?? null;
}

/**
 * The player's suit: their colour as it is, lighter on the near side (80 percent with 20 percent --photo),
 * darker in shade (72 percent with 28 percent --ink), and the colourway's second colour with its own shade.
 * A colour that is no colourway pairs with its own dark shade.
 */
export interface Suit { base: string; light: string; dark: string; second: string; secondDark: string }

export function suitFor(color: string): Suit {
  const second = colourwayOf(color)?.second ?? mix(color, INK, 0.28);
  return { base: color, light: mix(color, PHOTO, 0.2), dark: mix(color, INK, 0.28), second, secondDark: mix(second, INK, 0.28) };
}

// ---- Geometry ----

const add = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1]];
const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]];
const mul = (a: P, k: number): P => [a[0] * k, a[1] * k];
const len = (a: P) => Math.hypot(a[0], a[1]);
const lerpP = (a: P, b: P, t: number): P => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const mid = (a: P, b: P): P => lerpP(a, b, 0.5);
const unit = (a: P, fallback: P = [0, -1]): P => { const l = len(a); return l > 1e-6 ? [a[0] / l, a[1] / l] : fallback; };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smoothstep = (lo: number, hi: number, v: number) => { const t = clamp((v - lo) / (hi - lo), 0, 1); return t * t * (3 - 2 * t); };

/** A capsule from `a` (radius `ra`) to `b` (radius `rb`), as a path. */
function taperPath(ctx: CanvasRenderingContext2D, a: P, b: P, ra: number, rb: number) {
  const d = sub(b, a), l = len(d);
  ctx.beginPath();
  if (l < 1e-3 || Math.abs(ra - rb) >= l) {
    ctx.arc(a[0], a[1], Math.max(ra, rb), 0, TAU);
    return;
  }
  const ang = Math.atan2(d[1], d[0]);
  const side = Math.PI / 2 + Math.asin((ra - rb) / l);
  ctx.arc(b[0], b[1], rb, ang - side, ang + side);
  ctx.arc(a[0], a[1], ra, ang + side, ang - side + TAU);
  ctx.closePath();
}

// ---- Pieces ----

/**
 * One cut piece of the puppet. `outline` traces its outer edge (for its white edge and its shadow); `art`
 * paints it, ink outline included.
 */
interface Piece { outline: (ctx: CanvasRenderingContext2D) => void; art: (ctx: CanvasRenderingContext2D) => void }

const plain = (outline: (ctx: CanvasRenderingContext2D) => void, fill: string, ink: number): Piece => ({
  outline,
  art: (ctx) => { outline(ctx); ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = ink; ctx.strokeStyle = INK; ctx.stroke(); },
});

export interface PuppetPose {
  landmarks: readonly Landmark[];
  /** The tracker's depth for these landmarks, when the guide kept it; it sets which limbs are in front. */
  depth: Depth | null;
  turn: Turn;
  /** The subject's torso length (shoulders to hips) in canvas pixels; every size is a share of it. */
  torso: number;
}

/** Remembers the head between frames on one canvas, so the hat's bells can lag behind it. */
export interface Swing { head: P | null; lag: P }
export const newSwing = (): Swing => ({ head: null, lag: [0, 0] });

/**
 * Draws the puppet. `map` turns normalized image coordinates into canvas pixels (the guide's view), so
 * every joint sits exactly where the stick figure's would.
 */
export function drawPuppet(
  ctx: CanvasRenderingContext2D, pose: PuppetPose, map: (x: number, y: number) => P, suit: Suit,
  construction: Construction = "a", swing?: Swing,
) {
  const { landmarks: lm, turn } = pose;
  const T = pose.torso;
  const at = (i: number): P | null => { const l = lm[i]; return l && l[2] >= SEEN ? map(l[0], l[1]) : null; };
  // Thick enough to read from three steps back; never a hairline.
  const ink = Math.max(2.5, T * 0.055);
  const sinY = Math.sin(turn.yaw);

  const ls = at(L_SHOULDER), rs = at(R_SHOULDER), lh = at(L_HIP), rh = at(R_HIP);
  const sm = ls && rs ? mid(ls, rs) : ls ?? rs;
  const hmSeen = lh && rh ? mid(lh, rh) : lh ?? rh;
  const up = sm && hmSeen ? unit(sub(sm, hmSeen)) : ([0, -1] as P);
  const hm = hmSeen ?? (sm ? sub(sm, mul(up, T)) : null);

  // Each side's colour: the right side light and the left as it is, easing into the far shade as that side
  // turns away (a blend, so nothing snaps from one colour to the other mid-turn).
  const farness = (side: 1 | -1) => smoothstep(0.12, 0.42, side * sinY);
  const sideColor = (side: 1 | -1) => mix(side === -1 ? suit.light : suit.base, suit.dark, farness(side));

  const depthOf = (ids: number[]): number | null => {
    if (!pose.depth || pose.depth.length !== lm.length) return null;
    const zs = ids.filter((i) => (lm[i]?.[2] ?? 0) >= SEEN).map((i) => pose.depth![i]!);
    return zs.length ? zs.reduce((s, z) => s + z, 0) / zs.length : null;
  };
  const torsoZ = depthOf([L_SHOULDER, R_SHOULDER, L_HIP, R_HIP]);
  // Without depth: arms in front of the chest when the face is toward us, behind it when the back is.
  const armBias = -0.2 + 0.35 * (1 - turn.face);
  const keyOf = (ids: number[], side: 1 | -1, bias: number) => {
    const z = depthOf(ids);
    if (z !== null && torsoZ !== null) return z - torsoZ + bias * 0.1;
    return side * sinY * 0.5 + bias;
  };

  const groups: { key: number; pieces: Piece[] }[] = [];
  for (const side of [1, -1] as const) {
    const left = side === 1;
    const color = sideColor(side);
    const thin = 1 - 0.08 * farness(side);
    const [sh, el, wr, pi, ix] = left ? [L_SHOULDER, L_ELBOW, L_WRIST, L_PINKY, L_INDEX] : [R_SHOULDER, R_ELBOW, R_WRIST, R_PINKY, R_INDEX];
    const [hp, kn, an, he, to] = left ? [L_HIP, L_KNEE, L_ANKLE, L_HEEL, L_TOE] : [R_HIP, R_KNEE, R_ANKLE, R_HEEL, R_TOE];
    groups.push({
      key: keyOf([hp, kn, an], side, 0.08),
      pieces: limbPieces([at(hp), at(kn), at(an)], [0.25, 0.2, 0.16].map((r) => r * T * thin), color, ink, footPiece(at(an), at(he), at(to), at(kn), T * thin, suit.dark, ink)),
    });
    groups.push({
      key: keyOf([sh, el, wr], side, armBias),
      pieces: limbPieces([at(sh), at(el), at(wr)], [0.19, 0.16, 0.135].map((r) => r * T * thin), color, ink, handPiece(at(wr), at(el), at(ix), at(pi), T * thin, ink)),
    });
  }
  if (sm && hm) groups.push({ key: 0, pieces: torsoPieces({ ls, rs, lh, rh, sm, hm, up }, T, turn, sideColor, ink) });
  groups.sort((a, b) => b.key - a.key);
  const pieces = [...groups.flatMap((g) => g.pieces), ...headPieces(at, sm, up, T, turn, suit, sideColor, ink, swing)];

  floorShadow(ctx, lm, map, T);
  const rim = Math.max(3, T * 0.07);
  const drop: P = [Math.max(3, T * 0.045), Math.max(4, T * 0.055)];
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (construction === "b") {
    // Layered cut paper: each piece throws its own hard shadow onto whatever is under it.
    const small = mul(drop, 0.6);
    for (const p of pieces) {
      ctx.save();
      ctx.translate(small[0], small[1]);
      p.outline(ctx);
      ctx.fillStyle = SHADE; ctx.fill();
      ctx.lineWidth = ink; ctx.strokeStyle = SHADE; ctx.stroke();
      ctx.restore();
      p.art(ctx);
    }
  } else {
    // One sticker: a white edge round the whole figure and one hard shadow, as the #die-cut filter does.
    silhouette(ctx, pieces, rim + ink / 2, drop);
    for (const p of pieces) p.art(ctx);
  }
  ctx.restore();
}

const silhouettes = new WeakMap<object, HTMLCanvasElement>();

/** Every piece's outline grown by `grow`, as a hard --shade shadow offset by `drop` and (unless `white` is false) a white edge. */
function silhouette(ctx: CanvasRenderingContext2D, pieces: Piece[], grow: number, drop: P, white = true) {
  const host = ctx.canvas;
  let layer = silhouettes.get(host);
  if (!layer) { layer = document.createElement("canvas"); silhouettes.set(host, layer); }
  if (layer.width !== host.width || layer.height !== host.height) { layer.width = host.width; layer.height = host.height; }
  const l = layer.getContext("2d")!;
  l.globalCompositeOperation = "source-over";
  l.clearRect(0, 0, layer.width, layer.height);
  l.lineJoin = "round"; l.lineCap = "round";
  l.fillStyle = INK; l.strokeStyle = INK; l.lineWidth = grow * 2;
  for (const p of pieces) { p.outline(l); l.fill(); l.stroke(); }
  ctx.save();
  ctx.globalAlpha = SHADE_ALPHA;
  ctx.drawImage(layer, drop[0], drop[1]);
  ctx.restore();
  if (!white) return;
  l.globalCompositeOperation = "source-in";
  l.fillStyle = PHOTO;
  l.fillRect(0, 0, layer.width, layer.height);
  l.globalCompositeOperation = "source-over";
  ctx.drawImage(layer, 0, 0);
}

/** The hard --shade ellipse under the feet. */
export function floorShadow(ctx: CanvasRenderingContext2D, lm: readonly Landmark[], map: (x: number, y: number) => P, T: number) {
  const feet = [L_ANKLE, R_ANKLE, L_HEEL, R_HEEL, L_TOE, R_TOE].map((i) => lm[i]).filter((l): l is Landmark => !!l && l[2] >= SEEN).map((l) => map(l[0], l[1]));
  if (!feet.length) return;
  const xs = feet.map((p) => p[0]);
  const y = Math.max(...feet.map((p) => p[1])) + T * 0.04;
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  ctx.beginPath(); ctx.ellipse(cx, y, (Math.max(...xs) - Math.min(...xs)) / 2 + T * 0.45, T * 0.11, 0, 0, TAU);
  ctx.fillStyle = SHADE;
  ctx.fill();
}

/** Upper and lower segments, a white cuff and whatever ends the limb, each only where its joints are seen. */
function limbPieces(joints: (P | null)[], radii: number[], color: string, ink: number, end: Piece | null): Piece[] {
  const [a, b, c] = joints;
  const [ra, rb, rc] = radii as [number, number, number];
  const out: Piece[] = [];
  if (a && b) out.push(plain((ctx) => taperPath(ctx, a, b, ra, rb), color, ink));
  if (b && c) {
    out.push(plain((ctx) => taperPath(ctx, b, c, rb, rc), color, ink));
    const d = unit(sub(c, b));
    out.push(plain((ctx) => taperPath(ctx, sub(c, mul(d, rc * 0.8)), add(c, mul(d, rc * 0.2)), rc * 1.25, rc * 1.25), PHOTO, ink * 0.85));
    if (end) out.push(end);
  }
  return out;
}

/** A round mitten past the wrist, toward the fingers when they are seen. */
function handPiece(wrist: P | null, elbow: P | null, index: P | null, pinky: P | null, T: number, ink: number): Piece | null {
  if (!wrist) return null;
  const fingers = index && pinky ? mid(index, pinky) : index ?? pinky;
  const dir = fingers ? unit(sub(fingers, wrist)) : elbow ? unit(sub(wrist, elbow)) : ([0, 1] as P);
  const reach = fingers ? clamp(len(sub(fingers, wrist)) * 0.7, T * 0.08, T * 0.2) : T * 0.12;
  const c = add(wrist, mul(dir, reach));
  return plain((ctx) => { ctx.beginPath(); ctx.arc(c[0], c[1], T * 0.17, 0, TAU); }, WOOD, ink);
}

/** A round jester shoe from heel to toe (else pointing on from the shin), with a gold pompom on the toe. */
function footPiece(ankle: P | null, heel: P | null, toe: P | null, knee: P | null, T: number, color: string, ink: number): Piece | null {
  if (!ankle) return null;
  const r = T * 0.13;
  let a: P, b: P;
  if (toe) { a = heel ?? ankle; b = toe; } else {
    const down = knee ? unit(sub(ankle, knee)) : ([0, 1] as P);
    a = ankle; b = add(ankle, mul(down, T * 0.12));
  }
  const d = unit(sub(b, a), [1, 0]);
  const tip = add(b, mul(d, r * 0.9));
  const shoe = (ctx: CanvasRenderingContext2D) => taperPath(ctx, add(a, mul(d, r * 0.1)), add(b, mul(d, r * 0.3)), r, r * 0.95);
  return {
    outline: (ctx) => { shoe(ctx); ctx.moveTo(tip[0] + r * 0.45, tip[1]); ctx.arc(tip[0], tip[1], r * 0.45, 0, TAU); },
    art: (ctx) => {
      shoe(ctx); ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = ink; ctx.strokeStyle = INK; ctx.stroke();
      ctx.beginPath(); ctx.arc(tip[0], tip[1], r * 0.45, 0, TAU);
      ctx.fillStyle = GOLD; ctx.fill(); ctx.lineWidth = ink * 0.8; ctx.stroke();
    },
  };
}

interface Frame { ls: P | null; rs: P | null; lh: P | null; rh: P | null; sm: P; hm: P; up: P }

/**
 * The torso: shoulders down to the hips with a waist, as wide as the joints show plus the body's depth as
 * it turns (seen side on, a chest is still about half a torso deep). Split down the front in the side
 * colours; the seam slides toward the far side as the body turns. Then a white paper ruff at the neck.
 */
function torsoPieces(f: Frame, T: number, turn: Turn, sideColor: (side: 1 | -1) => string, ink: number): Piece[] {
  const sinY = Math.sin(turn.yaw);
  const perp: P = [-f.up[1], f.up[0]];
  const across = (l: P | null, r: P | null): P => {
    if (l && r && len(sub(l, r)) > T * 0.05) return unit(sub(l, r));
    return perp[0] >= 0 ? perp : mul(perp, -1);
  };
  const sDir = across(f.ls, f.rs), hDir = across(f.lh, f.rh);
  const sSeen = f.ls && f.rs ? len(sub(f.ls, f.rs)) : T * 0.7;
  const hSeen = f.lh && f.rh ? len(sub(f.lh, f.rh)) * 1.5 : T * 0.6;
  const wS = Math.max(Math.hypot(sSeen * 1.08, T * 0.47 * sinY), T * 0.34);
  const wH = Math.max(Math.hypot(hSeen, T * 0.42 * sinY), T * 0.3);
  const sL = add(f.sm, mul(sDir, wS / 2)), sR = sub(f.sm, mul(sDir, wS / 2));
  const hL = add(f.hm, mul(hDir, wH / 2)), hR = sub(f.hm, mul(hDir, wH / 2));
  // A round tummy, not a waist: cartoon, not mannequin.
  const waist = lerpP(f.sm, f.hm, 0.62), wDir = unit(add(sDir, hDir), sDir), wW = (wS * 0.38 + wH * 0.62) * 1.04;
  const wL = add(waist, mul(wDir, wW / 2)), wR = sub(waist, mul(wDir, wW / 2));
  const outline = (ctx: CanvasRenderingContext2D) => {
    ctx.beginPath();
    ctx.moveTo(sR[0], sR[1]);
    const top = add(f.sm, mul(f.up, T * 0.07));
    ctx.quadraticCurveTo(top[0], top[1], sL[0], sL[1]);
    ctx.quadraticCurveTo(wL[0] + (sL[0] - wL[0]) * 0.1, wL[1] + (sL[1] - wL[1]) * 0.1, wL[0], wL[1]);
    ctx.quadraticCurveTo(lerpP(wL, hL, 0.6)[0], lerpP(wL, hL, 0.6)[1], hL[0], hL[1]);
    const bottom = sub(f.hm, mul(f.up, T * 0.1));
    ctx.quadraticCurveTo(bottom[0], bottom[1], hR[0], hR[1]);
    ctx.quadraticCurveTo(lerpP(wR, hR, 0.6)[0], lerpP(wR, hR, 0.6)[1], wR[0], wR[1]);
    ctx.quadraticCurveTo(wR[0] + (sR[0] - wR[0]) * 0.1, wR[1] + (sR[1] - wR[1]) * 0.1, sR[0], sR[1]);
    ctx.closePath();
  };
  const s = clamp(0.5 + 0.4 * sinY, 0.08, 0.92);
  const seamTop = lerpP(sR, sL, s), seamBottom = lerpP(hR, hL, s);
  const reach = T * 3;
  const body: Piece = {
    outline,
    art: (ctx) => {
      ctx.save();
      outline(ctx);
      ctx.clip();
      for (const dir of [1, -1] as const) {
        const out = mul(sDir, reach * dir);
        ctx.beginPath();
        ctx.moveTo(...add(seamTop, mul(f.up, reach)));
        ctx.lineTo(...add(add(seamTop, mul(f.up, reach)), out));
        ctx.lineTo(...add(add(seamBottom, mul(f.up, -reach)), out));
        ctx.lineTo(...add(seamBottom, mul(f.up, -reach)));
        ctx.closePath();
        ctx.fillStyle = sideColor(dir);
        ctx.fill();
      }
      ctx.beginPath(); ctx.moveTo(...seamTop); ctx.lineTo(...seamBottom);
      ctx.lineWidth = ink * 0.7; ctx.strokeStyle = INK; ctx.stroke();
      // Ink buttons down the seam, only on the front.
      if (turn.face > 0.5) {
        for (const t of [0.3, 0.5, 0.7]) {
          const b = lerpP(seamTop, seamBottom, t);
          ctx.beginPath(); ctx.arc(b[0], b[1], Math.max(2.5, T * 0.05), 0, TAU);
          ctx.fillStyle = INK; ctx.fill();
        }
      }
      ctx.restore();
      outline(ctx);
      ctx.lineWidth = ink; ctx.strokeStyle = INK; ctx.stroke();
    },
  };
  // A white paper ruff round the neck, flattened by the angle we see it from.
  const n = 8, rx = wS * 0.5, ry = T * 0.16;
  const c = add(f.sm, mul(f.up, T * 0.02));
  const ruff = plain((ctx) => {
    ctx.beginPath();
    for (let k = 0; k < n * 2; k++) {
      const a = (k * Math.PI) / n;
      const r = k % 2 === 0 ? 1.2 : 0.78;
      const p = add(c, add(mul(sDir, Math.cos(a) * rx * r), mul(f.up, -Math.sin(a) * ry * r)));
      if (k === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
    }
    ctx.closePath();
  }, PHOTO, ink * 0.85);
  return [body, ruff];
}

/** A point on the head's front, at (x, y) in head radii, turned by the yaw: where it lands and how much it faces us. */
function onSphere(x: number, y: number, sinY: number, cosY: number): { x: number; y: number; toward: number } {
  const z = -Math.sqrt(Math.max(0, 1 - x * x - y * y));
  return { x: x * cosY - z * sinY, y, toward: -(x * sinY + z * cosY) };
}

/** The head's radius as a share of the torso: big and round, like the jester sprites, so it reads as a cartoon. */
export const HEAD = 0.5;
/** How far the hat reaches from the head's middle, in head radii: out to the bells and up to its top. */
export const HAT_REACH = { side: 1.95, up: 1.55 };

/**
 * The head with its hat. It sits between the ears (else at the nose, else above the shoulders) and leans
 * with the neck. A friendly cartoon face (big shiny eyes, happy brows, a red clown nose, an open smile, the
 * jester's diamond cheeks) rides round the front with the turn and fades as it goes round the side. As the
 * back comes round the cap slides down into a hood in the suit's colours, so a back is a hooded head, not a
 * blank one. The hat's far point is drawn behind the head and its near point in front.
 */
function headPieces(
  at: (i: number) => P | null, sm: P | null, up: P, T: number, turn: Turn, suit: Suit,
  sideColor: (side: 1 | -1) => string, ink: number, swing: Swing | undefined,
): Piece[] {
  const le = at(L_EAR), re = at(R_EAR), nose = at(NOSE);
  const R = T * HEAD;
  let found: P | null = le && re ? mid(le, re) : le ?? re ?? nose;
  if (!found && sm) found = add(sm, mul(up, R * 1.1));
  if (!found) return [];
  const hUp: P = sm && len(sub(found, sm)) > T * 0.2 ? unit(sub(found, sm)) : up;
  const center = add(found, mul(hUp, R * 0.1));
  const hRight: P = [-hUp[1], hUp[0]];
  const toScreen = (x: number, y: number): P => add(center, add(mul(hRight, x * R), mul(hUp, y * R)));
  const sinY = Math.sin(turn.yaw), cosY = Math.cos(turn.yaw);
  const face = clamp(turn.face, 0, 1);

  // The bells lag behind the head as it moves.
  let lag: P = [0, 0];
  if (swing) {
    if (swing.head) {
      const moved = sub(center, swing.head);
      const target = len(moved) > R * 3 ? ([0, 0] as P) : mul(moved, -3);
      swing.lag = lerpP(swing.lag, target, 0.25);
      if (len(swing.lag) > R * 0.6) swing.lag = mul(unit(swing.lag), R * 0.6);
    }
    swing.head = center;
    lag = swing.lag;
  }

  // The hat's two floppy points in head space (x toward the subject's left, y up, z away from the camera).
  const horn = (side: 1 | -1): Piece & { z: number } => {
    const pts: P[] = [];
    let z = 0;
    const ctrl: [number, number, number][] = [[0.3 * side, 0.82, 0.1], [1.2 * side, 1.35, 0.25], [1.62 * side, 0.5, 0.3]];
    for (let i = 0; i <= 14; i++) {
      const t = i / 14, u = 1 - t;
      const q = [0, 1, 2].map((k) => u * u * ctrl[0]![k]! + 2 * u * t * ctrl[1]![k]! + t * t * ctrl[2]![k]!) as [number, number, number];
      pts.push(add(toScreen(q[0] * cosY - q[2] * sinY, q[1]), mul(lag, t * t)));
      z = q[0] * sinY + q[2] * cosY;
    }
    const width = (t: number) => R * (0.5 * (1 - t) + 0.13 * t);
    const leftEdge: P[] = [], rightEdge: P[] = [];
    pts.forEach((p, i) => {
      const a = pts[Math.max(0, i - 1)]!, b = pts[Math.min(pts.length - 1, i + 1)]!;
      const n = unit([-(b[1] - a[1]), b[0] - a[0]], [1, 0]);
      const w = width(i / (pts.length - 1));
      leftEdge.push(add(p, mul(n, w))); rightEdge.push(sub(p, mul(n, w)));
    });
    const tip = pts[pts.length - 1]!;
    const bell = add(tip, mul(hUp, -R * 0.14));
    const br = R * 0.26;
    const point = (ctx: CanvasRenderingContext2D) => {
      ctx.beginPath();
      leftEdge.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
      for (let i = rightEdge.length - 1; i >= 0; i--) ctx.lineTo(rightEdge[i]![0], rightEdge[i]![1]);
      ctx.closePath();
    };
    const color = mix(side === -1 ? suit.light : suit.base, suit.dark, smoothstep(0.3, 0.9, z));
    return {
      z,
      outline: (ctx) => { point(ctx); ctx.moveTo(bell[0] + br, bell[1]); ctx.arc(bell[0], bell[1], br, 0, TAU); },
      art: (ctx) => {
        point(ctx);
        ctx.fillStyle = color;
        ctx.fill(); ctx.lineWidth = ink; ctx.strokeStyle = INK; ctx.stroke();
        ctx.beginPath(); ctx.arc(bell[0], bell[1], br, 0, TAU);
        ctx.fillStyle = GOLD; ctx.fill(); ctx.lineWidth = ink * 0.85; ctx.stroke();
        ctx.beginPath(); ctx.moveTo(...sub(bell, mul(hRight, br * 0.5))); ctx.lineTo(...add(bell, mul(hRight, br * 0.5)));
        ctx.lineWidth = Math.max(2, ink * 0.7); ctx.stroke();
      },
    };
  };
  const horns = ([1, -1] as const).map(horn);
  const behind = horns.filter((h) => h.z >= -0.05);
  const before = horns.filter((h) => h.z < -0.05);

  const headOutline = (ctx: CanvasRenderingContext2D) => { ctx.beginPath(); ctx.arc(center[0], center[1], R, 0, TAU); };
  // A short neck only shows when the head is well clear of the collar.
  const neck: Piece | null = sm && len(sub(center, sm)) > R * 1.05 ? plain((ctx) => taperPath(ctx, sm, center, T * 0.14, T * 0.13), WOOD, ink) : null;
  const head: Piece = {
    outline: headOutline,
    art: (ctx) => {
      headOutline(ctx);
      ctx.fillStyle = WOOD; ctx.fill();
      ctx.save();
      headOutline(ctx);
      ctx.clip();
      // The face, riding round the front with the turn. Each feature fades as it goes round the side or the
      // back comes round, instead of popping.
      if (face > 0.02) {
        const feature = (x: number, y: number, draw: (p: P, squash: number) => void) => {
          const s = onSphere(x, y, sinY, cosY);
          // Features stay until they are right round the side, so a profile still has an eye.
          const show = face * smoothstep(-0.05, 0.3, s.toward);
          if (show <= 0.02) return;
          ctx.globalAlpha = show;
          draw(toScreen(s.x, s.y), clamp(s.toward, 0.3, 1));
          ctx.globalAlpha = 1;
        };
        const tilt = Math.atan2(hRight[1], hRight[0]);
        for (const x of [-0.3, 0.3]) {
          // Big eyes with a shine.
          feature(x, 0.04, (p, sq) => {
            ctx.beginPath(); ctx.ellipse(p[0], p[1], R * 0.12 * sq, R * 0.17, tilt, 0, TAU);
            ctx.fillStyle = INK; ctx.fill();
            const glint = add(p, add(mul(hRight, -R * 0.035 * sq), mul(hUp, R * 0.06)));
            ctx.beginPath(); ctx.arc(glint[0], glint[1], R * 0.05, 0, TAU);
            ctx.fillStyle = PHOTO; ctx.fill();
          });
          // Happy brows.
          feature(x, 0.31, (p, sq) => {
            ctx.beginPath();
            ctx.moveTo(...add(p, mul(hRight, -R * 0.1 * sq)));
            ctx.quadraticCurveTo(...add(p, mul(hUp, R * 0.07)), ...add(p, mul(hRight, R * 0.1 * sq)));
            ctx.lineWidth = Math.max(2, ink * 0.65); ctx.strokeStyle = INK; ctx.stroke();
          });
          // The jester's diamond cheeks.
          feature(x * 1.7, -0.22, (p, sq) => {
            const w = R * 0.1 * sq, h = R * 0.13;
            ctx.beginPath();
            ctx.moveTo(...add(p, mul(hUp, h))); ctx.lineTo(...add(p, mul(hRight, w)));
            ctx.lineTo(...sub(p, mul(hUp, h))); ctx.lineTo(...sub(p, mul(hRight, w)));
            ctx.closePath(); ctx.fillStyle = STAMP; ctx.fill();
          });
        }
        // An open smile, drawn from points on the head's front so it bends round with the turn.
        const lip: [number, number][] = [];
        for (let i = 0; i <= 10; i++) { const x = -0.3 + 0.06 * i; lip.push([x, -0.3 - 0.04 * (1 - (x / 0.3) ** 2)]); }
        for (let i = 10; i >= 0; i--) { const x = -0.3 + 0.06 * i; lip.push([x, -0.3 - 0.27 * Math.sqrt(Math.max(0, 1 - (x / 0.3) ** 2))]); }
        const mouth = lip.map(([x, y]) => onSphere(x, y, sinY, cosY));
        const mouthShow = face * smoothstep(0, 0.35, Math.min(...mouth.map((m) => m.toward)));
        if (mouthShow > 0.02) {
          ctx.globalAlpha = mouthShow;
          ctx.beginPath();
          mouth.forEach((m, i) => { const q = toScreen(m.x, m.y); if (i === 0) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]); });
          ctx.closePath();
          ctx.fillStyle = INK; ctx.fill();
          const tongue = onSphere(0, -0.5, sinY, cosY);
          const tq = toScreen(tongue.x, tongue.y);
          ctx.beginPath(); ctx.ellipse(tq[0], tq[1], R * 0.13 * clamp(tongue.toward, 0.3, 1), R * 0.065, Math.atan2(hRight[1], hRight[0]), 0, TAU);
          ctx.fillStyle = STAMP; ctx.fill();
          ctx.globalAlpha = 1;
        }
      }
      // The cap over the top of the head, split in the side colours along the front seam. As the back comes
      // round it slides down into a hood over the whole head.
      const brim = 0.42 + (-1.2 - 0.42) * (1 - face);
      const seam = onSphere(0, Math.max(-0.95, Math.min(0.95, brim)), sinY, cosY).x;
      for (const side of [1, -1] as const) {
        ctx.beginPath();
        ctx.moveTo(...toScreen(seam, brim + 3)); ctx.lineTo(...toScreen(seam, brim - 0.05));
        ctx.lineTo(...toScreen(side * 2, brim - 0.05)); ctx.lineTo(...toScreen(side * 2, brim + 3));
        ctx.closePath();
        ctx.fillStyle = sideColor(side);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.moveTo(...toScreen(-1.2, brim - 0.05)); ctx.lineTo(...toScreen(1.2, brim - 0.05));
      ctx.moveTo(...toScreen(seam, brim - 0.05)); ctx.lineTo(...toScreen(seam, brim + 3));
      ctx.lineWidth = ink * 0.8; ctx.strokeStyle = INK; ctx.stroke();
      ctx.restore();
      headOutline(ctx);
      ctx.lineWidth = ink; ctx.strokeStyle = INK; ctx.stroke();
      // A round red clown nose that stands off the face, so in profile it pokes out past the head and shows
      // which way the puppet looks.
      const noseAt = onSphere(0, -0.1, sinY, cosY);
      const noseShow = face * smoothstep(-0.25, 0.1, noseAt.toward);
      if (noseShow > 0.02) {
        const q = toScreen(noseAt.x * 1.1, noseAt.y);
        ctx.globalAlpha = noseShow;
        ctx.beginPath(); ctx.arc(q[0], q[1], R * 0.12, 0, TAU);
        ctx.fillStyle = STAMP; ctx.fill(); ctx.lineWidth = Math.max(2, ink * 0.7); ctx.strokeStyle = INK; ctx.stroke();
        ctx.globalAlpha = 1;
      }
    },
  };
  return [...behind, ...(neck ? [neck] : []), head, ...before];
}

// ---- The stage ----

export interface StageSpot {
  /** Where the floor's back edge meets the backdrop, in canvas pixels from the top. */
  floorY: number;
  /** The middle of the subject's usual spot, in canvas pixels from the left. */
  spotX: number;
}

const stages = new Map<string, HTMLCanvasElement>();

/** The stage for this canvas size, drawn once and kept (a handful of sizes at most per game). */
export function stageImage(width: number, height: number, spot: StageSpot, look: StageLook = "plain"): HTMLCanvasElement {
  const floorY = Math.round(spot.floorY), spotX = Math.round(spot.spotX);
  const key = `${look}:${width}x${height}:${floorY}:${spotX}`;
  const kept = stages.get(key);
  if (kept) return kept;
  if (stages.size > 12) stages.clear();
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  drawStage(canvas.getContext("2d")!, width, height, floorY, spotX, look);
  stages.set(key, canvas);
  return canvas;
}

/** The frontend agent's stage: a navy backdrop over the shoebox floor, flat and hard edged, with an optional flat spotlight. */
function drawStage(ctx: CanvasRenderingContext2D, w: number, h: number, floorY: number, spotX: number, look: StageLook) {
  ctx.fillStyle = NAVY;
  ctx.fillRect(0, 0, w, floorY);
  // Floor: planks running back to a vanishing point high above, in the shoebox's floor and side browns,
  // seams in its ceiling brown.
  const floorH = h - floorY;
  ctx.fillStyle = FLOOR;
  ctx.fillRect(0, floorY, w, floorH);
  const k = (h * 1.4) / (h - floorY + h * 1.4);
  const plank = Math.max(18, w * 0.08);
  const first = spotX - Math.ceil((spotX + w) / plank) * plank;
  let n = 0;
  for (let x = first; x < w * 2; x += plank, n++) {
    if (n % 2 === 0) continue;
    ctx.beginPath();
    ctx.moveTo(spotX + (x - spotX) * k, floorY); ctx.lineTo(spotX + (x + plank - spotX) * k, floorY);
    ctx.lineTo(x + plank, h); ctx.lineTo(x, h); ctx.closePath();
    ctx.fillStyle = SIDE; ctx.fill();
  }
  ctx.strokeStyle = CEIL;
  ctx.lineWidth = Math.max(2, w * 0.004);
  for (let x = first; x < w * 2; x += plank) {
    ctx.beginPath(); ctx.moveTo(spotX + (x - spotX) * k, floorY); ctx.lineTo(x, h); ctx.stroke();
  }
  // Where the backdrop meets the floor, a hard shadow band.
  ctx.fillStyle = SHADE;
  ctx.fillRect(0, floorY, w, Math.max(4, floorH * 0.16));
  if (look === "spot") {
    const poolY = floorY + floorH * 0.5, poolRx = w * 0.3, poolRy = Math.max(6, floorH * 0.3);
    ctx.fillStyle = ticketAt(0.16);
    ctx.beginPath();
    ctx.moveTo(spotX - w * 0.05, 0); ctx.lineTo(spotX + w * 0.05, 0);
    ctx.lineTo(spotX + poolRx, poolY); ctx.lineTo(spotX - poolRx, poolY);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = ticketAt(0.24);
    ctx.beginPath(); ctx.ellipse(spotX, poolY, poolRx, poolRy, 0, 0, TAU); ctx.fill();
  }
}
