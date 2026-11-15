// Keeps each person on their own track when people overlap or cross. The pose model gives no
// identities, and linking goes by box overlap, so when two dancers cross a track can pick up the
// other dancer's skeleton and the stick figure jumps from one person to the other. The whole clip
// is known in advance, so this looks at every frame, before and after a crossing, and:
//
// 1. Swap repair: each person has a body shape that stays the same through the clip (limb lengths
//    over torso length). For each pair of tracks that come close, it picks, frame by frame, whether
//    the two tracks' points belong to them as linked or the other way round, so that each person's
//    points fit their own body shape and move smoothly. It changes nothing unless the swapped
//    reading is clearly better.
// 2. Jump drop: a track whose whole skeleton leaps in one step while someone else is close, and
//    leaps back soon after, was given the other person's pose for those frames. Those frames become
//    gaps, which is better than a wrong figure.
//
// Pure and deterministic: same tracks in, same tracks out.

import type { Landmark } from "../../engine/src/index.ts";
import type { Box, Track, TrackPoint } from "./types.ts";

export interface IdentityOptions {
  /** Frame width over height, so sideways distances are measured like upright ones. */
  aspect?: number;
}

export interface IdentityResult {
  tracks: Track[];
  /** Stretches of frames where two tracks' points were swapped back to their own person. */
  swaps: number;
  /** Points moved to the other track by those swaps (each frame of a swap moves up to two). */
  swappedPoints: number;
  /** Points removed because they were someone else's pose. */
  dropped: number;
}

// Landmark numbers (MediaPipe pose).
const SHOULDER_L = 11, SHOULDER_R = 12, ELBOW_L = 13, ELBOW_R = 14, WRIST_L = 15, WRIST_R = 16;
const HIP_L = 23, HIP_R = 24, KNEE_L = 25, KNEE_R = 26, ANKLE_L = 27, ANKLE_R = 28;

/**
 * The body shape: each part's length over torso length (mid shoulders to mid hips). A left and
 * right pair counts its longer side, since turning only ever shortens a limb on screen.
 */
const SHAPE_PARTS: readonly (readonly (readonly [number, number])[])[] = [
  [[SHOULDER_L, ELBOW_L], [SHOULDER_R, ELBOW_R]], // upper arm
  [[ELBOW_L, WRIST_L], [ELBOW_R, WRIST_R]], // forearm
  [[HIP_L, KNEE_L], [HIP_R, KNEE_R]], // thigh
  [[KNEE_L, ANKLE_L], [KNEE_R, ANKLE_R]], // shin
  [[SHOULDER_L, SHOULDER_R]], // shoulder width
  [[HIP_L, HIP_R]], // hip width
];
/** Only landmarks seen at least this well count toward a body shape. */
const SHAPE_VISIBILITY = 0.7;
/** A torso shorter than this (normalized units) is too small or side-on to measure against. */
const MIN_TORSO = 0.01;
/** A person's shape needs at least this many measured frames per part. */
const MIN_SHAPE_SAMPLES = 5;
/** Two shapes are compared only when at least this many parts were measured in both. */
const MIN_SHAPE_PARTS = 3;
/** A part's difference (log of the length ratio) counts at most this much, so one bad landmark cannot decide. */
const SHAPE_CLIP = 0.5;

/** Joints seen at least this well count toward how far a skeleton moved. */
const MOVE_VISIBILITY = 0.5;
/** Fewer common joints than this and movement falls back to the box centre. */
const MIN_MOVE_JOINTS = 4;

/**
 * Two tracks are in contact when their box centres come within this many box heights: about where
 * the boxes of two people side by side start to touch. Each person's body shape is taken from
 * before the pair's first contact, when linking cannot yet have mixed them up.
 */
const CONTACT_DISTANCE = 0.5;
/** How much a frame's body shape mismatch counts against a reading. */
const SHAPE_WEIGHT = 1;
/** How much one step of movement (box heights, plus size change) counts against a reading. */
const MOVE_WEIGHT = 1;
/** Flipping between "as linked" and "swapped" costs this much, so noise cannot flip it back and forth. */
const SWITCH_COST = 1;
/** The swapped reading must beat the linked one by at least this much in total, or nothing changes. */
const MIN_GAIN = 1.5;

