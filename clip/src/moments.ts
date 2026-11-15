import type { Landmarks, PoseTimeline } from "../../engine/src/index.ts";
import { motionPerFrame } from "./rank.ts";
import type { Pace, Track } from "./types.ts";

// Constants carried over unchanged from the spike's buildLevel; times are in milliseconds here.
const TARGET_MOMENTS = 8;
const MIN_MOMENTS = 4;
const MIN_SPACING_MS = 1200;
/** A kept pose must differ from the previously kept pose by at least this much (1 minus similarity). */
const MIN_POSE_DIFFERENCE = 0.06;
/** Candidates above this motion energy are moving, not held. */
const MAX_HOLD_ENERGY = 0.004;
const SMOOTHING_RADIUS = 3;
const CENTERING_RADIUS = 8;
const MINIMUM_RADIUS = 2;
const EARLIEST_MOMENT_MS = 500;

const SLOW_BELOW = 0.3;
const MEDIUM_BELOW = 1.0;

interface Sample { tMs: number; landmarks: NonNullable<Landmarks> }

// Pose similarity as the spike measured it: the cosine of each limb's direction, weighted by
// visibility. The engine's scorer has a dead zone and would blunt the hold limit above, so key
// moments keep the spike's measure.
const MIN_LIMB_VISIBILITY = 0.5;
const MIN_USED_LIMBS = 4;
const LANDMARK_INDEX = { leftShoulder: 11, rightShoulder: 12, leftElbow: 13, rightElbow: 14, leftWrist: 15, rightWrist: 16,
  leftHip: 23, rightHip: 24, leftKnee: 25, rightKnee: 26, leftAnkle: 27, rightAnkle: 28 } as const;
const L = LANDMARK_INDEX;
type PointSpec = number | readonly number[];
const LIMB_ENDS: readonly (readonly [PointSpec, PointSpec])[] = [
  [L.leftShoulder, L.leftElbow], [L.leftElbow, L.leftWrist],
  [L.rightShoulder, L.rightElbow], [L.rightElbow, L.rightWrist],
  [L.leftHip, L.leftKnee], [L.leftKnee, L.leftAnkle],
  [L.rightHip, L.rightKnee], [L.rightKnee, L.rightAnkle],
  [L.leftShoulder, L.rightShoulder], [L.leftHip, L.rightHip],
  [[L.leftHip, L.rightHip], [L.leftShoulder, L.rightShoulder]],
];

interface Direction { x: number; y: number; visibility: number }

function pointOf(pose: NonNullable<Landmarks>, spec: PointSpec, aspect: number): Direction {
  const indices = typeof spec === "number" ? [spec] : spec;
  let x = 0;
  let y = 0;
  let visibility = 1;
  for (const i of indices) {
    const lm = pose[i]!;
    x += lm[0];
    y += lm[1];
    visibility = Math.min(visibility, lm[2]);
  }
  // Both axes in image-height units.
  return { x: (x / indices.length) * aspect, y: y / indices.length, visibility };
}

function limbDirections(pose: NonNullable<Landmarks>, aspect: number): (Direction | null)[] {
  return LIMB_ENDS.map(([fromSpec, toSpec]) => {
    const from = pointOf(pose, fromSpec, aspect);
    const to = pointOf(pose, toSpec, aspect);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) return null;
    return { x: dx / length, y: dy / length, visibility: Math.min(from.visibility, to.visibility) };
  });
}

/** 1 minus the visibility-weighted similarity of two poses (same side, no mirroring); null when too few limbs are seen. */
function poseDifference(a: NonNullable<Landmarks>, b: NonNullable<Landmarks>, aspect: number): number | null {
  const aDirs = limbDirections(a, aspect);
  const bDirs = limbDirections(b, aspect);
  let weightedSum = 0;
  let weightTotal = 0;
  let used = 0;
  aDirs.forEach((ref, i) => {
    const other = bDirs[i];
    if (!ref || !other) return;
    const weight = Math.min(ref.visibility, other.visibility);
    if (weight < MIN_LIMB_VISIBILITY) return;
    weightedSum += ((ref.x * other.x + ref.y * other.y + 1) / 2) * weight;
    weightTotal += weight;
    used++;
  });
  return used < MIN_USED_LIMBS ? null : 1 - weightedSum / weightTotal;
}

