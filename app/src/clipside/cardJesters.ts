// The clip library's little performers as 3D jesters: one per person in the clip, each in its own colourway,
// standing in a loose pyramid (the back ones smaller and higher, turned in toward the middle), each breathing and
// shifting its weight on its own beat so no two move or look the same way at the same time. Things (a ball) get a
// plain ball on the floor beside them.
//
// Drawn with the game's own 3D jester (puppet3d.ts) from a made-up standing pose, so the cards and the Blind
// guide are the same figure. One shared loop at about 10 frames a second redraws only the cards on screen; with
// reduced motion each card is drawn once. Until the 3D chunk has loaded (or without WebGL) the card keeps its
// flat silhouettes.

import { boneLengths, liftPose, type Guide, type Turn } from "../../../clip/src/index.ts";
import { JESTER_COLOURS, suitFor } from "./puppet.ts";

type Puppet3d = typeof import("./puppet3d.ts");
let puppet3d: Puppet3d | null = null;
let loading: Promise<Puppet3d | null> | null = null;
const load = () => (loading ??= import("./puppet3d.ts").then((m) => (m.available() ? (puppet3d = m) : null), () => null));

/** One figure's place on the card's canvas: feet x and y and height as shares of the canvas, its turn, its colour. */
interface Spot { x: number; feet: number; height: number; yaw: number; colour: string; phase: number }

/** Back to front, so the front figures are drawn over the back ones. */
function layout(people: number, first: number): Spot[] {
  const at = (x: number, feet: number, height: number, yaw: number, k: number): Spot =>
    ({ x, feet, height, yaw, colour: JESTER_COLOURS[(first + k) % JESTER_COLOURS.length]!.main, phase: k * 1.7 + first * 0.6 });
  // Feet stay above the bottom edge so the shoes and their white edge are never cut.
  switch (Math.min(5, Math.max(1, people))) {
    case 1: return [at(0.5, 0.9, 0.7, 0.25, 0)];
    case 2: return [at(0.36, 0.8, 0.6, 0.4, 0), at(0.62, 0.91, 0.7, -0.3, 1)];
    case 3: return [at(0.25, 0.78, 0.58, 0.45, 0), at(0.75, 0.78, 0.58, -0.45, 1), at(0.5, 0.91, 0.68, 0.1, 2)];
    case 4: return [at(0.37, 0.78, 0.56, 0.4, 0), at(0.63, 0.78, 0.56, -0.4, 1), at(0.18, 0.91, 0.62, 0.3, 2), at(0.82, 0.91, 0.62, -0.3, 3)];
    default: return [at(0.33, 0.77, 0.52, 0.35, 0), at(0.67, 0.77, 0.52, -0.35, 1), at(0.12, 0.91, 0.57, 0.42, 2), at(0.88, 0.91, 0.57, -0.42, 3), at(0.5, 0.92, 0.6, 0.05, 4)];
  }
}

const TAU = Math.PI * 2;

/**
 * A standing person in canvas pixels at time `t` (seconds), as the tracker's 33 landmarks (normalized to the
 * canvas, all seen): breathing lifts the shoulders and head and lets the arms float out, a slower sway shifts the
 * weight from hip to hip. The body's width narrows with its turn, the nose leads toward where it faces.
 */
function standing(spot: Spot, yaw: number, t: number, w: number, h: number): [number, number, number][] {
  const H = spot.height * h, cx = spot.x * w, feet = spot.feet * h;
  const breathe = Math.sin(TAU * t / 3.2 + spot.phase), sway = Math.sin(TAU * t / 5.3 + spot.phase * 0.7);
  const wide = Math.abs(Math.cos(yaw)), lead = Math.sin(yaw);
  const hipX = cx + sway * 0.012 * H, chestX = cx + sway * 0.007 * H;
  const shoulderY = feet - 0.8 * H - breathe * 0.008 * H, hipY = feet - 0.5 * H;
  const p: [number, number][] = new Array(33);
  const set = (i: number, x: number, y: number) => { p[i] = [x, y]; };
  // Head: ears level, the nose out toward the way the body faces.
  const headX = chestX + sway * 0.004 * H, headY = feet - 0.9 * H - breathe * 0.01 * H;
  set(0, headX + lead * 0.035 * H, headY);
  for (let i = 1; i <= 6; i++) set(i, headX + lead * 0.03 * H + (i <= 3 ? 1 : -1) * 0.015 * H * wide, headY - 0.012 * H);
  set(7, headX + 0.04 * H * wide - lead * 0.01 * H, headY - 0.005 * H);
  set(8, headX - 0.04 * H * wide - lead * 0.01 * H, headY - 0.005 * H);
  set(9, headX + lead * 0.033 * H + 0.01 * H * wide, headY + 0.025 * H);
  set(10, headX + lead * 0.033 * H - 0.01 * H * wide, headY + 0.025 * H);
  // Shoulders, arms hanging a little out, floating out a touch on each breath. Left is the image's right.
  const sw = 0.11 * H * wide, out = 0.035 * H + breathe * 0.008 * H;
  for (const side of [1, -1] as const) {
    const [s, e, wr, pinky, index, thumb] = side === 1 ? [11, 13, 15, 17, 19, 21] : [12, 14, 16, 18, 20, 22];
    const sx = chestX + side * sw, ex = sx + side * out * wide, wx = ex + side * 0.012 * H * wide;
    set(s, sx, shoulderY);
    set(e, ex, shoulderY + 0.17 * H);
    set(wr, wx, shoulderY + 0.32 * H);
    set(pinky, wx + side * 0.01 * H * wide, shoulderY + 0.36 * H);
    set(index, wx, shoulderY + 0.365 * H);
    set(thumb, wx - side * 0.01 * H * wide, shoulderY + 0.35 * H);
  }
  // Hips, legs straight down with the weight on one side, feet pointing where the body faces.
  const hw = 0.07 * H * wide;
  for (const side of [1, -1] as const) {
    const [hp, k, a, heel, toe] = side === 1 ? [23, 25, 27, 29, 31] : [24, 26, 28, 30, 32];
    const hx = hipX + side * hw, ax = cx + side * (hw + 0.01 * H * wide);
    set(hp, hx, hipY);
    set(k, (hx + ax) / 2 + side * 0.004 * H, feet - 0.25 * H);
    set(a, ax, feet - 0.03 * H);
    set(heel, ax - lead * 0.015 * H, feet - 0.01 * H);
    set(toe, ax + lead * 0.04 * H, feet);
  }
  return p.map(([x, y]) => [x / w, y / h, 1]);
}

