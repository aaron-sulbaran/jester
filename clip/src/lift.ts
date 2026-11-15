// A tracked pose lifted into 3D, for drawing the blind mode guide as a solid figure. Only the drawing uses
// this: the scorer never reads it.
//
// x and y stay exactly where the tracker put each joint (so the figure stands where the stick figure
// would); only depth is added. Shoulders and hips get theirs from the body's turn. Every limb keeps its
// full length through the clip: when a bone looks shorter than that, the missing length is how far it
// points toward or away from the camera. Which way comes from the tracker's own depth when it is clear,
// else from what bodies usually do: knees and elbows forward, a planted foot back under its hip.
//
// Units are source pixels; z grows away from the camera, as in the tracker.

import type { Landmark, Landmarks } from "../../engine/src/index.ts";
import type { Turn } from "./turn.ts";
import type { Depth, Guide } from "./types.ts";

export type Vec3 = [number, number, number];

/** Full lengths of the body's bones in source pixels, from how long each looks at its longest in the clip. */
export interface BoneLengths {
  shoulders: number; hips: number;
  upperArm: number; forearm: number; thigh: number; shin: number; foot: number;
}

export interface Lifted {
  /** Each landmark in source pixels (x right, y down, z away from the camera); null where not seen. */
  joints: (Vec3 | null)[];
  /** Which way the body faces, radians: 0 toward the camera, positive toward the image's right, +-pi away. */
  facing: number;
}

const SEEN = 0.5;
const L_SHOULDER = 11, R_SHOULDER = 12, L_ELBOW = 13, R_ELBOW = 14, L_WRIST = 15, R_WRIST = 16;
const L_HIP = 23, R_HIP = 24, L_KNEE = 25, R_KNEE = 26, L_ANKLE = 27, R_ANKLE = 28;
const L_HEEL = 29, R_HEEL = 30, L_TOE = 31, R_TOE = 32;
const HAND = [[15, 17, 19, 21], [16, 18, 20, 22]] as const;
/** The tracker's own depth decides a bone's direction only when it puts the ends this far apart (share of the bone). */
const CLEAR_DEPTH = 0.25;

const percentile = (xs: number[], q: number, fallback: number) => {
  if (!xs.length) return fallback;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
};

/** The guide's bone lengths: each bone's 90th percentile length in the clip (its longest, without the odd bad frame). */
export function boneLengths(guide: Pick<Guide, "source" | "timeline">): BoneLengths {
  const { width, height } = guide.source;
  const pairs: Record<keyof BoneLengths, [number, number][]> = {
    shoulders: [[L_SHOULDER, R_SHOULDER]], hips: [[L_HIP, R_HIP]],
    upperArm: [[L_SHOULDER, L_ELBOW], [R_SHOULDER, R_ELBOW]], forearm: [[L_ELBOW, L_WRIST], [R_ELBOW, R_WRIST]],
    thigh: [[L_HIP, L_KNEE], [R_HIP, R_KNEE]], shin: [[L_KNEE, L_ANKLE], [R_KNEE, R_ANKLE]],
    foot: [[L_HEEL, L_TOE], [R_HEEL, R_TOE]],
  };
  const seen: Record<keyof BoneLengths, number[]> = { shoulders: [], hips: [], upperArm: [], forearm: [], thigh: [], shin: [], foot: [] };
  const torso: number[] = [];
  for (const f of guide.timeline?.frames ?? []) {
    const l = f.landmarks;
    if (!l) continue;
    const ok = (i: number) => (l[i]?.[2] ?? 0) >= SEEN;
    for (const key of Object.keys(pairs) as (keyof BoneLengths)[]) {
      for (const [a, b] of pairs[key]) {
        if (ok(a) && ok(b)) seen[key].push(Math.hypot((l[a]![0] - l[b]![0]) * width, (l[a]![1] - l[b]![1]) * height));
      }
    }
    if (ok(L_SHOULDER) && ok(R_SHOULDER) && ok(L_HIP) && ok(R_HIP)) {
      torso.push(Math.hypot(((l[11]![0] + l[12]![0]) - (l[23]![0] + l[24]![0])) / 2 * width, ((l[11]![1] + l[12]![1]) - (l[23]![1] + l[24]![1])) / 2 * height));
    }
  }
  // Without a torso to go by, a body a quarter of the frame tall.
  const t = percentile(torso, 0.5, height * 0.25);
  return {
    shoulders: percentile(seen.shoulders, 0.9, t * 0.7), hips: percentile(seen.hips, 0.9, t * 0.4),
    upperArm: percentile(seen.upperArm, 0.9, t * 0.6), forearm: percentile(seen.forearm, 0.9, t * 0.55),
    thigh: percentile(seen.thigh, 0.9, t * 0.8), shin: percentile(seen.shin, 0.9, t * 0.8), foot: percentile(seen.foot, 0.9, t * 0.3),
  };
}

