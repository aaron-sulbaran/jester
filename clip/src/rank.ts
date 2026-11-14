import type { Box, Candidate, Track } from "./types.ts";

const MIN_VISIBILITY = 0.3;
const WEIGHTS = { size: 0.35, central: 0.2, motion: 0.25, onScreen: 0.2 } as const;
/** Movement of this many box heights per frame earns the full motion score. */
const FULL_MOTION = 0.05;

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * How far a track's landmarks move per frame, in box heights: for each pair of consecutive points,
 * the mean distance moved by landmarks seen in both, over the earlier box's height; then the mean
 * over pairs. Fewer than 2 points is 0.
 */
export function motionPerFrame(track: Track): number {
  const perPair: number[] = [];
  for (let i = 1; i < track.points.length; i++) {
    const before = track.points[i - 1]!;
    const after = track.points[i]!;
    let total = 0;
    let seen = 0;
    const count = Math.min(before.landmarks.length, after.landmarks.length);
    for (let k = 0; k < count; k++) {
      const a = before.landmarks[k]!;
      const b = after.landmarks[k]!;
      if (a[2] < MIN_VISIBILITY || b[2] < MIN_VISIBILITY) continue;
      total += Math.hypot(b[0] - a[0], b[1] - a[1]);
      seen++;
    }
    if (seen > 0 && before.box.h > 0) perPair.push(total / seen / before.box.h);
  }
  return perPair.length === 0 ? 0 : perPair.reduce((sum, v) => sum + v, 0) / perPair.length;
}

function scoreOf(track: Track, frameCount: number): number {
  const size = clamp01(median(track.points.map((p) => p.box.h)));
  const central = clamp01(1 - 2 * Math.abs(median(track.points.map((p) => p.box.cx)) - 0.5));
  const motion = clamp01(motionPerFrame(track) / FULL_MOTION);
  const onScreen = clamp01(track.points.length / frameCount);
  return WEIGHTS.size * size + WEIGHTS.central * central + WEIGHTS.motion * motion + WEIGHTS.onScreen * onScreen;
}

/**
 * Ranks the people worth offering as the subject, best first. A track needs at least one second of
 * points (`sampleHz`) to be offered. `boxAtConfirm` stays null; see `withConfirmBoxes`.
 */
export function rankCandidates(
  tracks: readonly Track[],
  info: { sampleHz: number; frameCount: number },
): Candidate[] {
  return tracks
    .filter((track) => track.points.length >= info.sampleHz)
    .map((track) => ({ trackId: track.id, score: scoreOf(track, info.frameCount) }))
    .sort((a, b) => b.score - a.score || a.trackId - b.trackId)
    .map((entry, i) => ({
      trackId: entry.trackId,
      number: i + 1,
      label: `Person ${i + 1}`,
      score: entry.score,
      boxAtConfirm: null,
    }));
}

/** The earliest frame where the most candidates are on screen at once; 0 when there are none. */
export function pickConfirmFrame(candidates: readonly Candidate[], tracks: readonly Track[]): number {
  const present = new Map<number, number>();
  for (const candidate of candidates) {
    const track = tracks.find((t) => t.id === candidate.trackId);
    for (const point of track?.points ?? []) present.set(point.frame, (present.get(point.frame) ?? 0) + 1);
  }
  let bestFrame = 0;
  let bestCount = 0;
  for (const [frame, count] of present) {
    if (count > bestCount || (count === bestCount && frame < bestFrame)) {
      bestFrame = frame;
      bestCount = count;
    }
  }
  return bestFrame;
}

/** Copies of the candidates with each one's box at `frame`, or null where it is not on screen. */
export function withConfirmBoxes(
  candidates: readonly Candidate[],
  tracks: readonly Track[],
  frame: number,
): Candidate[] {
  return candidates.map((candidate) => {
    const point = tracks.find((t) => t.id === candidate.trackId)?.points.find((p) => p.frame === frame);
    const boxAtConfirm: Box | null = point ? point.box : null;
    return { ...candidate, boxAtConfirm };
  });
}
