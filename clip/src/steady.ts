// Hides the joints of a guide that the pose model is unsure of for a while, so a figure drawn from
// it does not show limbs that pop in and out at guessed spots. For drawing only: scoring keeps the
// timeline as it was. Looks both ways in time (the whole clip is known), never across a frame
// with no person. Smoothing itself is the engine's smoothTimeline, done before this; this does
// not smooth again.

import type { Landmark, PoseTimeline } from "../../engine/src/index.ts";

/** A joint is hidden when its visibility stays below this... */
export const UNSURE_BELOW = 0.3;
/** ...for every frame within this many frames either side (about half a second each way at 15 a second). */
export const UNSURE_RADIUS = 7;

/**
 * The timeline with visibility set to 0 for each joint whose visibility is below UNSURE_BELOW on
 * every frame within UNSURE_RADIUS frames either side (inside the same run of frames with a person).
 * Positions and frames are unchanged; other joints keep their visibility.
 */
export function hideUnsureJoints(timeline: PoseTimeline): PoseTimeline {
  const frames = timeline.frames;
  const n = frames.length;
  const runStart: number[] = new Array(n).fill(-1), runEnd: number[] = new Array(n).fill(-1);
  for (let i = 0; i < n; ) {
    if (!frames[i]!.landmarks) { i++; continue; }
    let j = i;
    while (j < n && frames[j]!.landmarks) j++;
    for (let k = i; k < j; k++) { runStart[k] = i; runEnd[k] = j - 1; }
    i = j;
  }
  return {
    ...timeline,
    frames: frames.map((frame, i) => {
      const lms = frame.landmarks;
      if (!lms) return frame;
      const lo = Math.max(runStart[i]!, i - UNSURE_RADIUS), hi = Math.min(runEnd[i]!, i + UNSURE_RADIUS);
      const landmarks = lms.map((p, k): Landmark => {
        for (let j = lo; j <= hi; j++) if ((frames[j]!.landmarks![k]?.[2] ?? 0) >= UNSURE_BELOW) return p;
        return [p[0], p[1], 0];
      });
      return { ...frame, landmarks };
    }),
  };
}
