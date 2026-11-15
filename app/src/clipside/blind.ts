// What a blind mode player sees: only their subject, never the clip. A person is a jester puppet (or, for
// comparing, the old stick figure); a thing is its outline. Behind them a stage, or the old plain background.
// Placement comes from `placeSubject` in ../../../clip.

import { boneLengths, boxFromLandmarks, bodyTurns, hideUnsureJoints, liftPose, NO_TURN, placeSubject, type BoneLengths, type Guide, type Outline, type Placement, type Turn, type View } from "../../../clip/src/index.ts";
import { smoothTimeline, type Landmark } from "../../../engine/src/index.ts";
import { drawPuppet, floorShadow, HAT_REACH, HEAD, newSwing, stageImage, suitFor, type Construction, type StageLook, type StageSpot, type Swing } from "./puppet.ts";

type Puppet3d = typeof import("./puppet3d.ts");
let puppet3d: Puppet3d | null = null;
let loading3d: Promise<void> | null = null;
/** Starts loading the 3D puppet (three.js) the first time it is asked for; until then the flat sticker stands in. */
function want3d(): Promise<void> {
  loading3d ??= import("./puppet3d.ts").then((m) => { puppet3d = m; }, () => { loading3d = null; });
  return loading3d;
}

/** Loads the 3D puppet ahead of time, so the first frame a player sees is already 3D. */
export function preload3d(): Promise<void> {
  return want3d();
}

export type Look = "outline" | "stick" | "puppet";

/**
 * `stage` draws that stage behind the subject instead of the plain `background`; `puppet` is how the
 * puppet look is built (see `Construction` in ./puppet.ts).
 */
export interface BlindStyle {
  background: string; color: string; stage?: StageLook; puppet?: Construction;
  /** The faint look-ahead copy: the 3D jester without its white edge and shadow. */
  faint?: boolean;
}

const DEFAULT_STYLE: BlindStyle = { background: "#16161d", color: "#f5c542" };

import { DETAIL_BONES, BODY_BONES, FOOT_BONES, FACE_BONES, FINGER_BONES, HAND_BONES } from "../../../spikes/pose-match/skeleton.mjs";
import type { HandPoints } from "../../../clip/src/index.ts";
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
  /** Each bone's full length, for lifting the pose into 3D. */
  lengths: BoneLengths;
}

/** The puppet's state at one moment: its turn, and the whole guide's facts. */
export interface GuidePose { turn: Turn; clip: PuppetClip; /** The frame position it was taken at (3.4 is between frames 3 and 4). */ position?: number }

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
  const clip: PuppetClip = { turns: bodyTurns(drawingGuide(guide)), torso: median(torsos), footY: median(feet), centerX: median(centers), lengths: boneLengths(guide) };
  clips.set(guide, clip);
  return clip;
}

const drawn = new WeakMap<Guide, Guide>();
const steadied = new WeakMap<Guide, Guide>();

/**
 * The guide as the puppet draws it: its depth softened (the engine's `smoothTimeline`, which nothing else
 * applies to depth). The pose itself is smoothed once, by whoever made the guide (blind mode's steadyRole,
 * or `steadyGuide` in the labs), never twice here. Only for drawing: the scorer reads the guide as it is.
 */
export function drawingGuide(guide: Guide): Guide {
  const kept = drawn.get(guide);
  if (kept) return kept;
  let depths = guide.depths;
  if (guide.timeline && depths && depths.length === guide.timeline.frames.length) {
    // Depth goes through the smoother carried in the x of a stand-in timeline.
    const asTimeline = { ...guide.timeline, frames: guide.timeline.frames.map((f, i) => ({ tMs: f.tMs, landmarks: depths![i]?.map((z): Landmark => [z, 0, 1]) ?? null })) };
    depths = smoothTimeline(asTimeline).frames.map((f) => f.landmarks?.map((l) => l[0]) ?? null);
  }
  const out: Guide = depths === guide.depths ? guide : { ...guide, depths };
  drawn.set(guide, out);
  return out;
}

