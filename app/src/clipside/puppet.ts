// The blind mode guide as a jester puppet, drawn in code on the same 2D canvas and at the same places as
// the stick figure (the player uses the guide to find their place in the frame). Filled, tapered limbs, a
// torso that follows the shoulders and hips and narrows as the body turns, far-side limbs drawn first and
// darker, a head whose face slides round with the turn and is gone when the back is to us, and a two-pointed
// hat whose bells lag behind the head. The look is the jester's (art/jester/jester.py): a two-colour suit
// in the player's colourway, gold collar, cuffs and bells, cream hands, blue shoes, ink outlines, toon shade.
//
// Also the stage behind the guide: a velvet backdrop, a plank floor and a spotlight, drawn once per size
// and reused every frame.

import type { Landmark } from "../../../engine/src/index.ts";
import type { Depth, Turn } from "../../../clip/src/index.ts";

type P = [number, number];

// No new colours: the outline is the look's --ink; the rest are the jester's own materials and its stage
// preview in art/jester/jester.py (suit, marigold, porcelain peach, cobalt shoes, rouge, ink features, and
// the stage's #282033 backdrop, #68442f and #805239 planks with #41291f seams, #ffe3a3 light).
const INK = "#1E1B18";
const GOLD = "#F2B630";
const SKIN = "#F6D9BE";
const SHOE = "#2F4BB8";
const CHEEK = "#D4243A";
const FEATURES = "#211B32";
const BACKDROP = "#282033";
const PLANK_A = "#68442F", PLANK_B = "#805239", SEAM = "#41291F";
/** The spotlight's colour, as `rgba(...)` at a given strength. */
const light = (a: number) => `rgba(255,227,163,${a})`;
/** Darkness for shading and the vignette: the jester page's night colour (#15101f). */
const dark = (a: number) => `rgba(21,16,31,${a})`;
const SEEN = 0.5;
const TAU = Math.PI * 2;

// MediaPipe Pose landmark numbers.
const NOSE = 0, L_EAR = 7, R_EAR = 8;
const L_SHOULDER = 11, R_SHOULDER = 12, L_ELBOW = 13, R_ELBOW = 14, L_WRIST = 15, R_WRIST = 16;
const L_PINKY = 17, R_PINKY = 18, L_INDEX = 19, R_INDEX = 20;
const L_HIP = 23, R_HIP = 24, L_KNEE = 25, R_KNEE = 26, L_ANKLE = 27, R_ANKLE = 28;
const L_HEEL = 29, R_HEEL = 30, L_TOE = 31, R_TOE = 32;

/** Each player colour's partner in the jester's two-colour suit (PLAYERS and PALETTES in art/jester/jester.py). */
const PARTNERS: Record<string, string> = {
  "#f47fa6": "#6B2FB3", "#4f7bf0": "#FFC93C", "#ffc93c": "#D4243A", "#3fbf8f": "#4F7BF0",
  "#6b2fb3": "#D4243A", "#e8507a": "#6B2FB3", "#3b82c4": "#2E9E6B", "#f2c14e": "#D4243A",
};

/** The suit: the player's colour on the subject's right half (the viewer's left), its partner on the left. */
export interface Suit { right: string; left: string }

export function suitFor(color: string): Suit {
  const key = color.trim().toLowerCase();
  const rgb = parseHex(key);
  const reddish = rgb !== null && rgb[0] > 170 && rgb[1] < 110;
  return { right: color, left: PARTNERS[key] ?? (reddish ? "#6B2FB3" : "#D4243A") };
}

// ---- Colour ----