/** A step is a leap when at least this share of the common joints moved more than LEAP_DISTANCE. */
const LEAP_SHARE = 0.6;
/** ...box heights per frame. A dancer's whole body does not travel a third of its height in 1/15 s. */
const LEAP_DISTANCE = 0.35;
/** A leap needs at least this many joints seen in both frames to be judged. */
const LEAP_MIN_JOINTS = 8;
/** Only steps across at most this many frames are judged as leaps. */
const LEAP_MAX_GAP = 2;
/** Someone is near when their box centre is within this many box heights of the leap's landing. */
const NEAR_DISTANCE = 1;
/** A leap that does not come back within this many frames (about a second) is left alone. */
const MAX_DROP_FRAMES = 15;

type Shape = (number | null)[];

const distance = (a: Landmark, b: Landmark, aspect: number) => Math.hypot((a[0] - b[0]) * aspect, a[1] - b[1]);

/** The body shape of one skeleton (log of each part over torso length), or null when the torso is not seen well. */
export function bodyShape(landmarks: readonly Landmark[], aspect = 1): Shape | null {
  const seen = (i: number) => (landmarks[i]?.[2] ?? 0) >= SHAPE_VISIBILITY;
  if (![SHOULDER_L, SHOULDER_R, HIP_L, HIP_R].every(seen)) return null;
  const mid = (a: number, b: number): Landmark => [(landmarks[a]![0] + landmarks[b]![0]) / 2, (landmarks[a]![1] + landmarks[b]![1]) / 2, 1];
  const torso = distance(mid(SHOULDER_L, SHOULDER_R), mid(HIP_L, HIP_R), aspect);
  if (torso < MIN_TORSO) return null;
  return SHAPE_PARTS.map((sides) => {
    let longest = 0;
    for (const [a, b] of sides) if (seen(a) && seen(b)) longest = Math.max(longest, distance(landmarks[a]!, landmarks[b]!, aspect));
    return longest > 0 ? Math.log(longest / torso) : null;
  });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A person's steady shape: each part's median over the points, or null when too few parts were measured. */
export function shapeSignature(points: readonly TrackPoint[], aspect = 1): Shape | null {
  const samples: number[][] = SHAPE_PARTS.map(() => []);
  for (const point of points) {
    const shape = bodyShape(point.landmarks, aspect);
    shape?.forEach((v, k) => { if (v !== null) samples[k]!.push(v); });
  }
  const signature = samples.map((s) => (s.length >= MIN_SHAPE_SAMPLES ? median(s) : null));
  return signature.filter((v) => v !== null).length >= MIN_SHAPE_PARTS ? signature : null;
}

/** How unlike a skeleton's shape is to a signature: mean clipped difference per part, or null when not comparable. */
export function shapeDistance(shape: Shape | null, signature: Shape | null): number | null {
  if (!shape || !signature) return null;
  let total = 0;
  let count = 0;
  shape.forEach((v, k) => {
    const s = signature[k];
    if (v === null || s === null || s === undefined) return;
    total += Math.min(SHAPE_CLIP, Math.abs(v - s));
    count++;
  });
  return count >= MIN_SHAPE_PARTS ? total / count : null;
}

const centreGap = (a: Box, b: Box, aspect: number) => Math.hypot((a.cx - b.cx) * aspect, a.cy - b.cy) / Math.max((a.h + b.h) / 2, 1e-6);

/** Distance each common joint moved from p to q, in box heights; the box centre alone when few joints are seen in both. */
function jointMoves(p: TrackPoint, q: TrackPoint, aspect: number): number[] {
  const h = Math.max((p.box.h + q.box.h) / 2, 1e-6);
  const moves: number[] = [];
  const count = Math.min(p.landmarks.length, q.landmarks.length);
  for (let k = 0; k < count; k++) {
    const a = p.landmarks[k]!, b = q.landmarks[k]!;
    if (a[2] < MOVE_VISIBILITY || b[2] < MOVE_VISIBILITY) continue;
    moves.push(distance(a, b, aspect) / h);
  }
  return moves.length >= MIN_MOVE_JOINTS ? moves : [centreGap(p.box, q.box, aspect)];
}

/** How unlikely the step from p to q is for one person: mean joint travel per frame plus size change. */
function stepCost(p: TrackPoint, q: TrackPoint, aspect: number): number {
  const moves = jointMoves(p, q, aspect);
  const frames = Math.max(1, q.frame - p.frame);
  const size = Math.abs(Math.log(Math.max(q.box.h, 1e-6) / Math.max(p.box.h, 1e-6)));
  return (moves.reduce((s, v) => s + v, 0) / moves.length + size) / frames;
}

const copyTrack = (t: Track): Track => ({ id: t.id, shot: t.shot, points: [...t.points] });
const byFrame = (t: Track) => new Map(t.points.map((p) => [p.frame, p]));

/** The first frame both tracks are on with their boxes in contact, or null when they never are. */
function firstContact(a: Track, b: Track, aspect: number): number | null {
  const other = byFrame(b);
  for (const p of a.points) {
    const q = other.get(p.frame);
    if (q && centreGap(p.box, q.box, aspect) <= CONTACT_DISTANCE) return p.frame;
  }
  return null;
}

/**
 * Swap repair for one pair: from the first frame both are on, a two-state best path (as linked, or
 * swapped) over every frame either is on, scored by body shape against each person's shape from
 * before they first met, plus how smoothly each person moves. Returns the frames to swap, or none.
 */
function pairSwaps(a: Track, b: Track, aspect: number): number[] {
  const contact = firstContact(a, b, aspect);
  if (contact === null) return [];
  const pa = byFrame(a), pb = byFrame(b);
  const start = Math.max(a.points[0]!.frame, b.points[0]!.frame);
  const end = Math.max(a.points[a.points.length - 1]!.frame, b.points[b.points.length - 1]!.frame);
  const frames = [...new Set([...pa.keys(), ...pb.keys()])].filter((f) => f >= start && f <= end).sort((x, y) => x - y);
  if (frames.length < 2) return [];
  const sigA = shapeSignature(a.points.filter((p) => p.frame < contact), aspect);
  const sigB = shapeSignature(b.points.filter((p) => p.frame < contact), aspect);
  // Without both body shapes nothing says who is who. A point measured against an unknown shape
  // would cost nothing, so the swapped reading would win on every frame and hand one person's
  // points to a short piece of track that has no shape of its own.
  if (!sigA || !sigB) return [];

  // Who is where in state s: s = 0 as linked, s = 1 swapped.
  const pointsAt = (f: number, s: number): [TrackPoint | undefined, TrackPoint | undefined] =>
    s === 0 ? [pa.get(f), pb.get(f)] : [pb.get(f), pa.get(f)];
  const shapeOf = new Map<TrackPoint, Shape | null>();
  const shape = (p: TrackPoint) => {
    if (!shapeOf.has(p)) shapeOf.set(p, bodyShape(p.landmarks, aspect));
    return shapeOf.get(p)!;
  };
  const emission = (f: number, s: number) => {
    const [forA, forB] = pointsAt(f, s);
    let cost = 0;
    if (forA) cost += SHAPE_WEIGHT * (shapeDistance(shape(forA), sigA) ?? 0);
    if (forB) cost += SHAPE_WEIGHT * (shapeDistance(shape(forB), sigB) ?? 0);
    return cost;
  };
  const transition = (f0: number, s0: number, f1: number, s1: number) => {
    const [a0, b0] = pointsAt(f0, s0), [a1, b1] = pointsAt(f1, s1);
    let cost = s0 === s1 ? 0 : SWITCH_COST;
    if (a0 && a1) cost += MOVE_WEIGHT * stepCost(a0, a1, aspect);
    if (b0 && b1) cost += MOVE_WEIGHT * stepCost(b0, b1, aspect);
    return cost;
  };

  // The path starts as linked: before they meet, each track is its own person.
  let cost = [emission(frames[0]!, 0), Infinity];
  let keep = cost[0]!;
  const back: number[][] = [];
  for (let i = 1; i < frames.length; i++) {
    const f0 = frames[i - 1]!, f1 = frames[i]!;
    const next = [0, 0];
    const from = [0, 0];
    for (const s1 of [0, 1]) {
      const via0 = cost[0]! + transition(f0, 0, f1, s1);
      const via1 = cost[1]! + transition(f0, 1, f1, s1);
      // Ties keep the earlier state "as linked", so equal readings change nothing.
      from[s1] = via1 < via0 ? 1 : 0;
      next[s1] = Math.min(via0, via1) + emission(f1, s1);
    }
    keep += transition(f0, 0, f1, 0) + emission(f1, 0);
    back.push(from);
    cost = next;
  }
  let state = cost[1]! < cost[0]! ? 1 : 0;
  const best = cost[state]!;
  if (keep - best < MIN_GAIN) return [];
  const swapped: number[] = [];
  for (let i = frames.length - 1; i >= 0; i--) {
    if (state === 1) swapped.push(frames[i]!);
    if (i > 0) state = back[i - 1]![state]!;
  }
  return swapped.reverse();
}

/** Exchanges the two tracks' points on the given frames, keeping each track's points in frame order. */
function applySwaps(a: Track, b: Track, frames: readonly number[]): number {
  const set = new Set(frames);
  const fromA = a.points.filter((p) => set.has(p.frame));
  const fromB = b.points.filter((p) => set.has(p.frame));
  a.points = [...a.points.filter((p) => !set.has(p.frame)), ...fromB].sort((x, y) => x.frame - y.frame);
  b.points = [...b.points.filter((p) => !set.has(p.frame)), ...fromA].sort((x, y) => x.frame - y.frame);
  return fromA.length + fromB.length;
}

const stretchesIn = (frames: readonly number[], all: readonly number[]) => {
  // Count runs of swapped frames that are consecutive among the frames considered.
  const index = new Map(all.map((f, i) => [f, i]));
  let runs = 0;
  frames.forEach((f, i) => { if (i === 0 || index.get(f)! !== index.get(frames[i - 1]!)! + 1) runs++; });
  return runs;
};

/** True when the whole skeleton leaps from p to q: most common joints moved far for the frames between. */
function leaps(p: TrackPoint, q: TrackPoint, aspect: number): boolean {
  const gap = q.frame - p.frame;
  if (gap < 1 || gap > LEAP_MAX_GAP) return false;
  const h = Math.max((p.box.h + q.box.h) / 2, 1e-6);
  let seen = 0;
  let far = 0;
  const count = Math.min(p.landmarks.length, q.landmarks.length);
  for (let k = 0; k < count; k++) {
    const a = p.landmarks[k]!, b = q.landmarks[k]!;
    if (a[2] < MOVE_VISIBILITY || b[2] < MOVE_VISIBILITY) continue;
    seen++;
    if (distance(a, b, aspect) / h / gap > LEAP_DISTANCE) far++;
  }
  return seen >= LEAP_MIN_JOINTS && far >= LEAP_SHARE * seen;
}

/**
 * Indices of the track's points that are someone else's pose: from a leap made while another
 * track is near, up to the leap back (or the track's end), when that comes within MAX_DROP_FRAMES.
 */
function borrowedPoints(track: Track, others: readonly Map<number, TrackPoint>[], aspect: number): Set<number> {
  const drop = new Set<number>();
  const points = track.points;
  const someoneNear = (p: TrackPoint) => others.some((o) => {
    const q = o.get(p.frame);
    return q !== undefined && centreGap(p.box, q.box, aspect) <= NEAR_DISTANCE;
  });
  for (let i = 1; i < points.length; i++) {
    if (!leaps(points[i - 1]!, points[i]!, aspect) || !someoneNear(points[i]!)) continue;
    const startFrame = points[i]!.frame;
    let back = -1;
    for (let k = i + 1; k < points.length && points[k]!.frame - startFrame <= MAX_DROP_FRAMES; k++) {
      if (leaps(points[k - 1]!, points[k]!, aspect)) { back = k; break; }
    }
    const endsSoon = points[points.length - 1]!.frame - startFrame < MAX_DROP_FRAMES;
    if (back < 0 && !endsSoon) continue;
    const stop = back < 0 ? points.length : back;
    for (let k = i; k < stop; k++) drop.add(k);
    i = stop;
  }
  return drop;
}

/**
 * Keeps each person on their own track: swap repair for every pair of tracks in the same shot
 * (lowest ids first), then jump drop on every track. Tracks keep their ids and shots; a track left
 * with no points is removed. Tracks come back ordered by id.
 */
export function repairIdentities(tracks: readonly Track[], options: IdentityOptions = {}): IdentityResult {
  const aspect = options.aspect ?? 1;
  const work = tracks.filter((t) => t.points.length > 0).map(copyTrack).sort((a, b) => a.id - b.id);
  let swaps = 0;
  let swappedPoints = 0;
  for (let i = 0; i < work.length; i++) {
    for (let j = i + 1; j < work.length; j++) {
      const a = work[i]!, b = work[j]!;
      if (a.shot !== b.shot) continue;
      const frames = pairSwaps(a, b, aspect);
      if (frames.length === 0) continue;
      const all = [...new Set([...a.points, ...b.points].map((p) => p.frame))].sort((x, y) => x - y);
      swaps += stretchesIn(frames, all);
      swappedPoints += applySwaps(a, b, frames);
    }
  }

  // Leaps are judged on the repaired tracks, all against the same state, so the order does not matter.
  const maps = work.map(byFrame);
  const drops = work.map((t, i) => borrowedPoints(t, maps.filter((_, k) => k !== i && work[k]!.shot === t.shot), aspect));
  let dropped = 0;
  const out = work.map((t, i) => {
    dropped += drops[i]!.size;
    return { ...t, points: t.points.filter((_, k) => !drops[i]!.has(k)) };
  }).filter((t) => t.points.length > 0);
  return { tracks: out, swaps, swappedPoints, dropped };
}
