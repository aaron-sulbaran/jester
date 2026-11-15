// The clip time to stamp a camera pose with: the moment the camera frame was taken, not the moment tracking
// it finished. Pure, so app/test/stamp.test.ts runs it under node.

/** A frame older than this is taken as a timing glitch, not latency, and capped. */
export const MAX_CAMERA_AGE_MS = 500;

/**
 * `clockMs` is the clip's clock now (play time ms, -1 before the clip starts), `nowMs` is performance.now(),
 * and `shotAtMs` is when the frame was taken on the same clock as performance.now() (-1 when unknown). The
 * clip's clock runs at wall speed in play time, so the frame's age comes straight off it. A frame taken
 * before the clip started stays -1.
 */
export function stampAt(clockMs: number, nowMs: number, shotAtMs: number): number {
  if (clockMs < 0) return clockMs;
  if (!(shotAtMs > 0)) return clockMs;
  const age = Math.min(MAX_CAMERA_AGE_MS, Math.max(0, nowMs - shotAtMs));
  const at = clockMs - age;
  return at >= 0 ? at : -1;
}
