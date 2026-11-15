// Pose channel: compare the player's limbs to the clip subject's limbs, frame by frame,
// at one global lag, and turn it into a round score. Pure functions only.

import { GRID_MS, LAG, MOTION, PLACEMENT, POSE, ROUND, SCORER_VERSION } from "./constants.ts";
import { scorePlacement } from "./placement.ts";
import { LIMBS, LIMB_NAMES, limbDirection, mirrorLandmarks, swapSide, type Direction } from "./geometry.ts";
import { gridLength, resamplePoses } from "./resample.ts";
import { clamp01, falloff, mapToScore, tierFor, timingCredit } from "./scoring.ts";
import type { Landmarks, LimbBreakdown, PoseRoundResult, PoseTimeline } from "./types.ts";

const RAD = 180 / Math.PI;
const LIMB_DEFS = LIMB_NAMES.map((n) => LIMBS[n]!);

/** Credit for one limb from its angle error: 1 inside the dead zone, 0 past the outer angle, 1 - x^2 between. */
export function limbCredit(thetaDeg: number): number {
  return falloff(thetaDeg, POSE.thetaInDeg, POSE.thetaOutDeg);
}

function angleDeg(a: Direction, b: Direction): number {
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y));
  return Math.acos(dot) * RAD;
}

type Dirs = (Direction | null)[]; // one entry per limb, in LIMB_NAMES order

function directions(lms: Landmarks, aspect: number): Dirs | null {
  if (!lms) return null;
  return LIMB_DEFS.map((d) => limbDirection(lms, d, aspect));
}

export interface LimbComparison {
  limb: string;
  credit: number;
  errorDeg: number;
  /** Player direction y minus reference direction y: positive means the player's limb points lower. */
  verticalDelta: number;
  weight: number;
  /** True when the clip shows and moves this limb but the player's was out of view (counted as a miss). */
  unseen?: boolean;
}

export interface PoseComparison {
  /** Weighted mean limb credit 0..1, or null when too little of the body is visible on both sides. */
  credit: number | null;
  limbs: LimbComparison[];
}

/**
 * Compare two sets of limb directions. `multipliers` scales each limb's base weight (motion weighting);
 * pass undefined for plain weights.
 */
function compareDirs(ref: Dirs, player: Dirs, multipliers?: readonly number[], penalizeUnseen = false): PoseComparison {
  let sum = 0, covered = 0, total = 0;
  const limbs: LimbComparison[] = [];
  for (let b = 0; b < LIMB_DEFS.length; b++) {
    const mult = multipliers?.[b] ?? 1;
    const base = LIMB_DEFS[b]!.weight * mult;
    total += base;
    const r = ref[b], p = player[b];
    if (!r || r.visibility < POSE.minVisibility) continue;
    if (!p || p.visibility < POSE.minVisibility) {
      // The clip shows this limb but the camera cannot see the player's. If the clip's limb is doing
      // anything (moving, or held away from how it hangs when standing, like a held squat), count a miss:
      // hiding your legs must not hide leg mistakes. A limb the clip leaves at rest costs nothing, since
      // laptop cameras often cut off legs.
      if (!penalizeUnseen || !multipliers || LIMB_DEFS[b]!.ignoreUnseen) continue;
      const active = limbActivity(r, b, mult);
      // Full limb weight, not the motion-scaled `base`: a held squat is still, but it is the whole point.
      const w = LIMB_DEFS[b]!.weight * active * r.visibility;
      if (w <= 0) continue;
      limbs.push({ limb: LIMB_NAMES[b]!, credit: 0, errorDeg: 0, verticalDelta: 0, weight: w, unseen: true });
      continue;
    }
    const vis = Math.min(r.visibility, p.visibility);
    const w = base * vis;
    const errorDeg = angleDeg(r, p);
    const credit = limbCredit(errorDeg);
    sum += w * credit;
    covered += base;
    limbs.push({ limb: LIMB_NAMES[b]!, credit, errorDeg, verticalDelta: p.y - r.y, weight: w });
  }
  if (total <= 0 || covered < POSE.minCoveredWeightShare * total) return { credit: null, limbs };
  let wsum = 0;
  for (const l of limbs) wsum += l.weight;
  return { credit: wsum > 0 ? sum / wsum : null, limbs };
}

/**
 * How much the clip is using limb b in this frame, 0..1: moving it (from the motion multiplier, scaled by
 * POSE.unseenPenalty) or holding it away from how it hangs when standing (60 degrees or more counts fully).
 */
