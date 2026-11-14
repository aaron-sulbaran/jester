// Skeleton gate: decide per clip whether the subject's pose is good enough for the pose channel,
// or whether the round should use the trajectory channel (cartoons, sprites, objects).

import { LM, torsoLength, midpoint, MID } from "./geometry.ts";
import { gridLength, resamplePoses } from "./resample.ts";
import type { Landmarks, PoseTimeline } from "./types.ts";

export const GATE = {
  samples: 48,
  minDetectionShare: 0.7,
  minVisibility: 0.5,
  minVisibleLimbJoints: 8,
  maxMedianJump: 0.25,
  maxP95Jump: 0.6,
  minSymmetry: 0.7,
  maxSymmetry: 1.4,
} as const;

const LIMB_JOINTS = [
  LM.leftShoulder, LM.rightShoulder, LM.leftElbow, LM.rightElbow, LM.leftWrist, LM.rightWrist,
  LM.leftHip, LM.rightHip, LM.leftKnee, LM.rightKnee, LM.leftAnkle, LM.rightAnkle,
];
const TORSO = [LM.leftShoulder, LM.rightShoulder, LM.leftHip, LM.rightHip];
const PAIRS: readonly (readonly [number, number, number, number])[] = [
  [LM.leftShoulder, LM.leftElbow, LM.rightShoulder, LM.rightElbow],
  [LM.leftElbow, LM.leftWrist, LM.rightElbow, LM.rightWrist],
  [LM.leftHip, LM.leftKnee, LM.rightHip, LM.rightKnee],
  [LM.leftKnee, LM.leftAnkle, LM.rightKnee, LM.rightAnkle],
];

export interface GateResult {
  usable: boolean;
  channel: "pose" | "trajectory";
  reasons: string[];
  detectionShare: number;
  medianJump: number | null;
  p95Jump: number | null;
  symmetry: number | null;
}

function sortedMedian(v: number[]): number | null {
  if (v.length === 0) return null;
  const s = v.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function goodFrame(l: Landmarks): l is NonNullable<Landmarks> {
  if (!l) return false;
  if (!TORSO.every((i) => l[i]![2] >= GATE.minVisibility)) return false;
  return LIMB_JOINTS.filter((i) => l[i]![2] >= GATE.minVisibility).length >= GATE.minVisibleLimbJoints;
}

export function skeletonGate(timeline: PoseTimeline): GateResult {
  const last = timeline.frames.reduce((m, f) => (f.tMs > m ? f.tMs : m), -1);
  const n = gridLength(last);
  const aspect = timeline.source.width / timeline.source.height;
  const grid = resamplePoses(timeline.frames, n);
  const reasons: string[] = [];
  const count = Math.min(GATE.samples, Math.max(0, n - 2));
  if (count === 0) {
    return { usable: false, channel: "trajectory", reasons: ["clip too short"], detectionShare: 0, medianJump: null, p95Jump: null, symmetry: null };
  }
  let good = 0;
  const jumps: number[] = [];
  const ratios: number[] = [];
  for (let s = 0; s < count; s++) {
    const k = Math.floor((s * (n - 2)) / count);
    const a = grid[k]!, b = grid[k + 2]!;
    if (!goodFrame(a)) continue;
    good++;
    const L = torsoLength(a, aspect);
    if (goodFrame(b) && L) {
      // Mean joint displacement over 1/15 s, in torso lengths.
      let d = 0;
      for (const i of LIMB_JOINTS) d += Math.hypot((b[i]![0] - a[i]![0]) * aspect, b[i]![1] - a[i]![1]);
      jumps.push(d / LIMB_JOINTS.length / L);
    }
    for (const [l1, l2, r1, r2] of PAIRS) {
      const ll = Math.hypot((a[l2]![0] - a[l1]![0]) * aspect, a[l2]![1] - a[l1]![1]);
      const rl = Math.hypot((a[r2]![0] - a[r1]![0]) * aspect, a[r2]![1] - a[r1]![1]);
      if (ll > 1e-6 && rl > 1e-6) ratios.push(ll / rl);
    }
  }
  const detectionShare = good / count;
  if (detectionShare < GATE.minDetectionShare) reasons.push(`pose found on ${Math.round(detectionShare * 100)}% of sampled frames`);
  const medianJump = sortedMedian(jumps);
  const sortedJumps = jumps.slice().sort((x, y) => x - y);
  const p95Jump = sortedJumps.length ? sortedJumps[Math.min(sortedJumps.length - 1, Math.round(0.95 * (sortedJumps.length - 1)))]! : null;
  if (medianJump !== null && medianJump > GATE.maxMedianJump) reasons.push("skeleton jitters too much");
  if (p95Jump !== null && p95Jump > GATE.maxP95Jump) reasons.push("skeleton teleports between frames");
  const symmetry = sortedMedian(ratios);
  if (symmetry !== null && (symmetry < GATE.minSymmetry || symmetry > GATE.maxSymmetry)) reasons.push("left and right limbs disagree in length");
  const usable = reasons.length === 0;
  return { usable, channel: usable ? "pose" : "trajectory", reasons, detectionShare, medianJump, p95Jump, symmetry };
}

// Re-exported for tests that build skeletons around a body center.
export { midpoint, MID };
