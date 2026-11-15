// What a blind mode player sees: only their subject, as an outline or a stick figure, on a plain
// background, never the clip. Placement comes from `placeSubject` in ../../../clip.

import { placeSubject, type Guide, type Outline, type Placement, type View } from "../../../clip/src/index.ts";

export type Look = "outline" | "stick";

export interface BlindStyle { background: string; color: string }

const DEFAULT_STYLE: BlindStyle = { background: "#16161d", color: "#f5c542" };

import { DETAIL_BONES, BODY_BONES, FOOT_BONES, FACE_BONES, FINGER_BONES } from "../../../spikes/pose-match/skeleton.mjs";
import type { HandPoints } from "../../../clip/src/index.ts";
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
    for (const hand of [hands.left, hands.right]) if (hand) drawHand(ctx, hand, map, style.color);
  }
}

/**
 * One hand drawn in place: a soft palm, then the finger bones and joints. Line width follows the hand's own size
 * (wrist to the middle finger's base), so fingers stay readable on a hand only a few dozen pixels wide and do not
 * turn into blobs on a big one. The palm fill reads as a hand shape when the fingers are curled or overlap.
 */
function drawHand(ctx: CanvasRenderingContext2D, hand: HandPoints, map: (x: number, y: number) => [number, number], color: string) {
  const [wx, wy] = map(hand[0]![0], hand[0]![1]), [mx, my] = map(hand[9]![0], hand[9]![1]);
  const span = Math.hypot(mx - wx, my - wy);
  const width = Math.max(2, span * 0.075);
  ctx.save();
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = width;
  // A dark halo under the fingers, so they stand out from the thick arm line they sit on.
  ctx.strokeStyle = "rgba(0,0,0,0.65)"; ctx.lineWidth = width * 2.4;
  for (const [a, b] of FINGER_BONES) {
    const [ax, ay] = map(hand[a!]![0], hand[a!]![1]), [bx, by] = map(hand[b!]![0], hand[b!]![1]);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  }
  ctx.strokeStyle = color; ctx.lineWidth = width;
  // The palm.
  ctx.globalAlpha = 0.3;
  ctx.beginPath();
  PALM.forEach((i, k) => { const [x, y] = map(hand[i]![0], hand[i]![1]); if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.closePath(); ctx.fill();
  ctx.globalAlpha = 1;
  for (const [a, b] of FINGER_BONES) {
    const [ax, ay] = map(hand[a!]![0], hand[a!]![1]), [bx, by] = map(hand[b!]![0], hand[b!]![1]);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  }
  // Joints, and a larger dot on each fingertip.
  for (let i = 0; i < 21; i++) {
    const [x, y] = map(hand[i]![0], hand[i]![1]);
    ctx.beginPath(); ctx.arc(x, y, width * (TIPS.has(i) ? 0.95 : 0.6), 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

const PALM = [0, 1, 5, 9, 13, 17];
const TIPS = new Set([4, 8, 12, 16, 20]);
