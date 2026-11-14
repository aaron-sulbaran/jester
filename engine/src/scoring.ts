// Small shared scoring helpers.

import { TIERS, TIMING } from "./constants.ts";
import type { Tier } from "./types.ts";

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 1 at or below `inner`, 0 at or above `outer`, 1 - x^2 in between (x is the position between them). */
export function falloff(value: number, inner: number, outer: number): number {
  if (value <= inner) return 1;
  if (value >= outer) return 0;
  const x = (value - inner) / (outer - inner);
  return 1 - x * x;
}

/** Timing credit from the player's lag in ms (positive = behind). Being early within the search range is fine. */
export function timingCredit(lagMs: number): number {
  return falloff(Math.max(0, lagMs), TIMING.freeMs, TIMING.zeroMs);
}

/** Map a raw 0..1 value to an integer 0..100 between a calibrated floor and ceiling. */
export function mapToScore(raw: number, floor: number, ceiling: number): number {
  return Math.round(100 * clamp01((raw - floor) / (ceiling - floor)));
}

export function tierFor(score: number): Tier {
  for (const t of TIERS) if (score >= t.min) return t.name;
  return "Miss";
}
