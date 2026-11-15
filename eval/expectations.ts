// What each dev test tag promises about the score. Starting values from the team's brief; change them here
// and nowhere else. `npm run eval` checks every tagged round against these with the current engine code.

export const EXPECT = {
  /** Standing still in view must earn almost nothing. No score at all also holds. */
  stoodStill: { maxScore: 10 },
  /** A real best effort must reach the "Great" tier. */
  nailed: { minScore: 75 },
  /** Seated, on a clip that uses the legs, must be capped (the engine's hidden limb cap is 50). */
  seated: {
    maxScore: 50,
    /** A clip "uses the legs" when a thigh or shin swings at least this far over the clip (degrees, 5th to 95th percentile). */
    legRangeDeg: 25,
  },
  /** Copying well but about half a second behind: the lag is found, and the score stays near the same tester's nailed round. */
  lateHalfSecond: { lagMs: 500, lagToleranceMs: 150, maxBelowNailed: 15 },
  /** Doing different moves in view must score under this. */
  wrongMoves: { maxScore: 39 },
  /** Walking out of view halfway: no score, or a capped one. */
  walkedOutOfFrame: { maxScore: 50 },
  /** A round whose score moved at least this far from the score it got when played is listed. */
  driftMin: 5,
  /** Calibration hint: the ceiling that would put the median nailed copy at this score. */
  nailedTarget: 90,
  /** The hint needs at least this many nailed rounds. */
  minNailedForHint: 3,
} as const;