/**
 * For pages that draw a guide straight from the clip side (the labs): the pose made steady the way blind
 * mode makes its roles, smoothed once (the engine's `smoothTimeline`) and with joints the tracker stays unsure
 * of hidden (`hideUnsureJoints`). Blind mode does this itself, so the game never calls it.
 */
export function steadyGuide(guide: Guide): Guide {
  const kept = steadied.get(guide);
  if (kept) return kept;
  const out = guide.timeline ? { ...guide, timeline: hideUnsureJoints(smoothTimeline(guide.timeline)) } : guide;
  steadied.set(guide, out);
  return out;
}

/**
 * A one-frame guide at frame position `position` (3.4 is four tenths of the way from frame 3 to 4) of the
 * smoothed guide, curving through the samples on either side (Catmull-Rom) instead of joining them with
 * straight lines, so the puppet moves without the jerk of a 15-a-second sample rate. Draw it with index 0,
 * with `guidePoseAt(guide, position)` for its turn.
 */
export function guideSliceAt(guide: Guide, position: number): Guide {
  const g = drawingGuide(guide);
  const frames = g.timeline?.frames ?? [];
  const last = frames.length - 1;
  const p = Math.min(Math.max(0, last), Math.max(0, position));
  const i = Math.floor(p), u = p - i;
  const at = (k: number) => frames[Math.min(last, Math.max(0, k))]?.landmarks ?? null;
  const p1 = at(i), p2 = at(i + 1) ?? p1, p0 = at(i - 1) ?? p1, p3 = at(i + 2) ?? p2;
  const curve = (a: number, b: number, c: number, d: number) =>
    0.5 * (2 * b + (c - a) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (3 * b - a - 3 * c + d) * u * u * u);
  let landmarks: Landmark[] | null = null;
  if (p1 && p2 && p0 && p3) {
    landmarks = p1.map((b, k) => {
      const a = p0[k]!, c = p2[k]!, d = p3[k]!;
      return [curve(a[0], b[0], c[0], d[0]), curve(a[1], b[1], c[1], d[1]), Math.min(b[2], c[2])] as const;
    });
  } else if (p1) {
    landmarks = [...p1];
  }
  const dAt = (k: number) => g.depths?.[Math.min(last, Math.max(0, k))] ?? null;
  const d1 = dAt(i), d2 = dAt(i + 1) ?? d1, d0 = dAt(i - 1) ?? d1, d3 = dAt(i + 2) ?? d2;
  const depth = d1 && d2 && d0 && d3 && d1.length === d2.length ? d1.map((b, k) => curve(d0[k]!, b, d2[k]!, d3[k]!)) : d1;
  return {
    ...g,
    boxTrack: { ...g.boxTrack, frames: [{ tMs: 0, box: landmarks ? boxFromLandmarks(landmarks) : g.boxTrack.frames[i]?.box ?? null }] },
    outlines: [g.outlines[i] ?? null],
    timeline: g.timeline && { ...g.timeline, frames: [{ tMs: 0, landmarks }] },
    depths: g.depths ? [depth] : undefined,
  };
}

/** The puppet's pose at a frame position of the whole guide; between two frames (`position` 3.4) the turn is blended. */
export function guidePoseAt(guide: Guide, position: number): GuidePose {
  const clip = puppetClip(guide);
  const last = clip.turns.length - 1;
  if (last < 0) return { turn: NO_TURN, clip, position };
  const p = Math.min(last, Math.max(0, position));
  const i = Math.floor(p), j = Math.min(last, i + 1), u = p - i;
  const a = clip.turns[i]!, b = clip.turns[j]!;
  return { turn: { yaw: a.yaw + (b.yaw - a.yaw) * u, face: a.face + (b.face - a.face) * u }, clip, position };
}

/** The guide's frame at media time `mediaMs`, clamped to its range. */
export function guideFrameAt(guide: Guide, mediaMs: number): number {
  const frameMs = 1000 / guide.source.sampleHz;
  const last = guide.boxTrack.frames.length - 1;
  return Math.min(last, Math.max(0, Math.round((mediaMs - guide.range.startMs) / frameMs)));
}

