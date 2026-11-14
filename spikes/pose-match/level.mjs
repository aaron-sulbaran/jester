// Turn a pose timeline [{t, landmarks}] into a level: a short list of key moments.
// Pure functions, no DOM.
import { comparePoses } from "./score.mjs";

// ---- Tunable constants ----
export const TARGET_MOMENTS = 8;
export const MIN_MOMENTS = 4;
export const MIN_SPACING_SECONDS = 1.2;
// A kept pose must differ from the previously kept pose by at least this much (1 - similarity).
export const MIN_POSE_DIFFERENCE = 0.06;
// Candidates above this motion energy are "moving", not "held".
export const MAX_HOLD_ENERGY = 0.004;
export const SMOOTHING_RADIUS = 3; // samples on each side, short window
export const CENTERING_RADIUS = 8; // samples on each side, prefers the middle of a hold
export const MINIMUM_RADIUS = 2; // a local minimum is lowest within this many samples
export const EARLIEST_MOMENT_SECONDS = 0.5; // leave room for the scoring window

export function poseDifference(a, b, aspect = 1) {
  const result = comparePoses(a, b, { mirror: false, referenceAspect: aspect, playerAspect: aspect });
  return result.score == null ? null : 1 - result.score;
}

// Motion energy at sample i: how much limb directions changed since sample i - 1.
export function motionEnergy(timeline, aspect = 1) {
  return timeline.map((sample, i) => {
    if (i === 0) return 0;
    const difference = poseDifference(timeline[i - 1].landmarks, sample.landmarks, aspect);
    return difference == null ? Infinity : difference;
  });
}

function windowMean(values, center, radius) {
  let sum = 0, count = 0;
  for (let j = Math.max(0, center - radius); j <= Math.min(values.length - 1, center + radius); j++) {
    sum += values[j]; count++;
  }
  return sum / count;
}

export function evenlySpacedMoments(timeline, count = TARGET_MOMENTS) {
  const usable = timeline.filter((s) => s.landmarks && s.t >= EARLIEST_MOMENT_SECONDS);
  if (usable.length === 0) return [];
  const n = Math.min(count, usable.length);
  const moments = [];
  for (let k = 0; k < n; k++) moments.push(usable[Math.floor(((k + 0.5) / n) * usable.length)]);
  return moments.map((s) => ({ t: s.t, landmarks: s.landmarks }));
}

/**
 * Pick key moments: poses that are briefly held and differ from the previous key moment.
 * 1. Motion energy per sample, smoothed; local minima below MAX_HOLD_ENERGY are candidates.
 * 2. Lowest energy first, keep candidates at least MIN_SPACING_SECONDS from all kept ones.
 * 3. In time order, drop a candidate that looks like the last kept pose.
 * 4. Keep the TARGET_MOMENTS stillest; fall back to even spacing if fewer than MIN_MOMENTS.
 * Returns {moments, usedFallback}.
 */
export function buildLevel(timeline, { aspect = 1 } = {}) {
  const valid = timeline.filter((s) => s.landmarks);
  if (valid.length < 3) return { moments: evenlySpacedMoments(valid), usedFallback: true };
  const energy = motionEnergy(valid, aspect);
  const shortEnergy = energy.map((_, i) => windowMean(energy, i, SMOOTHING_RADIUS));
  const rankEnergy = shortEnergy.map((e, i) => e + 0.5 * windowMean(energy, i, CENTERING_RADIUS));

  const candidates = [];
  for (let i = 0; i < valid.length; i++) {
    if (valid[i].t < EARLIEST_MOMENT_SECONDS || shortEnergy[i] > MAX_HOLD_ENERGY) continue;
    let isMinimum = true;
    for (let j = Math.max(0, i - MINIMUM_RADIUS); j <= Math.min(valid.length - 1, i + MINIMUM_RADIUS); j++) {
      if (shortEnergy[j] < shortEnergy[i]) { isMinimum = false; break; }
    }
    if (isMinimum) candidates.push({ index: i, t: valid[i].t, rank: rankEnergy[i] });
  }

  candidates.sort((a, b) => a.rank - b.rank || a.t - b.t);
  const spaced = [];
  for (const c of candidates) {
    if (spaced.every((k) => Math.abs(k.t - c.t) >= MIN_SPACING_SECONDS)) spaced.push(c);
  }

  spaced.sort((a, b) => a.t - b.t);
  const distinct = [];
  for (const c of spaced) {
    const last = distinct[distinct.length - 1];
    if (!last) { distinct.push(c); continue; }
    const difference = poseDifference(valid[last.index].landmarks, valid[c.index].landmarks, aspect);
    if (difference != null && difference >= MIN_POSE_DIFFERENCE) distinct.push(c);
    else if (c.rank < last.rank) distinct[distinct.length - 1] = c; // same hold, stiller sample
  }

  if (distinct.length < MIN_MOMENTS) return { moments: evenlySpacedMoments(valid), usedFallback: true };
  const chosen = [...distinct].sort((a, b) => a.rank - b.rank).slice(0, TARGET_MOMENTS).sort((a, b) => a.t - b.t);
  return { moments: chosen.map((c) => ({ t: valid[c.index].t, landmarks: valid[c.index].landmarks })), usedFallback: false };
}