function limbActivity(r: Direction, b: number, mult: number): number {
  const motionBase = POSE.motionWeightBase;
  const moving = motionBase < 1 ? Math.max(0, (mult - motionBase) / (1 - motionBase)) : 0;
  const posed = 1 - limbCredit(angleDeg(r, STILL_DIRS[b]!));
  return Math.min(1, Math.max(moving * POSE.unseenPenalty, posed));
}

export interface CompareOptions {
  referenceAspect?: number;
  playerAspect?: number;
  /** Apply the mirror rule to the player (default true: the player faces the screen like a mirror). */
  mirror?: boolean;
}

/**
 * Compare a single reference pose with a single player pose. Use this for live feedback
 * (limb colors, a running meter). The authoritative score comes from scorePoseRound.
 */
export function comparePoses(reference: Landmarks, player: Landmarks, options: CompareOptions = {}): PoseComparison {
  const { referenceAspect = 1, playerAspect = 1, mirror = true } = options;
  const p = player && mirror ? mirrorLandmarks(player) : player;
  const rd = directions(reference, referenceAspect);
  const pd = directions(p, playerAspect);
  if (!rd || !pd) return { credit: null, limbs: [] };
  return compareDirs(rd, pd);
}

/**
 * Per frame and limb, how much the reference limb is moving around that moment, as a weight
 * multiplier in [motionWeightBase, 1]. Moving limbs matter more, so standing still cannot farm
 * credit from limbs the performer never moves.
 */
export function motionMultipliers(refDirs: (Dirs | null)[]): number[][] {
  const n = refDirs.length, L = LIMB_DEFS.length, W = POSE.motionWindowFrames;
  // Angle change per frame per limb.
  const change: number[][] = Array.from({ length: n }, () => new Array(L).fill(0));
  for (let i = 1; i < n; i++) {
    const a = refDirs[i - 1], b = refDirs[i];
    if (!a || !b) continue;
    for (let k = 0; k < L; k++) {
      const da = a[k], db = b[k];
      if (da && db) change[i]![k] = angleDeg(da, db);
    }
  }
  // Prefix sums for windowed means.
  const prefix: number[][] = Array.from({ length: n + 1 }, () => new Array(L).fill(0));
  for (let i = 0; i < n; i++) for (let k = 0; k < L; k++) prefix[i + 1]![k] = prefix[i]![k]! + change[i]![k]!;
  const motion: number[][] = Array.from({ length: n }, () => new Array(L).fill(0));
  let max = 0;
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - W), hi = Math.min(n, i + W + 1);
    for (let k = 0; k < L; k++) {
      const m = (prefix[hi]![k]! - prefix[lo]![k]!) / (hi - lo);
      motion[i]![k] = m;
      if (m > max) max = m;
    }
  }
  const base = POSE.motionWeightBase;
  return motion.map((row) => row.map((m) => (max > 0 ? base + (1 - base) * (m / max) : 1)));
}

/**
 * Limb directions of a person standing still, arms and legs hanging down, facing the camera.
 * Used as the "do nothing" baseline: the round only rewards accuracy above what this pose earns.
 * Order matches LIMB_NAMES. Shoulder and hip lines run from the figure's left (image right) to its right.
 */
const STILL_DIRS: Dirs = LIMB_NAMES.map((name) => {
  if (name === "shoulderLine" || name === "hipLine") return { x: -1, y: 0, visibility: 1 };
  if (name === "torso" || name === "neck") return { x: 0, y: -1, visibility: 1 };
  return { x: 0, y: 1, visibility: 1 };
});

/** How a limb's direction changes over MOTION.spanMs: the difference of two unit vectors. */
export interface Turn { x: number; y: number }

/**
 * Per frame and limb, the limb's turn from frame i to i + MOTION.spanMs, measured on directions smoothed over
 * MOTION.smoothFrames. null where the limb is not visible at both ends. Used to tell a player who moves like
 * the clip from one standing still: see the moving credit in scorePoseRound.
 */