interface Card { canvas: HTMLCanvasElement; spots: Spot[]; things: number; seen: boolean; drawn: boolean }
const cards = new Set<Card>();
const watcher = typeof IntersectionObserver !== "undefined"
  ? new IntersectionObserver((entries) => { for (const e of entries) for (const c of cards) if (c.canvas === e.target) c.seen = e.isIntersecting; })
  : null;
const still = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function draw(card: Card, t: number) {
  const p3 = puppet3d;
  const { canvas } = card;
  const r = canvas.getBoundingClientRect();
  if (!p3 || r.width <= 0 || r.height <= 0) return;
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, w, h);
  for (const spot of card.spots) {
    // Each looks around a little on its own, so no two face the same way at the same moment.
    const yaw = spot.yaw + 0.12 * Math.sin(TAU * t / 6.1 + spot.phase * 1.3);
    const turn: Turn = { yaw, face: 1 };
    const rest = standing(spot, 0, 0, w, h);
    const guide = { source: { width: w, height: h }, timeline: { frames: [{ landmarks: rest }] } } as unknown as Pick<Guide, "source" | "timeline">;
    const lengths = boneLengths(guide);
    const lifted = liftPose(standing(spot, yaw, t, w, h), null, turn, lengths, w, h);
    p3.drawPuppet3d(ctx, { lifted, turn, torso: 0.3 * spot.height * h, suit: suitFor(spot.colour) });
  }
  // A thing in the clip: a ball on the floor at the right.
  for (let i = 0; i < card.things; i++) {
    const rad = 0.07 * h, x = w * (0.9 - i * 0.07), y = h * 0.97 - rad;
    ctx.beginPath(); ctx.arc(x, y, rad, 0, TAU);
    ctx.fillStyle = "#D93A2B"; ctx.fill(); ctx.lineWidth = Math.max(2, 0.012 * h); ctx.strokeStyle = "#1E1B18"; ctx.stroke();
  }
  card.drawn = true;
}

let running = false;
let last = 0;
function loop(now: number) {
  for (const c of cards) if (!c.canvas.isConnected) { cards.delete(c); watcher?.unobserve(c.canvas); }
  if (!cards.size) { running = false; return; }
  if (now - last >= 100) {
    last = now;
    const t = now / 1000;
    for (const c of cards) {
      // Only cards on screen; a card on a hidden screen has no size and is skipped in draw.
      if ((c.seen || !watcher) && (!still || !c.drawn)) draw(c, still ? 0 : t);
    }
  }
  requestAnimationFrame(loop);
}

/**
 * Puts the 3D jesters on a clip card: `pic` is the card's picture box, `svg` its flat silhouettes (kept until the
 * jesters are ready, and for good without WebGL). `first` picks the card's first colourway, so cards differ.
 */
export function castJesters(pic: HTMLElement, svg: Element | null, people: number, things: number, first: number) {
  void load().then((m) => {
    if (!m || !pic.isConnected) return;
    const canvas = document.createElement("canvas");
    canvas.className = "clip-cast";
    canvas.setAttribute("aria-hidden", "true");
    if (svg) svg.replaceWith(canvas); else pic.append(canvas);
    const card: Card = { canvas, spots: layout(people, first), things, seen: !watcher, drawn: false };
    cards.add(card);
    watcher?.observe(canvas);
    draw(card, performance.now() / 1000);
    if (!running) { running = true; requestAnimationFrame(loop); }
  });
}