/** A colour as red, green and blue, from #rgb, #rrggbb or rgb(r,g,b); null for anything else. */
function parseHex(color: string): [number, number, number] | null {
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(color.trim());
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? m[1]!.split("").map((c) => c + c).join("") : m[1]!;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** `color` mixed toward `toward` by `t` (0 keeps it). Colours `parseHex` cannot read come back unchanged. */
function mix(color: string, toward: string, t: number): string {
  const a = parseHex(color), b = parseHex(toward);
  if (!a || !b || t <= 0) return color;
  const c = a.map((v, i) => Math.round(v + (b[i]! - v) * Math.min(1, t)));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/** The toon shadow tone: the colour at 82 percent, as the sprites' material does. */
function shadowOf(color: string): string {
  const a = parseHex(color);
  return a ? `rgb(${a.map((v) => Math.round(v * 0.82)).join(",")})` : color;
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
/** Light comes from the upper left, as in the sprites. */
const LIGHT: P = unit([-0.55, -0.83]);

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

/** A fill that is lit on the side facing the light and a hard toon shadow on the other, across `a` to `b`. */
function toonAcross(ctx: CanvasRenderingContext2D, a: P, b: P, r: number, color: string): CanvasGradient {
  let n = unit([-(b[1] - a[1]), b[0] - a[0]], [1, 0]);
  if (n[0] * LIGHT[0] + n[1] * LIGHT[1] > 0) n = mul(n, -1);
  const m = mid(a, b);
  const g = ctx.createLinearGradient(m[0] - n[0] * r, m[1] - n[1] * r, m[0] + n[0] * r, m[1] + n[1] * r);
  const dark = shadowOf(color);
  g.addColorStop(0, color); g.addColorStop(0.6, color); g.addColorStop(0.64, dark); g.addColorStop(1, dark);
  return g;
}

// ---- The puppet ----

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

interface Part { key: number; draw: () => void }

/**
 * Draws the puppet. `map` turns normalized image coordinates into canvas pixels (the guide's view), so
 * every joint sits exactly where the stick figure's would.
 */
export function drawPuppet(ctx: CanvasRenderingContext2D, pose: PuppetPose, map: (x: number, y: number) => P, suit: Suit, swing?: Swing) {
  const { landmarks: lm, turn } = pose;
  const T = pose.torso;
  const at = (i: number): P | null => { const l = lm[i]; return l && l[2] >= SEEN ? map(l[0], l[1]) : null; };
  const ink = Math.max(1.2, T * 0.035);
  const sinY = Math.sin(turn.yaw);
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = INK;
  ctx.lineWidth = ink;

  const ls = at(L_SHOULDER), rs = at(R_SHOULDER), lh = at(L_HIP), rh = at(R_HIP);
  const sm = ls && rs ? mid(ls, rs) : ls ?? rs;
  const hmSeen = lh && rh ? mid(lh, rh) : lh ?? rh;
  // Straight up the body: from the hips to the shoulders, else the screen's up.
  const up = sm && hmSeen ? unit(sub(sm, hmSeen)) : ([0, -1] as P);
  const hm = hmSeen ?? (sm ? sub(sm, mul(up, T)) : null);

  floorShadow(ctx, lm, map, T);

  // How far each side is turned away (0 near or square, 1 far), and the draw order key (bigger is farther).
  const farness = (side: 1 | -1) => clamp(side * sinY * 1.5, 0, 1);
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

  const parts: Part[] = [];
  const limbColor = (base: string, far: number) => mix(base, INK, 0.3 * far);
  for (const side of [1, -1] as const) {
    const left = side === 1;
    const base = left ? suit.left : suit.right;
    const far = farness(side);
    const thin = 1 - 0.1 * far;
    const color = limbColor(base, far);
    const [sh, el, wr, pi, ix] = left ? [L_SHOULDER, L_ELBOW, L_WRIST, L_PINKY, L_INDEX] : [R_SHOULDER, R_ELBOW, R_WRIST, R_PINKY, R_INDEX];
    const [hp, kn, an, he, to] = left ? [L_HIP, L_KNEE, L_ANKLE, L_HEEL, L_TOE] : [R_HIP, R_KNEE, R_ANKLE, R_HEEL, R_TOE];
    parts.push({
      key: keyOf([hp, kn, an], side, 0.08),
      draw: () => limb(ctx, [at(hp), at(kn), at(an)], [0.2, 0.15, 0.11].map((r) => r * T * thin), color, ink, far, () => foot(ctx, at(an), at(he), at(to), at(kn), T * thin, far, ink)),
    });
    parts.push({
      key: keyOf([sh, el, wr], side, armBias),
      draw: () => limb(ctx, [at(sh), at(el), at(wr)], [0.15, 0.12, 0.095].map((r) => r * T * thin), color, ink, far, () => hand(ctx, at(wr), at(el), at(ix), at(pi), T * thin, far, ink)),
    });
  }
  if (sm && hm) parts.push({ key: 0, draw: () => torso(ctx, { ls, rs, lh, rh, sm, hm, up }, T, turn, suit, ink) });
  parts.sort((a, b) => b.key - a.key);
  for (const part of parts) part.draw();

  head(ctx, at, sm, up, T, turn, suit, ink, swing);
  ctx.restore();
}

function floorShadow(ctx: CanvasRenderingContext2D, lm: readonly Landmark[], map: (x: number, y: number) => P, T: number) {
  const feet = [L_ANKLE, R_ANKLE, L_HEEL, R_HEEL, L_TOE, R_TOE].map((i) => lm[i]).filter((l): l is Landmark => !!l && l[2] >= SEEN).map((l) => map(l[0], l[1]));
  if (!feet.length) return;
  const xs = feet.map((p) => p[0]);
  const y = Math.max(...feet.map((p) => p[1])) + T * 0.03;
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const rx = (Math.max(...xs) - Math.min(...xs)) / 2 + T * 0.45, ry = T * 0.11;
  ctx.save();
  ctx.translate(cx, y);
  ctx.scale(rx / ry, 1);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, ry);
  g.addColorStop(0, dark(0.55)); g.addColorStop(0.6, dark(0.3)); g.addColorStop(1, dark(0));
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(0, 0, ry, 0, TAU); ctx.fill();
  ctx.restore();
}

/** Two tapered segments (upper and lower) and whatever ends the limb (a hand or a foot), each only where seen. */
function limb(ctx: CanvasRenderingContext2D, joints: (P | null)[], radii: number[], color: string, ink: number, far: number, end: () => void) {
  const [a, b, c] = joints;
  const [ra, rb, rc] = radii as [number, number, number];
  if (a && b) segment(ctx, a, b, ra, rb, color, ink);
  if (b && c) {
    segment(ctx, b, c, rb, rc, color, ink);
    // A gold cuff where the sleeve ends.
    const d = unit(sub(c, b));
    taperPath(ctx, sub(c, mul(d, rc * 0.9)), add(c, mul(d, rc * 0.15)), rc * 1.22, rc * 1.22);
    ctx.fillStyle = mix(GOLD, INK, 0.3 * far);
    ctx.fill(); ctx.lineWidth = ink * 0.8; ctx.stroke(); ctx.lineWidth = ink;
    end();
  }
}

function segment(ctx: CanvasRenderingContext2D, a: P, b: P, ra: number, rb: number, color: string, ink: number) {
  taperPath(ctx, a, b, ra, rb);
  ctx.fillStyle = toonAcross(ctx, a, b, Math.max(ra, rb), color);
  ctx.fill();
  ctx.lineWidth = ink;
  ctx.stroke();
}

/** A cream mitten past the wrist, toward the fingers when they are seen. */
function hand(ctx: CanvasRenderingContext2D, wrist: P | null, elbow: P | null, index: P | null, pinky: P | null, T: number, far: number, ink: number) {
  if (!wrist) return;
  const fingers = index && pinky ? mid(index, pinky) : index ?? pinky;
  const dir = fingers ? unit(sub(fingers, wrist)) : elbow ? unit(sub(wrist, elbow)) : ([0, 1] as P);
  const reach = fingers ? clamp(len(sub(fingers, wrist)) * 0.6, T * 0.06, T * 0.16) : T * 0.1;
  const c = add(wrist, mul(dir, reach));
  const r = T * 0.12;
  ctx.beginPath(); ctx.arc(c[0], c[1], r, 0, TAU);
  ctx.fillStyle = toonAcross(ctx, sub(c, mul(dir, r)), add(c, mul(dir, r)), r, mix(SKIN, INK, 0.3 * far));
  ctx.fill(); ctx.lineWidth = ink; ctx.stroke();
}

/** A blue shoe from heel to toe, else pointing on from the shin. */
function foot(ctx: CanvasRenderingContext2D, ankle: P | null, heel: P | null, toe: P | null, knee: P | null, T: number, far: number, ink: number) {
  if (!ankle) return;
  const color = mix(SHOE, INK, 0.3 * far);
  const r = T * 0.1;
  let a: P, b: P;
  if (toe) { a = heel ?? ankle; b = toe; } else {
    const down = knee ? unit(sub(ankle, knee)) : ([0, 1] as P);
    a = ankle; b = add(ankle, mul(down, T * 0.12));
  }
  // Toes stick out a little past the tracked point; the heel tucks in under the ankle.
  const d = unit(sub(b, a), [1, 0]);
  taperPath(ctx, add(a, mul(d, r * 0.2)), add(b, mul(d, r * 0.3)), r * 0.95, r);
  ctx.fillStyle = toonAcross(ctx, a, b, r, color);
  ctx.fill(); ctx.lineWidth = ink; ctx.stroke();
}

interface Frame { ls: P | null; rs: P | null; lh: P | null; rh: P | null; sm: P; hm: P; up: P }

/**
 * The torso: shoulders down to the hips with a waist, as wide as the joints show plus the body's depth as
 * it turns (seen side on, a chest is still about half a torso deep). Split down the front in the suit's two
 * colours; the seam slides toward the far side as the body turns, and the far half darkens.
 */
function torso(ctx: CanvasRenderingContext2D, f: Frame, T: number, turn: Turn, suit: Suit, ink: number) {
  const sinY = Math.sin(turn.yaw);
  // Across the body toward the subject's left (the image's right when they face us).
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
  const waist = lerpP(f.sm, f.hm, 0.62), wDir = unit(add(sDir, hDir), sDir), wW = (wS * 0.38 + wH * 0.62) * 0.86;
  const wL = add(waist, mul(wDir, wW / 2)), wR = sub(waist, mul(wDir, wW / 2));
  const outline = () => {
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
  // The front seam: from the middle toward the subject's left as they face the image's right.
  const s = clamp(0.5 + 0.4 * sinY, 0.08, 0.92);
  const seamTop = lerpP(sR, sL, s), seamBottom = lerpP(hR, hL, s);
  const far = clamp(Math.abs(sinY) * 1.5, 0, 1);
  const reach = T * 3;
  const halfPoly = (dir: 1 | -1) => {
    const out = mul(sDir, reach * dir);
    ctx.beginPath();
    ctx.moveTo(...add(seamTop, mul(f.up, reach)));
    ctx.lineTo(...add(add(seamTop, mul(f.up, reach)), out));
    ctx.lineTo(...add(add(seamBottom, mul(f.up, -reach)), out));
    ctx.lineTo(...add(seamBottom, mul(f.up, -reach)));
    ctx.closePath();
  };
  ctx.save();
  outline();
  ctx.clip();
  for (const dir of [1, -1] as const) {
    halfPoly(dir);
    const farHalf = dir === 1 ? sinY > 0 : sinY < 0;
    ctx.fillStyle = mix(dir === 1 ? suit.left : suit.right, INK, farHalf ? 0.3 * far : 0);
    ctx.fill();
  }
  // Toon shade down the side away from the light.
  const xs = [sL, sR, hL, hR].map((p) => p[0]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const shade = ctx.createLinearGradient(x0, 0, x1, 0);
  shade.addColorStop(0, "rgba(30,27,24,0)"); shade.addColorStop(0.7, "rgba(30,27,24,0)");
  shade.addColorStop(0.74, "rgba(30,27,24,0.2)"); shade.addColorStop(1, "rgba(30,27,24,0.2)");
  ctx.fillStyle = shade;
  ctx.fillRect(x0 - T, Math.min(sL[1], sR[1], hL[1], hR[1]) - T, x1 - x0 + 2 * T, 4 * T);
  // Gold buttons down the seam, only on the front.
  if (turn.face > 0.05) {
    ctx.globalAlpha = turn.face;
    for (const t of [0.3, 0.5, 0.7]) {
      const b = lerpP(seamTop, seamBottom, t);
      ctx.beginPath(); ctx.arc(b[0], b[1], T * 0.045, 0, TAU);
      ctx.fillStyle = GOLD; ctx.fill(); ctx.lineWidth = ink * 0.6; ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
  outline();
  ctx.lineWidth = ink;
  ctx.stroke();

  // A ruff collar round the neck: gold points, flattened by the angle we see it from.
  const n = 9, rx = wS * 0.44, ry = T * 0.13;
  const c = add(f.sm, mul(f.up, T * 0.02));
  ctx.beginPath();
  for (let k = 0; k < n * 2; k++) {
    const a = (k * Math.PI) / n;
    const r = k % 2 === 0 ? 1.18 : 0.78;
    const p = add(c, add(mul(sDir, Math.cos(a) * rx * r), mul(f.up, -Math.sin(a) * ry * r)));
    if (k === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
  }
  ctx.closePath();
  ctx.fillStyle = GOLD;
  ctx.fill();
  ctx.lineWidth = ink * 0.8;
  ctx.stroke();
}

/** A point on the head's front, at (x, y) in head radii, turned by `yaw`: where it lands and whether it faces us. */
function onSphere(x: number, y: number, sinY: number, cosY: number): { x: number; y: number; toward: number } {
  const z = -Math.sqrt(Math.max(0, 1 - x * x - y * y));
  return { x: x * cosY - z * sinY, y, toward: -(x * sinY + z * cosY) };
}

/**
 * The head with its hat. It sits between the ears (else at the nose, else above the shoulders) and leans
 * with the neck. Face features ride round the front of the head with the turn and fade as the back comes
 * round; the hat's far point is drawn behind the head and its near point in front.
 */
function head(
  ctx: CanvasRenderingContext2D, at: (i: number) => P | null, sm: P | null, up: P,
  T: number, turn: Turn, suit: Suit, ink: number, swing: Swing | undefined,
) {
  const le = at(L_EAR), re = at(R_EAR), nose = at(NOSE);
  const R = T * 0.34;
  let center: P | null = le && re ? mid(le, re) : le ?? re ?? nose;
  if (!center && sm) center = add(sm, mul(up, T * 0.66));
  if (!center) return;
  const hUp: P = sm && len(sub(center, sm)) > T * 0.2 ? unit(sub(center, sm)) : up;
  center = add(center, mul(hUp, R * 0.12));
  const hRight: P = [-hUp[1], hUp[0]];
  const toScreen = (x: number, y: number): P => add(center!, add(mul(hRight, x * R), mul(hUp, y * R)));
  const sinY = Math.sin(turn.yaw), cosY = Math.cos(turn.yaw);

  // The bells lag behind the head as it moves.
  let lag: P = [0, 0];
  if (swing) {
    if (swing.head) {
      const moved = sub(center, swing.head);
      const target = len(moved) > R * 3 ? ([0, 0] as P) : mul(moved, -3);
      swing.lag = lerpP(swing.lag, target, 0.3);
      if (len(swing.lag) > R * 0.7) swing.lag = mul(unit(swing.lag), R * 0.7);
    }
    swing.head = center;
    lag = swing.lag;
  }

  // The hat's two points in head space (x toward the subject's left, y up, z away from the camera).
  const horn = (side: 1 | -1) => {
    const pts: { p: P; z: number }[] = [];
    const ctrl: [number, number, number][] = [[0.3 * side, 0.82, 0.1], [1.2 * side, 1.35, 0.25], [1.62 * side, 0.5, 0.3]];
    for (let i = 0; i <= 14; i++) {
      const t = i / 14, u = 1 - t;
      const q = [0, 1, 2].map((k) => u * u * ctrl[0]![k]! + 2 * u * t * ctrl[1]![k]! + t * t * ctrl[2]![k]!) as [number, number, number];
      const x = q[0] * cosY - q[2] * sinY, z = q[0] * sinY + q[2] * cosY;
      pts.push({ p: add(toScreen(x, q[1]), mul(lag, t * t)), z });
    }
    return pts;
  };
  const drawHorn = (side: 1 | -1, pts: { p: P; z: number }[]) => {
    const far = clamp(pts[pts.length - 1]!.z * 1.2, 0, 1);
    const color = mix(side === 1 ? suit.left : suit.right, INK, 0.3 * far);
    const width = (t: number) => R * (0.42 * (1 - t) + 0.07 * t);
    const leftEdge: P[] = [], rightEdge: P[] = [];
    pts.forEach(({ p }, i) => {
      const a = pts[Math.max(0, i - 1)]!.p, b = pts[Math.min(pts.length - 1, i + 1)]!.p;
      const n = unit([-(b[1] - a[1]), b[0] - a[0]], [1, 0]);
      const w = width(i / (pts.length - 1));
      leftEdge.push(add(p, mul(n, w))); rightEdge.push(sub(p, mul(n, w)));
    });
    ctx.beginPath();
    leftEdge.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
    for (let i = rightEdge.length - 1; i >= 0; i--) ctx.lineTo(rightEdge[i]![0], rightEdge[i]![1]);
    ctx.closePath();
    ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = ink; ctx.stroke();
    // The bell.
    const tip = pts[pts.length - 1]!.p;
    const bell = add(tip, mul(hUp, -R * 0.1));
    const br = R * 0.19;
    ctx.beginPath(); ctx.arc(bell[0], bell[1], br, 0, TAU);
    ctx.fillStyle = toonAcross(ctx, add(bell, mul(LIGHT, br)), sub(bell, mul(LIGHT, br)), br, mix(GOLD, INK, 0.3 * far));
    ctx.fill(); ctx.lineWidth = ink * 0.8; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(...sub(bell, mul(hRight, br * 0.5))); ctx.lineTo(...add(bell, mul(hRight, br * 0.5)));
    ctx.lineWidth = ink * 0.7; ctx.stroke();
  };
  const horns = ([1, -1] as const).map((side) => ({ side, pts: horn(side) }));
  const behind = horns.filter((h) => h.pts[h.pts.length - 1]!.z >= -0.05);
  const before = horns.filter((h) => h.pts[h.pts.length - 1]!.z < -0.05);
  for (const h of behind) drawHorn(h.side, h.pts);

  // The neck, then the head: lit toward the upper left.
  if (sm) {
    taperPath(ctx, sm, center, T * 0.12, T * 0.11);
    ctx.fillStyle = shadowOf(SKIN); ctx.fill();
  }
  ctx.beginPath(); ctx.arc(center[0], center[1], R, 0, TAU);
  ctx.fillStyle = shadowOf(SKIN); ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.beginPath(); ctx.arc(center[0] + LIGHT[0] * R * 0.16, center[1] + LIGHT[1] * R * 0.16, R * 0.97, 0, TAU);
  ctx.fillStyle = SKIN; ctx.fill();

  // The cap over the top of the head, split in the suit's colours along the front seam.
  const brim = 0.3;
  const seam = onSphere(0, brim, sinY, cosY).x;
  for (const side of [1, -1] as const) {
    ctx.beginPath();
    const a = toScreen(seam, brim + 2), b = toScreen(seam, brim - 0.05), c = toScreen(side * 2, brim - 0.05), d = toScreen(side * 2, brim + 2);
    ctx.moveTo(...a); ctx.lineTo(...b); ctx.lineTo(...c); ctx.lineTo(...d); ctx.closePath();
    ctx.fillStyle = side === 1 ? suit.left : suit.right;
    ctx.fill();
  }
  ctx.beginPath();
  ctx.moveTo(...toScreen(-1.2, brim - 0.05)); ctx.lineTo(...toScreen(1.2, brim - 0.05));
  ctx.lineWidth = R * 0.16; ctx.strokeStyle = "rgba(30,27,24,0.22)"; ctx.stroke();
  ctx.strokeStyle = INK;

  // The face, riding round the front with the turn.
  const face = turn.face;
  if (face > 0.02) {
    const feature = (x: number, y: number, draw: (p: P, squash: number) => void) => {
      const s = onSphere(x, y, sinY, cosY);
      const show = face * smoothstep(0.05, 0.35, s.toward);
      if (show <= 0) return;
      ctx.globalAlpha = show;
      draw(toScreen(s.x, s.y), clamp(s.toward, 0.2, 1));
      ctx.globalAlpha = 1;
    };
    for (const x of [-0.33, 0.33]) {
      feature(x, 0.0, (p, sq) => {
        ctx.beginPath(); ctx.ellipse(p[0], p[1], R * 0.085 * sq, R * 0.13, Math.atan2(hRight[1], hRight[0]), 0, TAU);
        ctx.fillStyle = FEATURES; ctx.fill();
      });
      feature(x * 1.45, -0.28, (p, sq) => {
        const w = R * 0.07 * sq, h = R * 0.1;
        ctx.beginPath();
        ctx.moveTo(...add(p, mul(hUp, h))); ctx.lineTo(...add(p, mul(hRight, w)));
        ctx.lineTo(...sub(p, mul(hUp, h))); ctx.lineTo(...sub(p, mul(hRight, w)));
        ctx.closePath(); ctx.fillStyle = CHEEK; ctx.fill();
      });
    }
    // The smile, drawn piece by piece so the part round the far side drops out.
    ctx.lineWidth = Math.max(1, R * 0.07);
    for (let i = 0; i < 8; i++) {
      const xa = -0.24 + (0.48 * i) / 8, xb = -0.24 + (0.48 * (i + 1)) / 8;
      const ya = -0.4 - 0.12 * (1 - (xa / 0.24) ** 2), yb = -0.4 - 0.12 * (1 - (xb / 0.24) ** 2);
      const sa = onSphere(xa, ya, sinY, cosY), sb = onSphere(xb, yb, sinY, cosY);
      const show = face * smoothstep(0.05, 0.35, Math.min(sa.toward, sb.toward));
      if (show <= 0) continue;
      ctx.globalAlpha = show;
      ctx.beginPath(); ctx.moveTo(...toScreen(sa.x, sa.y)); ctx.lineTo(...toScreen(sb.x, sb.y)); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
  ctx.beginPath(); ctx.arc(center[0], center[1], R, 0, TAU);
  ctx.lineWidth = ink; ctx.stroke();

  for (const h of before) drawHorn(h.side, h.pts);
}

// ---- The stage ----

export interface StageSpot {
  /** Where the floor's back edge meets the backdrop, in canvas pixels from the top. */
  floorY: number;
  /** The spotlight's middle, in canvas pixels from the left. */
  spotX: number;
}

const stages = new Map<string, HTMLCanvasElement>();

/** The stage for this canvas size, drawn once and kept (a handful of sizes at most per game). */
export function stageImage(width: number, height: number, spot: StageSpot): HTMLCanvasElement {
  const floorY = Math.round(spot.floorY), spotX = Math.round(spot.spotX);
  const key = `${width}x${height}:${floorY}:${spotX}`;
  const kept = stages.get(key);
  if (kept) return kept;
  if (stages.size > 12) stages.clear();
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  drawStage(canvas.getContext("2d")!, width, height, floorY, spotX);
  stages.set(key, canvas);
  return canvas;
}

/** A purple velvet backdrop in folds, a plank floor in perspective, and a warm spotlight from above. */
function drawStage(ctx: CanvasRenderingContext2D, w: number, h: number, floorY: number, spotX: number) {
  // Backdrop: vertical folds, each lit in the middle and dark at its edges.
  ctx.fillStyle = BACKDROP;
  ctx.fillRect(0, 0, w, floorY);
  const foldW = Math.max(18, h * 0.085);
  for (let x = -foldW * 0.3; x < w; x += foldW) {
    const g = ctx.createLinearGradient(x, 0, x + foldW, 0);
    g.addColorStop(0, mix(BACKDROP, INK, 0.45)); g.addColorStop(0.45, mix(BACKDROP, "#FFE3A3", 0.1)); g.addColorStop(0.6, BACKDROP); g.addColorStop(1, mix(BACKDROP, INK, 0.45));
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, foldW + 1, floorY);
  }
  // Darker toward the top, and a shadow where the cloth meets the floor.
  const top = ctx.createLinearGradient(0, 0, 0, floorY);
  top.addColorStop(0, dark(0.6)); top.addColorStop(0.5, dark(0.1)); top.addColorStop(0.92, dark(0.15)); top.addColorStop(1, dark(0.55));
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, w, floorY);

  // Floor: planks running back to a vanishing point high above, darker toward the back.
  const floorH = h - floorY;
  ctx.fillStyle = PLANK_A;
  ctx.fillRect(0, floorY, w, floorH);
  const vanishY = floorY - h * 1.4;
  const k = (floorY - vanishY) / (h - vanishY);
  const plank = Math.max(16, w * 0.07);
  let i = 0;
  for (let x = spotX - Math.ceil((spotX + w) / plank) * plank; x < w * 2; x += plank, i++) {
    const xb0 = x, xb1 = x + plank;
    const xt0 = spotX + (xb0 - spotX) * k, xt1 = spotX + (xb1 - spotX) * k;
    ctx.beginPath();
    ctx.moveTo(xt0, floorY); ctx.lineTo(xt1, floorY); ctx.lineTo(xb1, h); ctx.lineTo(xb0, h); ctx.closePath();
    ctx.fillStyle = i % 2 === 0 ? PLANK_A : PLANK_B;
    ctx.fill();
    ctx.strokeStyle = SEAM; ctx.lineWidth = Math.max(1, w * 0.002); ctx.stroke();
  }
  const depth = ctx.createLinearGradient(0, floorY, 0, h);
  depth.addColorStop(0, dark(0.62)); depth.addColorStop(0.35, dark(0.25)); depth.addColorStop(1, dark(0.08));
  ctx.fillStyle = depth;
  ctx.fillRect(0, floorY, w, floorH);
  ctx.fillStyle = dark(0.55);
  ctx.fillRect(0, floorY - 1, w, Math.max(2, h * 0.006));

  // Spotlight: a soft cone from above and a pool of light on the floor.
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  const poolY = floorY + floorH * 0.5;
  const cone = ctx.createLinearGradient(0, 0, 0, poolY);
  cone.addColorStop(0, light(0.22)); cone.addColorStop(1, light(0.06));
  ctx.fillStyle = cone;
  ctx.beginPath();
  ctx.moveTo(spotX - w * 0.05, 0); ctx.lineTo(spotX + w * 0.05, 0);
  ctx.lineTo(spotX + w * 0.3, poolY); ctx.lineTo(spotX - w * 0.3, poolY);
  ctx.closePath();
  ctx.fill();
  ctx.translate(spotX, poolY);
  ctx.scale(1, Math.max(0.12, floorH / (w * 0.6)));
  const pool = ctx.createRadialGradient(0, 0, 0, 0, 0, w * 0.32);
  pool.addColorStop(0, light(0.38)); pool.addColorStop(0.7, light(0.12)); pool.addColorStop(1, light(0));
  ctx.fillStyle = pool;
  ctx.beginPath(); ctx.arc(0, 0, w * 0.32, 0, TAU); ctx.fill();
  ctx.restore();

  // A vignette pulls the eye to the middle.
  const v = ctx.createRadialGradient(spotX, h * 0.55, Math.min(w, h) * 0.3, spotX, h * 0.55, Math.max(w, h) * 0.8);
  v.addColorStop(0, dark(0)); v.addColorStop(1, dark(0.6));
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, w, h);
}