export function limbTurns(dirs: (Dirs | null)[]): (Turn | null)[][] {
  const n = dirs.length, L = LIMB_DEFS.length, half = Math.floor(MOTION.smoothFrames / 2);
  const span = Math.max(1, Math.round(MOTION.spanMs / GRID_MS));
  const seen = (d: Direction | null | undefined): d is Direction => !!d && d.visibility >= POSE.minVisibility;
  const smooth: (Turn | null)[][] = Array.from({ length: n }, () => new Array(L).fill(null));
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < L; k++) {
      if (!seen(dirs[i]?.[k])) continue;
      let x = 0, y = 0;
      for (let d = -half; d <= half; d++) {
        const v = dirs[i + d]?.[k];
        if (seen(v)) { x += v.x; y += v.y; }
      }
      const len = Math.hypot(x, y);
      if (len > 1e-9) smooth[i]![k] = { x: x / len, y: y / len };
    }
  }
  const out: (Turn | null)[][] = Array.from({ length: n }, () => new Array(L).fill(null));
  for (let i = 0; i + span < n; i++) {
    for (let k = 0; k < L; k++) {
      const a = smooth[i]![k], b = smooth[i + span]![k];
      if (a && b) out[i]![k] = { x: b.x - a.x, y: b.y - a.y };
    }
  }
  return out;
}

/**
 * Motion share 0..1: how much of the clip's limb motion the player reproduces. For every matched frame and
 * limb where the clip turns by more than MOTION.noiseFloorDeg, the player's turn is projected on the clip's
 * turn. Per limb, the projections are summed over the round and kept between 0 and the clip's own summed turn
 * size for that limb; share = weighted sum of those / weighted sum of the clip's turn sizes.
 * A still body earns 0. Tracker jitter averages out to about 0, because its projection is as often negative
 * as positive and the sum is only capped per limb over the whole round (a cap per frame would bias noisy
 * genuine copies toward 0). Moving the wrong way counts against, and moving one limb more than the clip
 * earns no more than matching it, so it cannot stand in for another limb. Limbs are weighted by their LIMBS
 * weight, so a new limb joins without retuning.
 */
export function motionShare(refTurns: (Turn | null)[][], playerTurns: (Turn | null)[][], frameMatch: readonly number[], valid: readonly boolean[]): number {
  const minChord = 2 * Math.sin((MOTION.noiseFloorDeg * Math.PI) / 360);
  const L = LIMB_DEFS.length;
  const refSum = new Array<number>(L).fill(0), projSum = new Array<number>(L).fill(0);
  for (let i = 0; i < frameMatch.length; i++) {
    const j = frameMatch[i]!;
    if (j < 0 || !valid[i]) continue;
    for (let b = 0; b < L; b++) {
      const r = refTurns[j]?.[b];
      if (!r) continue;
      const size = Math.hypot(r.x, r.y);
      if (size < minChord) continue;
      const p = playerTurns[i]?.[b];
      // A limb the camera cannot see that is allowed to be unseen (feet) neither helps nor hurts.
      // Any other unseen limb counts as not moving.
      if (!p && LIMB_DEFS[b]!.ignoreUnseen) continue;
      refSum[b]! += size;
      if (p) projSum[b]! += (p.x * r.x + p.y * r.y) / size;
    }
  }
  let total = 0, matched = 0;
  for (let b = 0; b < L; b++) {
    const w = LIMB_DEFS[b]!.weight;
    total += w * refSum[b]!;
    matched += w * Math.max(0, Math.min(refSum[b]!, projSum[b]!));
  }
  return total > 1e-9 ? clamp01(matched / total) : 0;
}

/**
 * Moved share 0..1 (0.10.0): whether the player moved at all, in or out of time and in any direction, as a
 * share of how much the clip moves. Unlike motionShare there is no projection: a blind player's moves are
 * often late or loose, so they barely project on the clip's turns, but they are still moves. Each turn counts
 * its size less MOTION.movedFloorDeg, on both sides, so tracker jitter, breathing and sway on a body standing
 * still count about 0 and an exact copy counts 1. Per limb, the player's sum over the round is capped at the
 * clip's sum over the same frames, so moving a limb the clip holds still (the other arm, say) or fidgeting
 * one limb a lot cannot stand in for the limbs the clip moves. Limbs are weighted by their LIMBS weight.
 * A body held still earns 0, whatever pose it holds. 1 when the clip itself never moves.
 */
