// Which way a person's body is turned, for drawing the blind mode guide as a figure that reads as 3D.
// Only the drawing uses this: the scorer never reads it.
//
// The turn is an angle about the vertical axis. 0 is square to the camera. Positive means the
// subject's left side is farther from the camera than their right, so they face the image's right
// (the image is unmirrored, so their left shoulder sits on the image's right when they face us).
//
// With depth from the tracker, the angle comes from how far behind one shoulder (and hip) sits
// compared with the other. Without it, the size of the angle comes from how narrow the shoulders and
// hips look against the clip's widest, and the side from how far the nose sits off the midpoint of
// the ears. Trackers often swap left and right on a turned back, so the turn fades toward 0 when the
// nose and ears are not clearly seen, and `face` says how sure we are that the face is toward us.

import type { Landmark, Landmarks } from "../../engine/src/index.ts";
import type { Depth, Guide } from "./types.ts";

export interface Turn {
  /** Radians, -pi/2 to pi/2. 0 is square to the camera; positive faces the image's right. */
  yaw: number;
  /** 0 to 1: how sure we are the face is toward the camera. Near 0 the back is to us. */
  face: number;
}

export const NO_TURN: Turn = { yaw: 0, face: 1 };

const NOSE = 0, LEFT_EAR = 7, RIGHT_EAR = 8;
const LEFT_SHOULDER = 11, RIGHT_SHOULDER = 12, LEFT_HIP = 23, RIGHT_HIP = 24;
const SEEN = 0.5;
/** Nose and ear visibility below the first counts as not seen, above the second as clearly seen. */
const FACE_UNSEEN = 0.3, FACE_SEEN = 0.7;
/**
 * Shoulder width plus hip width over torso length, for an adult facing the camera, a little under
 * the usual value. A clip that never shows its subject square on still reads as turned.
 */
