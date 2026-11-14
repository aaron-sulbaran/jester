// Body geometry: limbs as unit directions, mirroring, aspect correction.

import type { Landmark } from "./types.ts";

export const LM = {
  nose: 0,
  leftShoulder: 11, rightShoulder: 12,
  leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16,
  leftHip: 23, rightHip: 24,
  leftKnee: 25, rightKnee: 26,
  leftAnkle: 27, rightAnkle: 28,
  leftPinky: 17, rightPinky: 18,
  leftIndex: 19, rightIndex: 20,
  leftHeel: 29, rightHeel: 30,
  leftFootIndex: 31, rightFootIndex: 32,
} as const;

/** A limb end is one landmark, or several whose midpoint is used. */
type End = number | readonly number[];

export interface LimbDef {
  from: End;
  to: End;
  /** Importance: arms drive perceived similarity most. */
  weight: number;
  label: string;
  /** Out of view on the player never costs points (too often unseen by laptop cameras to judge). */
  ignoreUnseen?: boolean;
}

const MID_SHOULDER = [LM.leftShoulder, LM.rightShoulder] as const;
const MID_HIP = [LM.leftHip, LM.rightHip] as const;
/** The knuckles: midpoint of the index and pinky base points. */
const L_KNUCKLES = [LM.leftIndex, LM.leftPinky] as const;
const R_KNUCKLES = [LM.rightIndex, LM.rightPinky] as const;

/** Limb names use the REFERENCE performer's left and right. Order is fixed (it is the iteration order). */
export const LIMBS: Readonly<Record<string, LimbDef>> = {
  leftUpperArm: { from: LM.leftShoulder, to: LM.leftElbow, weight: 1.5, label: "left upper arm" },
  leftForearm: { from: LM.leftElbow, to: LM.leftWrist, weight: 1.5, label: "left forearm" },
  rightUpperArm: { from: LM.rightShoulder, to: LM.rightElbow, weight: 1.5, label: "right upper arm" },
  rightForearm: { from: LM.rightElbow, to: LM.rightWrist, weight: 1.5, label: "right forearm" },
  leftThigh: { from: LM.leftHip, to: LM.leftKnee, weight: 1.0, label: "left thigh" },
  leftShin: { from: LM.leftKnee, to: LM.leftAnkle, weight: 1.0, label: "left shin" },
  rightThigh: { from: LM.rightHip, to: LM.rightKnee, weight: 1.0, label: "right thigh" },
  rightShin: { from: LM.rightKnee, to: LM.rightAnkle, weight: 1.0, label: "right shin" },
  shoulderLine: { from: LM.leftShoulder, to: LM.rightShoulder, weight: 0.75, label: "shoulders" },
  hipLine: { from: LM.leftHip, to: LM.rightHip, weight: 0.75, label: "hips" },
  torso: { from: MID_HIP, to: MID_SHOULDER, weight: 0.75, label: "torso" },
  neck: { from: MID_SHOULDER, to: LM.nose, weight: 0.5, label: "head" },
  // Hands and feet: the tracker's detail points are jumpier than the big joints, so they weigh less.
  // Feet seen from the front are short and noisy (heel to toe points at the camera), so they weigh least.
  leftHand: { from: LM.leftWrist, to: L_KNUCKLES, weight: 0.5, label: "left hand" },
  rightHand: { from: LM.rightWrist, to: R_KNUCKLES, weight: 0.5, label: "right hand" },
  leftFoot: { from: LM.leftHeel, to: LM.leftFootIndex, weight: 0.25, label: "left foot", ignoreUnseen: true },
  rightFoot: { from: LM.rightHeel, to: LM.rightFootIndex, weight: 0.25, label: "right foot", ignoreUnseen: true },
};

export const LIMB_NAMES: readonly string[] = Object.keys(LIMBS);
export const TOTAL_LIMB_WEIGHT = LIMB_NAMES.reduce((s, n) => s + LIMBS[n]!.weight, 0);

const MIRROR_PAIRS: readonly (readonly [number, number])[] = [
  [1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16],
  [17, 18], [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32],
];
const MIRROR_INDEX: readonly number[] = (() => {
  const m = Array.from({ length: 33 }, (_, i) => i);
  for (const [a, b] of MIRROR_PAIRS) { m[a] = b; m[b] = a; }
  return m;
})();

/** The pose as seen in a mirror: x flipped, left and right labels swapped. */
export function mirrorLandmarks(lms: readonly Landmark[]): Landmark[] {
  return lms.map((_, i) => {
    const s = lms[MIRROR_INDEX[i] ?? i]!;
    return [1 - s[0], s[1], s[2]] as const;
  });
}

/** Swap "left" and "right" in a label (used to name a limb from the player's own side). */
export function swapSide(label: string): string {
  return label.replace(/\b(left|right)\b/g, (m) => (m === "left" ? "right" : "left"));
}

interface Point { x: number; y: number; v: number }

function endPoint(lms: readonly Landmark[], end: End, aspect: number): Point {
  const ids = typeof end === "number" ? [end] : end;
  let x = 0, y = 0, v = 1;
  for (const i of ids) {
    const l = lms[i]!;
    x += l[0]; y += l[1];
    v = Math.min(v, l[2]);
  }
  return { x: (x / ids.length) * aspect, y: y / ids.length, v };
}

export interface Direction { x: number; y: number; visibility: number }

/**
 * Unit direction of a limb, with x scaled by width / height so both axes use the same ruler.
 * null when the limb has zero length.
 */
export function limbDirection(lms: readonly Landmark[], limb: LimbDef, aspect: number): Direction | null {
  const a = endPoint(lms, limb.from, aspect);
  const b = endPoint(lms, limb.to, aspect);
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-9)) return null;
  return { x: dx / len, y: dy / len, visibility: Math.min(a.v, b.v) };
}

/** Distance from shoulder midpoint to hip midpoint, in image-height units after aspect correction. */
export function torsoLength(lms: readonly Landmark[], aspect: number): number | null {
  const s = endPoint(lms, MID_SHOULDER, aspect);
  const h = endPoint(lms, MID_HIP, aspect);
  if (Math.min(s.v, h.v) < 0.5) return null;
  const d = Math.hypot(s.x - h.x, s.y - h.y);
  return d > 1e-6 ? d : null;
}

export function midpoint(lms: readonly Landmark[], ids: readonly number[], aspect: number): Point {
  return endPoint(lms, ids, aspect);
}

export const MID = { shoulder: MID_SHOULDER, hip: MID_HIP } as const;
