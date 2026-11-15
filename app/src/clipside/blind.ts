// What a blind mode player sees: only their subject, as an outline or a stick figure, on a plain
// background, never the clip. Placement comes from `placeSubject` in ../../../clip.

import { placeSubject, type Guide, type Outline, type Placement, type View } from "../../../clip/src/index.ts";

export type Look = "outline" | "stick";

export interface BlindStyle { background: string; color: string }

const DEFAULT_STYLE: BlindStyle = { background: "#16161d", color: "#f5c542" };

import { DETAIL_BONES, BODY_BONES, FOOT_BONES, FACE_BONES, FINGER_BONES } from "../../../spikes/pose-match/skeleton.mjs";
import type { GuideHands, HandPoints } from "../../../clip/src/index.ts";
const MIN_VISIBILITY = 0.5;

/** The guide's frame at media time `mediaMs`, clamped to its range. */
export function guideFrameAt(guide: Guide, mediaMs: number): number {
  const frameMs = 1000 / guide.source.sampleHz;
  const last = guide.boxTrack.frames.length - 1;
  return Math.min(last, Math.max(0, Math.round((mediaMs - guide.range.startMs) / frameMs)));
}

/** Works out the placement once per guide and canvas size; reuse it for every frame so the subject does not drift. */
export function blindView(guide: Guide, canvas: HTMLCanvasElement, placement: Placement): View {
  return placeSubject(guide, canvas, placement);
}

function toCanvas(view: View, guide: Guide, x: number, y: number): [number, number] {
  return [x * guide.source.width * view.scale + view.offsetX, y * guide.source.height * view.scale + view.offsetY];
}

export function traceOutline(ctx: CanvasRenderingContext2D, outline: Outline, map: (x: number, y: number) => [number, number]) {
  ctx.beginPath();
  outline.forEach(([x, y], i) => {
    const [px, py] = map(x, y);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.closePath();
}

/**
 * Draws frame `index` of the guide as the player would see it. When the subject is missing at
 * that frame the canvas is left plain. Line widths follow the subject's drawn size.
 */
export function drawBlind(
  canvas: HTMLCanvasElement,
  guide: Guide,
  index: number,
  look: Look,
  view: View,
  style: BlindStyle = DEFAULT_STYLE,
) {
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = style.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const map = (x: number, y: number) => toCanvas(view, guide, x, y);
  const box = guide.boxTrack.frames[index]?.box;
  const sizePx = box ? box.h * guide.source.height * view.scale : canvas.height * 0.5;
  const lineWidth = Math.max(2, sizePx * 0.025);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  if (look === "outline") {
    const outline = guide.outlines[index];
    if (!outline) return;
    traceOutline(ctx, outline, map);
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = style.color;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = style.color;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
    return;
  }

  const landmarks = guide.timeline?.frames[index]?.landmarks;
  if (!landmarks) return;
  const hands = guide.hands?.[index] ?? null;
  // With finger data the pose model's 4-point hands are left out: the fingers replace them.
  const BONES = hands ? [...BODY_BONES, ...FOOT_BONES, ...FACE_BONES] : DETAIL_BONES;
  ctx.strokeStyle = style.color;
  ctx.lineWidth = lineWidth * 2;
  for (const [a, b] of BONES) {
    const p = landmarks[a], q = landmarks[b];
    if (!p || !q || p[2] < MIN_VISIBILITY || q[2] < MIN_VISIBILITY) continue;
    const [ax, ay] = map(p[0], p[1]);
    const [bx, by] = map(q[0], q[1]);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  }
  const nose = landmarks[0];
  if (nose && nose[2] >= MIN_VISIBILITY) {
    const [nx, ny] = map(nose[0], nose[1]);
    ctx.beginPath();
    ctx.arc(nx, ny, sizePx * 0.07, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (hands) {
    for (const hand of [hands.left, hands.right]) if (hand) drawFingers(ctx, hand, map, Math.max(2, sizePx * 0.009), style.color);
    drawHandInset(canvas, guide, hands, style);
  }
}

/** One hand as 21 points joined by bones, thin enough to read on a hand only a few dozen pixels wide. */
function drawFingers(ctx: CanvasRenderingContext2D, hand: HandPoints, map: (x: number, y: number) => [number, number], width: number, color: string) {
  ctx.save();
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = width;
  for (const [a, b] of FINGER_BONES) {
    const [ax, ay] = map(hand[a!]![0], hand[a!]![1]), [bx, by] = map(hand[b!]![0], hand[b!]![1]);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  }
  for (const p of hand) { const [x, y] = map(p[0], p[1]); ctx.beginPath(); ctx.arc(x, y, width * 0.9, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
}

/** How much a hand's fingers move over the clip (spread from the wrist, summed), to pick the hand worth magnifying. */
const handActivity = new WeakMap<Guide, "left" | "right" | null>();
export function busierHand(guide: Guide): "left" | "right" | null {
  if (handActivity.has(guide)) return handActivity.get(guide)!;
  const total = { left: 0, right: 0 };
  const prev: Record<"left" | "right", HandPoints | null> = { left: null, right: null };
  for (const h of guide.hands ?? []) for (const k of ["left", "right"] as const) {
    const cur = h?.[k] ?? null, before = prev[k];
    if (cur && before) for (let i = 1; i < 21; i++) total[k] += Math.hypot((cur[i]![0] - cur[0]![0]) - (before[i]![0] - before[0]![0]), (cur[i]![1] - cur[0]![1]) - (before[i]![1] - before[0]![1]));
    prev[k] = cur;
  }
  const pick = Math.max(total.left, total.right) < 0.05 ? null : total.left >= total.right ? "left" : "right";
  handActivity.set(guide, pick);
  return pick;
}

/** The busier hand, magnified in a corner of the canvas, so finger shapes read even when the whole body is in view. */
function drawHandInset(canvas: HTMLCanvasElement, guide: Guide, hands: GuideHands, style: BlindStyle) {
  const which = guide.handFocus !== undefined ? guide.handFocus : busierHand(guide);
  const hand = which && hands[which];
  if (!hand) return;
  const size = Math.round(Math.min(canvas.width, canvas.height) * 0.3), margin = Math.round(size * 0.08);
  const x0 = canvas.width - size - margin, y0 = margin;
  const xs = hand.map((p) => p[0]), ys = hand.map((p) => p[1]);
  const aspect = guide.source.width / guide.source.height;
  const w = (Math.max(...xs) - Math.min(...xs)) * aspect, h = Math.max(...ys) - Math.min(...ys);
  const k = (size * 0.78) / Math.max(w, h, 0.01), cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
  const map = (x: number, y: number): [number, number] => [x0 + size / 2 + (x - cx) * aspect * k, y0 + size / 2 + (y - cy) * k];
  const ctx = canvas.getContext("2d")!;
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.strokeStyle = style.color; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.roundRect(x0, y0, size, size, size * 0.1); ctx.fill(); ctx.stroke();
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  drawFingers(ctx, hand, map, Math.max(2, size * 0.025), style.color);
  ctx.restore();
}