const FRONT_RATIO_FLOOR = 0.9;
/** The nose sits about this far (in torso lengths) off the ears' midpoint when the head is turned well aside. */
const NOSE_SIDE_REACH = 0.1;
/** Shoulders count twice as much as hips: the tracker's hip depth is weak. */
const SHOULDER_WEIGHT = 2;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smoothstep = (lo: number, hi: number, v: number) => {
  const t = clamp((v - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
};

/** A landmark in units of image height (x stretched by the aspect), or null when not seen. */
function point(l: Landmark | undefined, aspect: number): [number, number] | null {
  return l && l[2] >= SEEN ? [l[0] * aspect, l[1]] : null;
}

const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/** The body's spread: shoulder width plus hip width over torso length. Null when any of the four is not seen. */
export function bodySpread(landmarks: Landmarks, aspect: number): number | null {
  if (!landmarks) return null;
  const ls = point(landmarks[LEFT_SHOULDER], aspect), rs = point(landmarks[RIGHT_SHOULDER], aspect);
  const lh = point(landmarks[LEFT_HIP], aspect), rh = point(landmarks[RIGHT_HIP], aspect);
  if (!ls || !rs || !lh || !rh) return null;
  const torso = dist(mid(ls, rs), mid(lh, rh));
  if (torso <= 1e-6) return null;
  return (dist(ls, rs) + dist(lh, rh)) / torso;
}

/** The clip's widest spread, from its 90th percentile so one bent-over frame does not set it, and never under the usual front-on value. */
export function widestSpread(frames: readonly Landmarks[], aspect: number): number {
  const spreads = frames.map((l) => bodySpread(l, aspect)).filter((s): s is number => s !== null).sort((a, b) => a - b);
  const high = spreads.length ? spreads[Math.min(spreads.length - 1, Math.floor(spreads.length * 0.9))]! : 0;
  return Math.max(high, FRONT_RATIO_FLOOR);
}

/** How sure we are the face is toward the camera, from the nose and the better seen ear. */
function faceSeen(landmarks: readonly Landmark[]): number {
  const nose = landmarks[NOSE]?.[2] ?? 0;
  const ear = Math.max(landmarks[LEFT_EAR]?.[2] ?? 0, landmarks[RIGHT_EAR]?.[2] ?? 0);
  return smoothstep(FACE_UNSEEN, FACE_SEEN, Math.min(nose, ear));
}

/** The turn from depth: how far the left shoulder and hip sit behind the right ones. Null without the shoulders. */
function yawFromDepth(landmarks: readonly Landmark[], depth: Depth, aspect: number): number | null {
  const ls = point(landmarks[LEFT_SHOULDER], aspect), rs = point(landmarks[RIGHT_SHOULDER], aspect);
  const zls = depth[LEFT_SHOULDER], zrs = depth[RIGHT_SHOULDER];
  if (!ls || !rs || zls === undefined || zrs === undefined) return null;
  // Depth is in units of image width, like x; stretch both by the aspect to match.
  let dx = SHOULDER_WEIGHT * (ls[0] - rs[0]);
  let dz = SHOULDER_WEIGHT * (zls - zrs) * aspect;
  const lh = point(landmarks[LEFT_HIP], aspect), rh = point(landmarks[RIGHT_HIP], aspect);
  const zlh = depth[LEFT_HIP], zrh = depth[RIGHT_HIP];
  if (lh && rh && zlh !== undefined && zrh !== undefined) {
    dx += lh[0] - rh[0];
    dz += (zlh - zrh) * aspect;
  }
  if (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9) return null;
  // Folded to a sideways turn: which side is farther and by how much. Front or back is `face`'s job.
  return Math.atan2(dz, Math.abs(dx));
}

/** The turn from the body's flat outline: narrowness against the widest for the size, the nose for the side. */
function yawFromWidth(landmarks: readonly Landmark[], aspect: number, widest: number): number | null {
  const spread = bodySpread(landmarks, aspect);
  if (spread === null) return null;
  const size = Math.acos(clamp(spread / widest, 0, 1));
  const ls = point(landmarks[LEFT_SHOULDER], aspect)!, rs = point(landmarks[RIGHT_SHOULDER], aspect)!;
  const lh = point(landmarks[LEFT_HIP], aspect)!, rh = point(landmarks[RIGHT_HIP], aspect)!;
  const torso = dist(mid(ls, rs), mid(lh, rh));
  const nose = point(landmarks[NOSE], aspect);
  const le = point(landmarks[LEFT_EAR], aspect), re = point(landmarks[RIGHT_EAR], aspect);
  if (!nose || (!le && !re)) return 0;
  // In profile one ear is hidden; then the seen ear stands in for the head's middle.
  const earMid = le && re ? mid(le, re) : (le ?? re)!;
  const side = clamp((nose[0] - earMid[0]) / (NOSE_SIDE_REACH * torso), -1, 1);
  return side * size;
}

/**
 * The turn of one frame, unsmoothed. `widest` is the clip's widest spread (`widestSpread`), used only
 * without depth. Null when the body is not seen well enough to tell.
 */
export function frameTurn(landmarks: Landmarks, depth: Depth | null | undefined, aspect: number, widest: number): Turn | null {
  if (!landmarks) return null;
  const usable = depth && depth.length === landmarks.length ? depth : null;
  const yaw = (usable ? yawFromDepth(landmarks, usable, aspect) : null) ?? yawFromWidth(landmarks, aspect, widest);
  if (yaw === null) return null;
  const face = faceSeen(landmarks);
  return { yaw: yaw * face, face };
}

/**
 * The turn at every timeline frame of a person's guide, smoothed over `window` frames (centred).
 * Frames where the turn is unknown take their neighbours' within the window, else no turn.
 * Guides saved without depth, and things, work too (things get no turn).
 */
export function bodyTurns(guide: Pick<Guide, "source" | "timeline" | "depths">, window = 5): Turn[] {
  const frames = guide.timeline?.frames ?? [];
  const aspect = guide.source.width / guide.source.height;
  const widest = widestSpread(frames.map((f) => f.landmarks), aspect);
  const raw = frames.map((f, i) => frameTurn(f.landmarks, guide.depths?.[i], aspect, widest));
  const half = Math.floor(window / 2);
  return raw.map((_, i) => {
    let yaw = 0, face = 0, n = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(raw.length - 1, i + half); k++) {
      const t = raw[k];
      if (!t) continue;
      yaw += t.yaw; face += t.face; n++;
    }
    return n ? { yaw: yaw / n, face: face / n } : NO_TURN;
  });
}
