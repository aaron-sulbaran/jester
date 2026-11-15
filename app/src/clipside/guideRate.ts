// How fast the page is really running, for the blind mode guide's per-turn check. The middle sample is used, not
// the average: the camera tracker freezes the page for about a second once when it starts (seen at the start of a
// camera turn), and that one long frame must not hand the turn to the stick figure. A page that is slow on every
// frame (software rendering) still reads as slow.

/** The middle of a list of times in milliseconds. */
export function typicalMs(samples: readonly number[]): number {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** Frames a second from the gaps between frames (milliseconds), going by the typical frame. */
export function steadyFps(gapsMs: readonly number[]): number {
  const gap = typicalMs(gapsMs);
  return gap > 0 ? 1000 / gap : 0;
}
