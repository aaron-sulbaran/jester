// Steadies a pose timeline taken from a real video, so a stick figure drawn from it is easy to follow.
// Raw tracking jitters from frame to frame, sometimes throws a point far off for a single frame, and
// loses the person for a few frames now and then. The whole timeline is known in advance, so this works
// offline and looks both ways (no lag): fill short gaps, drop one-frame spikes, then soften the rest.

import type { Landmark, PoseFrame, PoseTimeline } from "./types.ts";

export interface SmoothOptions {
  /** Gaps of at most this many frames with no person are filled in between their neighbours. */
  maxFill?: number;
  /** Spikes: each point is compared with the median of this many frames around it (odd). */
  medianWindow?: number;
  /** Softening: Gaussian width in frames (about 100 ms at 15 a second). */
  sigma?: number;
}

const DEFAULTS: Required<SmoothOptions> = { maxFill: 5, medianWindow: 5, sigma: 1.5 };

type Mutable = [number, number, number];

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Fills runs of up to `maxFill` empty frames that have a person on both sides, by straight lines. */
function fillGaps(frames: (Mutable[] | null)[], maxFill: number) {
  let i = 0;
  while (i < frames.length) {
    if (frames[i]) { i++; continue; }
    let j = i;
    while (j < frames.length && !frames[j]) j++;
    const before = frames[i - 1], after = frames[j];
    if (before && after && j - i <= maxFill) {
      for (let k = i; k < j; k++) {
        const u = (k - i + 1) / (j - i + 1);
        frames[k] = before.map((p, n) => {
          const q = after[n]!;
          return [p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u, Math.min(p[2], q[2])];
        });
      }
    }
    i = j;
  }
}

/**
 * The timeline with short gaps filled, one-frame spikes removed and jitter softened. Frames stay the
 * same (same count and times); a run of frames without a person longer than `maxFill` stays empty, and
 * smoothing never reaches across it. Visibility is softened the same way.
 */
export function smoothTimeline(timeline: PoseTimeline, options: SmoothOptions = {}): PoseTimeline {
  const { maxFill, medianWindow, sigma } = { ...DEFAULTS, ...options };
  const frames: (Mutable[] | null)[] = timeline.frames.map((f) => f.landmarks?.map((p) => [p[0], p[1], p[2]] as Mutable) ?? null);
  fillGaps(frames, maxFill);
  const n = frames.length;
  const count = frames.find((f) => f)?.length ?? 0;
  const half = medianWindow >> 1;
  const radius = Math.ceil(sigma * 2);
  const weights = Array.from({ length: 2 * radius + 1 }, (_, k) => Math.exp(-((k - radius) ** 2) / (2 * sigma * sigma)));

  // The run of frames with a person that frame i belongs to, so filters stay inside it.
  const runStart: number[] = new Array(n).fill(-1), runEnd: number[] = new Array(n).fill(-1);
  for (let i = 0; i < n; ) {
    if (!frames[i]) { i++; continue; }
    let j = i;
    while (j < n && frames[j]) j++;
    for (let k = i; k < j; k++) { runStart[k] = i; runEnd[k] = j - 1; }
    i = j;
  }

  const despiked: (Mutable[] | null)[] = frames.map((f, i) => {
    if (!f) return null;
    // Windows shrink evenly near the ends of a run, so a steady movement is kept exactly.
    const h = Math.min(half, i - runStart[i]!, runEnd[i]! - i);
    const lo = i - h, hi = i + h;
    return f.map((_, p) => [0, 1, 2].map((axis) => {
      const xs: number[] = [];
      for (let k = lo; k <= hi; k++) xs.push(frames[k]![p]![axis]!);
      return median(xs);
    }) as Mutable);
  });

  const out: PoseFrame[] = timeline.frames.map((frame, i) => {
    const f = despiked[i];
    if (!f) return { tMs: frame.tMs, landmarks: null };
    const r = Math.min(radius, i - runStart[i]!, runEnd[i]! - i);
    const lo = i - r, hi = i + r;
    const landmarks: Landmark[] = [];
    for (let p = 0; p < count; p++) {
      let sx = 0, sy = 0, sv = 0, sw = 0, swv = 0;
      for (let k = lo; k <= hi; k++) {
        const q = despiked[k]![p]!;
        const w = weights[k - i + radius]!;
        // Confident points count for more, so an unsure one is pulled toward its sure neighbours.
        const wv = w * (0.2 + q[2]);
        sx += q[0] * wv; sy += q[1] * wv; swv += wv;
        sv += q[2] * w; sw += w;
      }
      landmarks.push([sx / swv, sy / swv, sv / sw] as const);
    }
    return { tMs: frame.tMs, landmarks };
  });
  return { ...timeline, frames: out };
}