/**
 * Works out the placement once per guide and canvas size; reuse it for every frame so the subject does not drift.
 * For the puppet, the fit counts its hat, bells, shoes and white edge as well as the body.
 */
export function blindView(guide: Guide, canvas: HTMLCanvasElement, placement: Placement, look?: Look): View {
  return placeSubject(look === "puppet" && placement === "fit" ? puppetRoom(guide) : guide, canvas, placement);
}

/**
 * The room the puppet takes at each frame: the subject's outline or box, grown to hold the hat and its bells
 * round the head, the shoes and shadow below, and the white edge all round. Sizes are shares of the torso,
 * as the puppet's are (`HEAD` and `HAT_REACH` in puppet.ts).
 */
function puppetRoom(guide: Guide): Pick<Guide, "source" | "boxTrack" | "outlines"> {
  const { width, height } = guide.source;
  const clip = puppetClip(guide);
  const frames = guide.boxTrack.frames.map((f, i) => {
    const outline = guide.outlines[i];
    let left: number, right: number, top: number, bottom: number;
    if (outline && outline.length >= 3) {
      left = Math.min(...outline.map((p) => p[0])); right = Math.max(...outline.map((p) => p[0]));
      top = Math.min(...outline.map((p) => p[1])); bottom = Math.max(...outline.map((p) => p[1]));
    } else if (f.box) {
      left = f.box.cx - f.box.w / 2; right = f.box.cx + f.box.w / 2; top = f.box.cy - f.box.h / 2; bottom = f.box.cy + f.box.h / 2;
    } else return f;
    const torsoPx = clip.torso ?? (bottom - top) * height * 0.3;
    // The hat's reach from the head's middle, plus the white edge.
    const side = HEAD * HAT_REACH.side + 0.08, rise = HEAD * HAT_REACH.up + 0.08;
    const tx = torsoPx / width, ty = torsoPx / height;
    const l = guide.timeline?.frames[i]?.landmarks;
    const seen = (k: number) => !!l && (l[k]?.[2] ?? 0) >= MIN_VISIBILITY;
    const head = l && seen(7) && seen(8) ? [(l[7]![0] + l[8]![0]) / 2, (l[7]![1] + l[8]![1]) / 2]
      : l && seen(0) ? [l[0]![0], l[0]![1]] : [(left + right) / 2, top];
    left = Math.min(left, head[0]! - side * tx) - 0.08 * tx;
    right = Math.max(right, head[0]! + side * tx) + 0.08 * tx;
    top = Math.min(top, head[1]! - rise * ty) - 0.08 * ty;
    bottom += 0.25 * ty;
    return { ...f, box: { cx: (left + right) / 2, cy: (top + bottom) / 2, w: right - left, h: bottom - top } };
  });
  return { source: guide.source, boxTrack: { ...guide.boxTrack, frames }, outlines: frames.map(() => null) };
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

// ---- Keeping the guide light ----

/**
 * The most the 3D jester may take to draw, on average over a turn's first second (milliseconds per draw). The game
 * paints the guide 30 times a second and draws the jester twice a paint (the figure and the faint look-ahead copy),
 * so this keeps the guide well under half of each 33 ms frame, leaving the rest to the webcam tracker on the same
 * thread. A laptop GPU draws it in about 1 ms.
 */
export const GUIDE_BUDGET_MS = 6;
/**
 * The page's frame rate below which a puppet guide gives way, measured over a turn's first second. Draw time alone
 * misses the real cost on a machine without a GPU (software rendering): there the browser spends its time putting
 * the big canvas pictures on screen, outside the drawing code, and both the 3D jester (about 13 fps) and the flat
 * sticker (about 16 fps) drag the page down while the stick figure keeps 60.
 */
export const GUIDE_MIN_FPS = 20;
/** How long the start of a turn is measured. */
const MEASURE_MS = 1000;

/** What the guide draws this turn: the 3D jester, the flat sticker, or the stick figure on the plain background. */
type GuideMode = "3d" | "flat" | "stick";
const guard = { mode: "3d" as GuideMode, from: 0, total: 0, count: 0, said: false, decided: false, first: true, turn: 0 };

function giveWay(to: GuideMode, why: string) {
  guard.mode = to;
  if (!guard.said) { console.info(`Guide: ${why}; the ${to === "stick" ? "stick figure" : "flat sticker"} plays ${to === "flat" ? "this turn" : "the rest of this turn"}.`); guard.said = true; }
}

/**
 * Call when a turn starts. A 3D jester is used only if it is ready now (the turn never waits for it; else the flat
 * sticker). For any puppet guide the page's frame rate over the first second is measured against GUIDE_MIN_FPS, and
 * for the 3D jester its draw time against GUIDE_BUDGET_MS; either one failing hands the rest of the turn to the stick
 * figure. Said once in the console.
 */
export function startGuideTurn(puppet: Construction | null) {
  const turn = ++guard.turn;
  Object.assign(guard, { from: 0, total: 0, count: 0, said: false, decided: false, mode: "3d" });
  if (!puppet) return;
  if (puppet === "d") {
    want3d();
    if (!puppet3d?.available()) giveWay("flat", "the 3D jester is not ready (or this browser has no WebGL)");
  }
  if (typeof requestAnimationFrame === "undefined") return;
  let frames = 0;
  const begin = performance.now();
  const count = (now: number) => {
    if (guard.turn !== turn) return;
    frames++;
    if (now - begin < MEASURE_MS) { requestAnimationFrame(count); return; }
    const fps = (frames * 1000) / (now - begin);
    if (fps < GUIDE_MIN_FPS && guard.mode !== "stick") giveWay("stick", `the page ran at ${fps.toFixed(0)} fps (needs ${GUIDE_MIN_FPS})`);
  };
  requestAnimationFrame(count);
}

/** True when the guard has handed this turn to the stick figure. */
export function guideGaveWay(): boolean {
  return guard.mode === "stick";
}

/**
 * Adds one 3D draw's time. The very first 3D draw on the page (three.js compiling its shaders) is left out of the
 * average. The decision comes at the end of the first second, or sooner after 30 draws, from at least 3 draws.
 */
function measure3d(ms: number) {
  if (guard.first) { guard.first = false; return; }
  if (guard.decided) return;
  const now = performance.now();
  if (!guard.from) guard.from = now;
  guard.total += ms; guard.count++;
  if (guard.count < 3 || (now - guard.from < MEASURE_MS && guard.count < 30)) return;
  guard.decided = true;
  const avg = guard.total / guard.count;
  if (avg > GUIDE_BUDGET_MS) giveWay("stick", `the 3D jester took ${avg.toFixed(1)} ms a draw (budget ${GUIDE_BUDGET_MS} ms)`);
}

/** The last 3D picture drawn on each canvas, reused while the pose has not moved by half a sample. */
const drawnFigures = new WeakMap<HTMLCanvasElement, { key: string; image: HTMLCanvasElement }>();
const clipIds = new WeakMap<PuppetClip, number>();
let nextClipId = 1;

/**
 * The background alone: the stage when `style.stage`, else the plain colour. `pose` (from the whole guide)
 * places the floor and spotlight under the subject; without it the guide itself is used.
 */
export function drawBlindBackground(canvas: HTMLCanvasElement, guide: Guide, view: View, style: BlindStyle = DEFAULT_STYLE, pose?: GuidePose) {
  const ctx = canvas.getContext("2d")!;
  if (!style.stage || guard.mode === "stick") {
    ctx.fillStyle = style.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }
  ctx.drawImage(stageImage(canvas.width, canvas.height, stageSpot(canvas, guide, view, pose), style.stage), 0, 0);
}

/**
 * Where the stage's floor and spotlight go on `canvas`: the floor's back edge a little behind where the
 * subject usually stands, the light on their usual spot. Give it the role's base view, not one resized to
 * the player, so the stage stays put (and its cached picture is reused).
 */
export function stageSpot(canvas: { width: number; height: number }, guide: Guide, view: View, pose?: GuidePose): StageSpot {
  const clip = pose?.clip ?? puppetClip(guide);
  const { width: w, height: h } = canvas;
  const torsoPx = clip.torso !== null ? clip.torso * view.scale : null;
  const footPx = clip.footY !== null ? clip.footY * guide.source.height * view.scale + view.offsetY : null;
  const floorY = footPx !== null ? Math.min(h * 0.88, Math.max(h * 0.5, footPx - (torsoPx ?? h * 0.15) * 0.35)) : h * 0.76;
  const spotX = clip.centerX !== null ? Math.min(w * 0.8, Math.max(w * 0.2, clip.centerX * guide.source.width * view.scale + view.offsetX)) : w / 2;
  return { floorY, spotX };
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

  if (look === "puppet" && guard.mode !== "stick") {
    const at = pose ?? guidePoseAt(guide, index);
    const torso = at.clip.torso !== null ? at.clip.torso * view.scale : sizePx * 0.3;
    const depth = guide.depths?.[index] ?? null;
    if (style.puppet === "d" && guard.mode === "3d") {
      want3d();
      if (puppet3d?.available()) {
        const started = performance.now();
        // The pose changes about 15 times a second; the picture is redrawn only when it has moved by half a sample.
        let id = clipIds.get(at.clip);
        if (!id) { id = nextClipId++; clipIds.set(at.clip, id); }
        const key = at.position === undefined ? "" : [id, Math.round(at.position * 2), canvas.width, canvas.height, style.color, style.faint ? 1 : 0, view.scale.toFixed(4), view.offsetX.toFixed(1), view.offsetY.toFixed(1)].join("|");
        let kept = drawnFigures.get(canvas);
        if (key && kept && kept.key === key) {
          ctx.drawImage(kept.image, 0, 0);
          measure3d(performance.now() - started);
          return;
        }
        if (!kept) { kept = { key: "", image: document.createElement("canvas") }; drawnFigures.set(canvas, kept); }
        const image = kept.image;
        if (image.width !== canvas.width || image.height !== canvas.height) { image.width = canvas.width; image.height = canvas.height; }
        const ic = image.getContext("2d")!;
        ic.clearRect(0, 0, image.width, image.height);
        const { width, height } = guide.source;
        const lifted = liftPose(landmarks, depth, at.turn, at.clip.lengths, width, height);
        // Source pixels to canvas pixels; depth scales the same way.
        lifted.joints = lifted.joints.map((p) => (p ? [p[0] * view.scale + view.offsetX, p[1] * view.scale + view.offsetY, p[2] * view.scale] : null));
        if (!style.faint) floorShadow(ic, landmarks, map, torso);
        if (puppet3d.drawPuppet3d(ic, { lifted, turn: at.turn, torso, suit: suitFor(style.color) }, !!style.faint)) {
          kept.key = key;
          ctx.drawImage(image, 0, 0);
          measure3d(performance.now() - started);
          return;
        }
      }
    }
    let swing = swings.get(canvas);
    if (!swing) { swing = newSwing(); swings.set(canvas, swing); }
    drawPuppet(ctx, { landmarks, depth, turn: at.turn, torso }, map, suitFor(style.color), style.puppet === "b" ? "b" : "a", swing);
    return;
  }

  const hands = guide.hands?.[index] ?? null;
  // A hand with finger data is drawn from its fingers, so the pose model's 4-point hand is left out for that side only:
  // a hand the finger pass missed in this frame keeps its simple hand instead of vanishing.
  const BONES = hands
    ? [...BODY_BONES, ...FOOT_BONES, ...FACE_BONES, ...(hands.left ? [] : HAND_BONES.filter(([a]) => a! < 16)), ...(hands.right ? [] : HAND_BONES.filter(([a]) => a! >= 16))]
    : DETAIL_BONES;
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

const PALM = [0, 1, 5, 9, 13, 17];
const TIPS = new Set([4, 8, 12, 16, 20]);