export function movedShare(refTurns: (Turn | null)[][], playerTurns: (Turn | null)[][], frameMatch: readonly number[], valid: readonly boolean[]): number {
  const floor = 2 * Math.sin((MOTION.movedFloorDeg * Math.PI) / 360);
  const over = (t: Turn | null | undefined): number => (t ? Math.max(0, Math.hypot(t.x, t.y) - floor) : 0);
  const L = LIMB_DEFS.length;
  const refSum = new Array<number>(L).fill(0), moveSum = new Array<number>(L).fill(0);
  for (let i = 0; i < frameMatch.length; i++) {
    const j = frameMatch[i]!;
    if (j < 0 || !valid[i]) continue;
    for (let b = 0; b < L; b++) {
      refSum[b]! += over(refTurns[j]?.[b]);
      moveSum[b]! += over(playerTurns[i]?.[b]);
    }
  }
  let total = 0, moved = 0;
  for (let b = 0; b < L; b++) {
    const w = LIMB_DEFS[b]!.weight;
    total += w * refSum[b]!;
    moved += w * Math.min(refSum[b]!, moveSum[b]!);
  }
  // A clip that never moves leaves nothing to tell a mover from a statue: count the player as moved.
  return total > 1e-9 ? clamp01(moved / total) : 1;
}

export interface PoseRoundOptions {
  /** Apply the mirror rule to the player (default true). Ignored when the player's frames were already flipped. */
  mirror?: boolean;
}

/**
 * Score a whole round. Inputs are the clip subject's timeline and the player's timeline, both on
 * the clip's clock. The result depends only on these inputs and the constants: run it twice, get
 * the same result.
 */