/** The body's full facing from a turn: the sideways yaw, swung round toward the back as the face is lost. */
export function facingOf(turn: Turn): number {
  return Math.atan2(Math.sin(turn.yaw), Math.cos(turn.yaw) * (2 * Math.min(1, Math.max(0, turn.face)) - 1));
}

/**
 * Lifts one frame. `depth` is the tracker's (image widths, optional), `turn` the body's turn at this frame,
 * `lengths` the guide's `boneLengths`.
 */
export function liftPose(landmarks: Landmarks, depth: Depth | null | undefined, turn: Turn, lengths: BoneLengths, width: number, height: number): Lifted {
  const facing = facingOf(turn);
  const joints: (Vec3 | null)[] = new Array(33).fill(null);
  if (!landmarks) return { joints, facing };
  const flat = (i: number): [number, number] | null => {
    const l: Landmark | undefined = landmarks[i];
    return l && l[2] >= SEEN ? [l[0] * width, l[1] * height] : null;
  };
  const trackerZ = (i: number): number | null => (depth && depth.length === landmarks.length ? depth[i]! * width : null);
  // Toward the body's front, in z (negative is toward the camera).
  const forward = Math.cos(facing) >= 0 ? -1 : 1;
  const sideZ = (half: number) => Math.sin(facing) * half;

  // Shoulders and hips: left side away from the camera as the body faces the image's right.
  const place = (i: number, z: number) => { const p = flat(i); if (p) joints[i] = [p[0], p[1], z]; };
  place(L_SHOULDER, sideZ(lengths.shoulders / 2)); place(R_SHOULDER, -sideZ(lengths.shoulders / 2));
  place(L_HIP, sideZ(lengths.hips / 2)); place(R_HIP, -sideZ(lengths.hips / 2));

  /** Adds `child` beyond `parent` at the bone's full length; `prior` is the direction to use when the tracker is unsure. */
  const extend = (parent: number, child: number, full: number, prior: number) => {
    const p = joints[parent], c = flat(child);
    if (!c) return;
    if (!p) { joints[child] = [c[0], c[1], 0]; return; }
    const seen2d = Math.hypot(c[0] - p[0], c[1] - p[1]);
    const away = Math.sqrt(Math.max(0, full * full - seen2d * seen2d));
    const tp = trackerZ(parent), tc = trackerZ(child);
    const told = tp !== null && tc !== null && Math.abs(tc - tp) > CLEAR_DEPTH * full ? Math.sign(tc - tp) : 0;
    joints[child] = [c[0], c[1], p[2] + (told || prior) * away];
  };
  for (const [s, e, w] of [[L_SHOULDER, L_ELBOW, L_WRIST], [R_SHOULDER, R_ELBOW, R_WRIST]] as const) {
    extend(s, e, lengths.upperArm, forward);
    extend(e, w, lengths.forearm, forward);
  }
  for (const [h, k, a] of [[L_HIP, L_KNEE, L_ANKLE], [R_HIP, R_KNEE, R_ANKLE]] as const) {
    extend(h, k, lengths.thigh, forward);
    // A foot below its knee comes back under the hip; a raised one follows the thigh out (a kick).
    const knee = joints[k], hip = joints[h], ankle = flat(a);
    const under = knee && hip && ankle && ankle[1] > knee[1] ? Math.sign(hip[2] - knee[2]) || forward : forward;
    extend(k, a, lengths.shin, under);
  }
  for (const [a, heel, toe] of [[L_ANKLE, L_HEEL, L_TOE], [R_ANKLE, R_HEEL, R_TOE]] as const) {
    const ankle = joints[a];
    if (!ankle) continue;
    const hp = flat(heel), tp = flat(toe);
    if (hp) joints[heel] = [hp[0], hp[1], ankle[2] - forward * lengths.foot * 0.15];
    if (tp) {
      const seen2d = hp ? Math.hypot(tp[0] - hp[0], tp[1] - hp[1]) : 0;
      joints[toe] = [tp[0], tp[1], (joints[heel]?.[2] ?? ankle[2]) + forward * Math.sqrt(Math.max(0, lengths.foot ** 2 - seen2d ** 2))];
    }
  }
  // Hands sit level with their wrists; the head with its shoulders, the nose out in front.
  for (const [w, ...fingers] of HAND) {
    const wz = joints[w]?.[2];
    if (wz === undefined) continue;
    for (const f of fingers) place(f, wz);
  }
  const shoulderZ = ((joints[L_SHOULDER]?.[2] ?? 0) + (joints[R_SHOULDER]?.[2] ?? 0)) / 2;
  for (let i = 1; i <= 10; i++) place(i, shoulderZ);
  place(0, shoulderZ + forward * lengths.shoulders * 0.25 * Math.abs(Math.cos(facing)));
  return { joints, facing };
}