/** How much limb directions changed since the previous sample; Infinity when the poses cannot be compared. */
function motionEnergy(samples: readonly Sample[], aspect: number): number[] {
  return samples.map((sample, i) => {
    if (i === 0) return 0;
    const difference = poseDifference(samples[i - 1]!.landmarks, sample.landmarks, aspect);
    return difference === null ? Infinity : difference;
  });
}

function windowMean(values: readonly number[], center: number, radius: number): number {
  let sum = 0;
  let count = 0;
  for (let j = Math.max(0, center - radius); j <= Math.min(values.length - 1, center + radius); j++) {
    sum += values[j]!;
    count++;
  }
  return sum / count;
}

function evenlySpaced(samples: readonly Sample[]): { tMs: number }[] {
  const usable = samples.filter((s) => s.tMs >= EARLIEST_MOMENT_MS);
  if (usable.length === 0) return [];
  const n = Math.min(TARGET_MOMENTS, usable.length);
  const moments: { tMs: number }[] = [];
  for (let k = 0; k < n; k++) moments.push({ tMs: usable[Math.floor(((k + 0.5) / n) * usable.length)]!.tMs });
  return moments;
}

/**
 * Key moments of a clip: poses that are briefly held and differ from the previous key moment.
 * Local minima of smoothed motion energy below the hold limit are candidates; the stillest are kept
 * at least 1.2 seconds apart, then a candidate that looks like the previous kept pose is dropped.
 * The 8 stillest remain. Fewer than 4 means falling back to evenly spaced moments.
 */
export function keyMoments(timeline: PoseTimeline): { tMs: number }[] {
  const aspect = timeline.source.width / timeline.source.height;
  const valid: Sample[] = [];
  for (const f of timeline.frames) if (f.landmarks) valid.push({ tMs: f.tMs, landmarks: f.landmarks });
  if (valid.length < 3) return evenlySpaced(valid);

  const energy = motionEnergy(valid, aspect);
  const shortEnergy = energy.map((_, i) => windowMean(energy, i, SMOOTHING_RADIUS));
  const rankEnergy = shortEnergy.map((e, i) => e + 0.5 * windowMean(energy, i, CENTERING_RADIUS));

  interface Candidate { index: number; tMs: number; rank: number }
  const candidates: Candidate[] = [];
  for (let i = 0; i < valid.length; i++) {
    if (valid[i]!.tMs < EARLIEST_MOMENT_MS || shortEnergy[i]! > MAX_HOLD_ENERGY) continue;
    let isMinimum = true;
    for (let j = Math.max(0, i - MINIMUM_RADIUS); j <= Math.min(valid.length - 1, i + MINIMUM_RADIUS); j++) {
      if (shortEnergy[j]! < shortEnergy[i]!) { isMinimum = false; break; }
    }
    if (isMinimum) candidates.push({ index: i, tMs: valid[i]!.tMs, rank: rankEnergy[i]! });
  }

  candidates.sort((a, b) => a.rank - b.rank || a.tMs - b.tMs);
  const spaced: Candidate[] = [];
  for (const c of candidates) {
    if (spaced.every((k) => Math.abs(k.tMs - c.tMs) >= MIN_SPACING_MS)) spaced.push(c);
  }

  spaced.sort((a, b) => a.tMs - b.tMs);
  const distinct: Candidate[] = [];
  for (const c of spaced) {
    const last = distinct[distinct.length - 1];
    if (!last) { distinct.push(c); continue; }
    const difference = poseDifference(valid[last.index]!.landmarks, valid[c.index]!.landmarks, aspect);
    if (difference !== null && difference >= MIN_POSE_DIFFERENCE) distinct.push(c);
    else if (c.rank < last.rank) distinct[distinct.length - 1] = c; // same hold, stiller sample
  }

  if (distinct.length < MIN_MOMENTS) return evenlySpaced(valid);
  return [...distinct]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, TARGET_MOMENTS)
    .sort((a, b) => a.tMs - b.tMs)
    .map((c) => ({ tMs: valid[c.index]!.tMs }));
}

/** How fast the subject moves, from landmark travel in box heights per second. */
export function paceOf(track: Track, sampleHz: number): Pace {
  const perSecond = motionPerFrame(track) * sampleHz;
  if (perSecond < SLOW_BELOW) return "slow";
  if (perSecond < MEDIUM_BELOW) return "medium";
  return "fast";
}