export function scorePoseRound(reference: PoseTimeline, player: PoseTimeline, options: PoseRoundOptions = {}): PoseRoundResult {
  const lastRef = reference.frames.reduce((m, f) => (Number.isFinite(f.tMs) && f.tMs > m ? f.tMs : m), -1);
  const n = gridLength(lastRef);
  const refAspect = reference.source.width / reference.source.height;
  const playerAspect = player.source.width / player.source.height;
  const applyMirror = (options.mirror ?? true) && !player.source.mirrored;
  // The player's own side is opposite to the reference's whenever the player copies as a mirror image.
  const mirrorView = options.mirror ?? true;

  const refGrid = resamplePoses(reference.frames, n);
  const playerGrid = resamplePoses(player.frames, n).map((l) => (l && applyMirror ? mirrorLandmarks(l) : l));
  const refDirs = refGrid.map((l) => directions(l, refAspect));
  const playerDirs = playerGrid.map((l) => directions(l, playerAspect));
  const mult = motionMultipliers(refDirs);

  const empty = (failure: PoseRoundResult["failure"]): PoseRoundResult => ({
    channel: "pose", scorerVersion: SCORER_VERSION, score: null, tier: null, failure,
    accuracy: 0, stillBaseline: 0, motion: { share: 0, gate: 0, credit: 0, moved: 0, stillGate: 0, gainOverStill: 0, gain: 0 }, timing: 0, lagMs: 0, validShare: 0, perLimb: {}, worstLimb: null, hiddenLimbs: [], frameCredits: new Array(n).fill(null),
    placement: { used: false, credit: 0, stillBaseline: 0, gain: 0, worst: null, outlineFit: null, outlineHints: { distance: null, side: null } },
  });
  if (n === 0 || refDirs.every((d) => d === null)) return empty("no-reference");

  // Frame credit for player frame i against reference frame j, memoized per (i, j - i).
  const cache = new Map<number, number | null>();
  const span = Math.round((LAG.maxMs - LAG.minMs) / GRID_MS) + 2 * LAG.slackFrames + 1;
  const pairCredit = (i: number, j: number): number | null => {
    if (j < 0 || j >= n) return null;
    const key = i * span + (j - i + Math.round(LAG.maxMs / GRID_MS) + LAG.slackFrames);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const rd = refDirs[j], pd = playerDirs[i];
    const c = rd && pd ? compareDirs(rd, pd, mult[j], true).credit : null;
    cache.set(key, c);
    return c;
  };

  // 1. Global lag: the shift with the best mean credit. Positive lag = player behind the clip,
  //    so player frame i is compared with reference frame i - lag.
  const minLag = Math.round(LAG.minMs / GRID_MS);
  const maxLag = Math.round(LAG.maxMs / GRID_MS);
  const lagStats: { lag: number; mean: number; count: number }[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0, count = 0;
    for (let i = 0; i < n; i++) {
      const c = pairCredit(i, i - lag);
      if (c !== null) { sum += c; count++; }
    }
    lagStats.push({ lag, mean: count > 0 ? sum / count : -1, count });
  }
  const maxCount = lagStats.reduce((m, s) => Math.max(m, s.count), 0);
  if (maxCount === 0) return empty("low-tracking");
  let best = lagStats[0]!;
  for (const s of lagStats) {
    // Ignore shifts that see far fewer frames (edge effects), then prefer higher mean,
    // then the smaller absolute lag, then the smaller lag. Fully deterministic.
    if (s.count < 0.5 * maxCount) continue;
    if (best.count < 0.5 * maxCount) { best = s; continue; }
    if (s.mean > best.mean + 1e-12) best = s;
    else if (Math.abs(s.mean - best.mean) <= 1e-12) {
      if (Math.abs(s.lag) < Math.abs(best.lag) || (Math.abs(s.lag) === Math.abs(best.lag) && s.lag < best.lag)) best = s;
    }
  }
  const lag = best.lag;

  // 2. Per frame: best credit within the slack around the global lag.
  const frameCredits: (number | null)[] = new Array(n).fill(null);
  const frameMatch: number[] = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let bestC: number | null = null, bestJ = -1, bestD = Infinity;
    for (let d = -LAG.slackFrames; d <= LAG.slackFrames; d++) {
      const j = i - lag + d;
      const c = pairCredit(i, j);
      if (c === null) continue;
      if (bestC === null || c > bestC + 1e-12 || (Math.abs(c - bestC) <= 1e-12 && Math.abs(d) < bestD)) {
        bestC = c; bestJ = j; bestD = Math.abs(d);
      }
    }
    frameCredits[i] = bestC;
    frameMatch[i] = bestJ;
  }

  // Frames the reference itself cannot be scored on (no subject) are not the player's fault.
  let refScorable = 0, valid = 0, sum = 0, stillSum = 0;
  for (let i = 0; i < n; i++) {
    const j = i - lag;
    const refOk = j >= 0 && j < n && refDirs[j] !== null;
    if (refOk) refScorable++;
    const c = frameCredits[i];
    if (c !== null && c !== undefined) {
      valid++; sum += c;
      // What standing still would have earned on the same reference frame.
      stillSum += compareDirs(refDirs[frameMatch[i]!]!, STILL_DIRS, mult[frameMatch[i]!]).credit ?? 0;
    }
  }
  const validShare = refScorable > 0 ? valid / refScorable : 0;
  const accuracy = valid > 0 ? sum / valid : 0;
  const stillBaseline = valid > 0 ? stillSum / valid : 0;
  const headroom = 1 - stillBaseline;
  const gainOverStill = headroom >= ROUND.minHeadroom ? clamp01((accuracy - stillBaseline) / headroom) : accuracy;

  // 2b. Moving credit (0.9.0): absolute accuracy, unlocked by moving like the clip.
  //     A clip that never moves leaves nothing to tell a copier from a statue: the share is 0.
  const refTurns = limbTurns(refDirs), playerTurns = limbTurns(playerDirs);
  const validFrames = frameCredits.map((c) => c !== null);
  const share = motionShare(refTurns, playerTurns, frameMatch, validFrames);
  const gate = clamp01((share - MOTION.gateLow) / (MOTION.gateHigh - MOTION.gateLow));
  const absoluteCredit = clamp01((accuracy - MOTION.accuracyFloor) / (MOTION.accuracyFull - MOTION.accuracyFloor));
  // 2c. Still gate (0.10.0): the gain over the fixed arms-down pose counts only as far as the player moved at
  //     all. On a clip that mostly stands, a player's own standing pose beats the fixed pose by a lot, so
  //     without this a statue scored up to 66. A clip that never moves cannot tell them apart: moved is 1.
  const moved = movedShare(refTurns, playerTurns, frameMatch, validFrames);
  const stillGate = clamp01((moved - MOTION.movedLow) / (MOTION.movedHigh - MOTION.movedLow));
  const gain = Math.max(stillGate * gainOverStill, gate * absoluteCredit);
  const lagMs = Math.round(lag * GRID_MS);
  const timing = timingCredit(lagMs);

  // 3. Per-limb breakdown at the matched frames.
  const acc: Record<string, { credit: number; err: number; vert: number; frames: number; seen: number; unseen: number; loss: number; unseenLoss: number }> = {};
  for (const name of LIMB_NAMES) acc[name] = { credit: 0, err: 0, vert: 0, frames: 0, seen: 0, unseen: 0, loss: 0, unseenLoss: 0 };
  for (let i = 0; i < n; i++) {
    const j = frameMatch[i]!;
    if (j < 0 || frameCredits[i] === null) continue;
    const cmp = compareDirs(refDirs[j]!, playerDirs[i]!, mult[j], true);
    for (const l of cmp.limbs) {
      const a = acc[l.limb]!;
      a.credit += l.credit; a.frames++;
      a.loss += l.weight * (1 - l.credit);
      if (l.unseen) { a.unseen++; a.unseenLoss += l.weight; }
      else { a.err += l.errorDeg; a.vert += l.verticalDelta; a.seen++; }
    }
  }
  const perLimb: Record<string, LimbBreakdown> = {};
  let worst: { limb: string; loss: number } | null = null;
  for (const name of LIMB_NAMES) {
    const a = acc[name]!;
    if (a.frames === 0) continue;
    const meanVert = a.seen > 0 ? a.vert / a.seen : 0;
    perLimb[name] = {
      credit: a.credit / a.frames,
      meanErrorDeg: a.seen > 0 ? a.err / a.seen : 0,
      // Mostly out of view: say so, since "too low" or "wrong angle" would be a guess.
      direction: a.unseenLoss > 0.5 * a.loss ? "unseen" : meanVert > 0.25 ? "low" : meanVert < -0.25 ? "high" : "angle",
      framesSeen: a.seen,
      unseenShare: a.unseen / a.frames,
    };
    if (a.loss > 0 && (!worst || a.loss > worst.loss + 1e-12)) worst = { limb: name, loss: a.loss };
  }
  const worstLimb = worst
    ? {
        limb: worst.limb,
        label: mirrorView ? swapSide(LIMBS[worst.limb]!.label) : LIMBS[worst.limb]!.label,
        direction: perLimb[worst.limb]!.direction,
      }
    : null;

  // 4. Hidden cap: a major limb (weight 1 or more) the clip uses in a fair share of the round, but the
  //    camera could not see on the player for most of that time. The per-frame miss alone lets perfect
  //    arms carry a seated player to "Great" on a clip with a few squats; this caps the round instead.
  const used = new Array(LIMB_DEFS.length).fill(0), hiddenWhileUsed = new Array(LIMB_DEFS.length).fill(0);
  for (let i = 0; i < n; i++) {
    const j = frameMatch[i]!;
    if (j < 0 || frameCredits[i] === null) continue;
    const rd = refDirs[j]!, pd = playerDirs[i]!;
    for (let b = 0; b < LIMB_DEFS.length; b++) {
      const r = rd[b];
      if (!r || r.visibility < POSE.minVisibility || limbActivity(r, b, mult[j]![b]!) < POSE.hiddenActiveMin) continue;
      used[b]++;
      const p = pd[b];
      if (!p || p.visibility < POSE.minVisibility) hiddenWhileUsed[b]++;
    }
  }
  const hiddenLimbs = LIMB_NAMES.filter((_, b) =>
    LIMB_DEFS[b]!.weight >= 1 && !LIMB_DEFS[b]!.ignoreUnseen &&
    used[b] >= POSE.hiddenUsedMinShare * valid && used[b] > 0 && hiddenWhileUsed[b] / used[b] >= POSE.hiddenCapShare);

  const failed = valid === 0 || 1 - validShare > POSE.maxInvalidShare;
  // 5. Placement: relative moves count PLACEMENT.weight of the gain when the clip travels; outline fit is reported only.
  const placement = scorePlacement(refGrid, playerGrid, frameMatch.map((j, i) => (frameCredits[i] === null ? -1 : j)), refAspect, playerAspect);
  const combinedGain = placement.used ? (1 - PLACEMENT.weight) * gain + PLACEMENT.weight * placement.gain : gain;
  const raw = combinedGain * (ROUND.accuracyWeight + (1 - ROUND.accuracyWeight) * timing);
  const uncapped = failed ? null : mapToScore(raw, ROUND.floor, ROUND.ceiling);
  const score = uncapped !== null && hiddenLimbs.length > 0 ? Math.min(uncapped, ROUND.hiddenCap) : uncapped;
  return {
    channel: "pose",
    scorerVersion: SCORER_VERSION,
    score,
    tier: score === null ? null : tierFor(score),
    failure: failed ? "low-tracking" : null,
    accuracy: clamp01(accuracy),
    stillBaseline,
    motion: { share, gate, credit: absoluteCredit, moved, stillGate, gainOverStill, gain },
    timing,
    lagMs,
    validShare,
    perLimb,
    worstLimb,
    hiddenLimbs,
    placement,
    frameCredits,
  };
}
