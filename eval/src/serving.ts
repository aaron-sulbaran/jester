// Serving variants: the different ways the game could turn a bank guide's raw pose timeline into the reference
// a player is scored against. "as-served" is what blind mode does today (steadyRole in app/src/blind.ts); the
// others are ideas to try. `npm run serve` replays real players' recordings against each one.

import { smoothTimeline, type PoseTimeline } from "../../engine/src/index.ts";
import type { RoundRecord } from "./record.ts";

export interface Variant {
  name: string;
  /** One line on what it changes, for the report. */
  about: string;
  serve(raw: PoseTimeline): PoseTimeline;
}

/**
 * Blind mode's steadyRole (app/src/blind.ts): every frame with no person filled with a straight line between
 * the poses either side (the nearest pose held at the ends), spikes removed and jitter softened. Kept in step
 * with blind.ts by hand; `npm run serve` checks it rebuilds the exact reference each recorded round was scored on.
 */
export function asServed(raw: PoseTimeline): PoseTimeline {
  return smoothTimeline(raw, { maxFill: Infinity, holdEnds: true });
}

/** Elbows, wrists, hand points, ankles and foot points (MediaPipe pose numbering): where real players lose most credit. */
export const LIMB_ENDS: ReadonlySet<number> = new Set([13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32]);

/** As served, then the joints in `joints` taken from a pass with Gaussian width `sigma` frames instead of 1.5 (smoother above, sharper below). */
export function steadier(raw: PoseTimeline, joints: ReadonlySet<number> | "all", sigma: number): PoseTimeline {
  const base = asServed(raw);
  const smooth = smoothTimeline(raw, { maxFill: Infinity, holdEnds: true, sigma });
  return {
    ...base,
    frames: base.frames.map((f, i) => {
      const other = smooth.frames[i]?.landmarks;
      if (!f.landmarks || !other) return f;
      return { ...f, landmarks: f.landmarks.map((p, k) => (joints === "all" || joints.has(k) ? other[k] ?? p : p)) };
    }),
  };
}

export const VARIANTS: readonly Variant[] = [
  { name: "as-served", about: "What blind mode does today: gaps filled, spikes removed, jitter softened (sigma 1.5 frames).", serve: asServed },
  { name: "steady-ends", about: "As served, with elbows, wrists, hands, ankles and feet smoothed twice as much (sigma 3).", serve: (raw) => steadier(raw, LIMB_ENDS, 3) },
  { name: "steady-ends-4", about: "As served, with elbows, wrists, hands, ankles and feet smoothed more still (sigma 4.5).", serve: (raw) => steadier(raw, LIMB_ENDS, 4.5) },
  { name: "sharp-ends", about: "As served, with elbows, wrists, hands, ankles and feet softened half as much (sigma 0.75), keeping fast hand moves.", serve: (raw) => steadier(raw, LIMB_ENDS, 0.75) },
  { name: "steady-all", about: "As served, with every joint smoothed twice as much (sigma 3), to compare with smoothing the ends only.", serve: (raw) => steadier(raw, "all", 3) },
];

export function variantNamed(name: string): Variant | null {
  return VARIANTS.find((v) => v.name === name) ?? null;
}

// ---- Which rounds count ----

/** A real player's lag when following a figure blind is well over 0.4 s; rounds below it scored a median of 36. */
export const HONEST_MIN_LAG_MS = 400;

/**
 * Whether a recorded round is an honest attempt on a bank clip, scored on the pose: tagged "nailed", or, until
 * enough rounds are tagged, an untagged round from a real camera whose recorded lag was at least
 * HONEST_MIN_LAG_MS (headless and simulated players lag a fixed 0.13 to 0.17 s and score near 100).
 */
export function honestRound(r: RoundRecord): "nailed" | "untagged" | null {
  if (r.channel !== "pose" || !r.clip.bankId || !r.device?.camera) return null;
  if (r.tag === "nailed") return "nailed";
  if (r.tag !== null) return null;
  const result = r.result as { score: number | null; lagMs?: number };
  return result.score !== null && (result.lagMs ?? 0) >= HONEST_MIN_LAG_MS ? "untagged" : null;
}

/** The limbs real players lose most credit on, in report order. */
export const WEAK_LIMBS = ["rightHand", "leftHand", "rightForearm", "leftForearm", "rightFoot", "leftFoot"] as const;

export function median(values: readonly number[]): number | null {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
