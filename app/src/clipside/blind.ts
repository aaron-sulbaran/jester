// What a blind mode player sees: only their subject, never the clip. A person is a jester puppet (or, for
// comparing, the old stick figure); a thing is its outline. Behind them a stage, or the old plain background.
// Placement comes from `placeSubject` in ../../../clip.

import { bodyTurns, NO_TURN, placeSubject, type Guide, type Outline, type Placement, type Turn, type View } from "../../../clip/src/index.ts";
import { drawPuppet, newSwing, stageImage, suitFor, type Construction, type StageLook, type Swing } from "./puppet.ts";

export type Look = "outline" | "stick" | "puppet";

/**
 * `stage` draws that stage behind the subject instead of the plain `background`; `puppet` is how the
 * puppet look is built (see `Construction` in ./puppet.ts).
 */
export interface BlindStyle { background: string; color: string; stage?: StageLook; puppet?: Construction }

const DEFAULT_STYLE: BlindStyle = { background: "#16161d", color: "#f5c542" };

import { DETAIL_BONES as BONES } from "../../../spikes/pose-match/skeleton.mjs";
const MIN_VISIBILITY = 0.5;
const ANKLES_AND_FEET = [27, 28, 29, 30, 31, 32];

/** What the puppet needs from the whole guide, worked out once: the turn at every frame, its size and where it stands. */
export interface PuppetClip {
  turns: Turn[];
  /** Median torso length (shoulders to hips), in source pixels; null when the torso is never seen. */
  torso: number | null;
  /** Median lowest foot point, normalized; null when the feet are never seen. */
  footY: number | null;
  /** Median middle of the hips (else shoulders), normalized; null when never seen. */
  centerX: number | null;
}

/** The puppet's state at one moment: its turn, and the whole guide's facts. */
export interface GuidePose { turn: Turn; clip: PuppetClip }

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

const clips = new WeakMap<Guide, PuppetClip>();

export function puppetClip(guide: Guide): PuppetClip {
  const kept = clips.get(guide);
  if (kept) return kept;
  const { width, height } = guide.source;
  const torsos: number[] = [], feet: number[] = [], centers: number[] = [];
  for (const f of guide.timeline?.frames ?? []) {
    const l = f.landmarks;
    if (!l) continue;
    const seen = (i: number) => (l[i]?.[2] ?? 0) >= MIN_VISIBILITY;
    if (seen(11) && seen(12) && seen(23) && seen(24)) {
      const sx = (l[11]![0] + l[12]![0]) / 2, sy = (l[11]![1] + l[12]![1]) / 2;
      const hx = (l[23]![0] + l[24]![0]) / 2, hy = (l[23]![1] + l[24]![1]) / 2;
      torsos.push(Math.hypot((sx - hx) * width, (sy - hy) * height));
      centers.push(hx);
    } else if (seen(11) && seen(12)) {
      centers.push((l[11]![0] + l[12]![0]) / 2);
    }
    const lowest = ANKLES_AND_FEET.filter(seen).map((i) => l[i]![1]);
    if (lowest.length) feet.push(Math.max(...lowest));
  }
  const clip: PuppetClip = { turns: bodyTurns(guide), torso: median(torsos), footY: median(feet), centerX: median(centers) };
  clips.set(guide, clip);
  return clip;
}

/** The puppet's pose at a frame position of the whole guide; between two frames (`position` 3.4) the turn is blended. */
export function guidePoseAt(guide: Guide, position: number): GuidePose {
  const clip = puppetClip(guide);
  const last = clip.turns.length - 1;
  if (last < 0) return { turn: NO_TURN, clip };
  const p = Math.min(last, Math.max(0, position));
  const i = Math.floor(p), j = Math.min(last, i + 1), u = p - i;
  const a = clip.turns[i]!, b = clip.turns[j]!;
  return { turn: { yaw: a.yaw + (b.yaw - a.yaw) * u, face: a.face + (b.face - a.face) * u }, clip };
}

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

const swings = new WeakMap<HTMLCanvasElement, Swing>();

/**
 * The background alone: the stage when `style.stage`, else the plain colour. `pose` (from the whole guide)
 * places the floor and spotlight under the subject; without it the guide itself is used.
 */
export function drawBlindBackground(canvas: HTMLCanvasElement, guide: Guide, view: View, style: BlindStyle = DEFAULT_STYLE, pose?: GuidePose) {
  const ctx = canvas.getContext("2d")!;
  if (!style.stage) {
    ctx.fillStyle = style.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const clip = pose?.clip ?? puppetClip(guide);
  const { width: w, height: h } = canvas;
  const torsoPx = clip.torso !== null ? clip.torso * view.scale : null;
  // The floor's back edge a little behind where the subject usually stands; the light on their usual spot.
  const footPx = clip.footY !== null ? clip.footY * guide.source.height * view.scale + view.offsetY : null;
  const floorY = footPx !== null ? Math.min(h * 0.88, Math.max(h * 0.5, footPx - (torsoPx ?? h * 0.15) * 0.35)) : h * 0.76;
  const spotX = clip.centerX !== null ? Math.min(w * 0.8, Math.max(w * 0.2, clip.centerX * guide.source.width * view.scale + view.offsetX)) : w / 2;
  ctx.drawImage(stageImage(w, h, { floorY, spotX }, style.stage), 0, 0);
}

/**
 * The subject alone at frame `index`, over whatever is on the canvas: nothing is drawn where the subject is
 * missing. Line widths follow the subject's drawn size. For the puppet, `pose` comes from `guidePoseAt` on
 * the whole guide when `guide` is a one-frame slice of it; otherwise frame `index` of `guide` is used.
 */
export function drawBlindSubject(
  canvas: HTMLCanvasElement,
  guide: Guide,
  index: number,
  look: Look,
  view: View,
  style: BlindStyle = DEFAULT_STYLE,
  pose?: GuidePose,
) {
  const ctx = canvas.getContext("2d")!;
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

  if (look === "puppet") {
    const at = pose ?? guidePoseAt(guide, index);
    const torso = at.clip.torso !== null ? at.clip.torso * view.scale : sizePx * 0.3;
    const depth = guide.depths?.[index] ?? null;
    let swing = swings.get(canvas);
    if (!swing) { swing = newSwing(); swings.set(canvas, swing); }
    drawPuppet(ctx, { landmarks, depth, turn: at.turn, torso }, map, suitFor(style.color), style.puppet ?? "a", swing);
    return;
  }

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
}

/**
 * Draws frame `index` of the guide as the player would see it: the background, then the subject. When the
 * subject is missing at that frame only the background shows.
 */
export function drawBlind(
  canvas: HTMLCanvasElement,
  guide: Guide,
  index: number,
  look: Look,
  view: View,
  style: BlindStyle = DEFAULT_STYLE,
  pose?: GuidePose,
) {
  drawBlindBackground(canvas, guide, view, style, pose);
  drawBlindSubject(canvas, guide, index, look, view, style, pose);
}
