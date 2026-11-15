// Serving variants: the different ways the game could turn a bank guide's raw pose timeline into the reference
// a player is scored against. "as-served" is what blind mode does today (steadyRole in app/src/blind.ts); the
// others are ideas to try. `npm run serve` replays real players' recordings against each one.

import { LIMBS, smoothTimeline, type PoseTimeline } from "../../engine/src/index.ts";
import { setConstant } from "./judge.ts";
import type { RoundRecord } from "./record.ts";

type Result<T> = { data: T; error: null } | { data: null; error: string };

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

// ---- Engine what-ifs ----
//
// Settings the engine could use instead of today's, tried for this run only (nothing in engine/ changes; the
// engine is Alex's). "GROUP.name=value" is a number in engine/src/constants.ts, as in `npm run eval -- --what-if`.
// "LIMB.<limb or group>=value" is a limb's weight in engine/src/geometry.ts (groups: hands, forearms, feet).

export interface WhatIf {
  name: string;
  /** One line on what it changes, for the report. */
  about: string;
  settings: readonly string[];
}

const LIMB_GROUPS: Readonly<Record<string, readonly string[]>> = {
  hands: ["leftHand", "rightHand"],
  forearms: ["leftForearm", "rightForearm"],
  feet: ["leftFoot", "rightFoot"],
};

/** Applies "GROUP.name=value" and "LIMB.<limb or group>=value" settings. Returns a function that puts them all back. */
export function applySettings(settings: readonly string[]): Result<() => void> {
  const undo: (() => void)[] = [];
  const restore = () => { for (const u of undo.reverse()) u(); };
  for (const setting of settings) {
    const [path, text] = setting.split("=");
    const value = Number(text);
    if (!path || text === undefined || !Number.isFinite(value)) {
      restore();
      return { data: null, error: `"${setting}" is not GROUP.name=number or LIMB.name=number` };
    }
    if (path.startsWith("LIMB.")) {
      const key = path.slice("LIMB.".length);
      const names = LIMB_GROUPS[key] ?? [key];
      const limbs = LIMBS as Record<string, { weight: number } | undefined>;
      if (names.some((n) => !limbs[n])) {
        restore();
        return { data: null, error: `${key} is not a limb (${Object.keys(LIMBS).join(", ")}) or a group (${Object.keys(LIMB_GROUPS).join(", ")})` };
      }
      for (const n of names) {
        const limb = limbs[n]!;
        const old = limb.weight;
        limb.weight = value;
        undo.push(() => { limb.weight = old; });
      }
      continue;
    }
    const set = setConstant(path, value);
    if (set.error !== null) { restore(); return { data: null, error: set.error }; }
    const old = set.data;
    undo.push(() => { setConstant(path, old); });
  }
  return { data: restore, error: null };
}

export const WHAT_IFS: readonly WhatIf[] = [
  { name: "today", about: "The engine as it is (0.12.0).", settings: [] },
  { name: "angles-20", about: "Full credit for a limb within 20 degrees of the clip instead of 15.", settings: ["POSE.thetaInDeg=20"] },
  { name: "angles-20-75", about: "Full credit within 20 degrees and none only past 75 instead of 60.", settings: ["POSE.thetaInDeg=20", "POSE.thetaOutDeg=75"] },
  { name: "hands-light", about: "Hands count half as much (weight 0.25 instead of 0.5).", settings: ["LIMB.hands=0.25"] },
  { name: "hands-off", about: "Hands not scored at all.", settings: ["LIMB.hands=0"] },
  { name: "forearms-light", about: "Forearms count like thighs (weight 1 instead of 1.5).", settings: ["LIMB.forearms=1"] },
  { name: "ends-light", about: "Hands half, forearms like thighs.", settings: ["LIMB.hands=0.25", "LIMB.forearms=1"] },
  { name: "credit-from-0.5", about: "Accuracy starts earning at 0.5 instead of 0.55 (a gentler score curve).", settings: ["MOTION.accuracyFloor=0.5"] },
  { name: "ceiling-0.95", about: "Accuracy 0.95 maps to 100 instead of 1.0 (the calibration constants.ts expects).", settings: ["MOTION.accuracyFull=0.95"] },
  { name: "late-ok-900", about: "Full timing credit up to 900 ms late instead of 650 (blind players lag 0.5 to 1.2 s).", settings: ["TIMING.freeMs=900"] },
];

export function whatIfNamed(name: string): WhatIf | null {
  return WHAT_IFS.find((w) => w.name === name) ?? null;
}
