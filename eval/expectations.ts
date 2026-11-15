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
  /**
   * Derived cases (src/derive.ts): copies of a good round changed in a way whose effect on the score is known.
   * A round is a source when it is tagged nailed, or untagged with at least `minSourceScore`.
   */
  derived: {
    minSourceScore: 60,
    /** late: every frame shifted this much later; the lag must move by it, give or take the tolerance. */
    lateShiftMs: 500,
    lateLagToleranceMs: 150,
    /** ... and the score may drop at most this much from the source. */
    lateMaxBelowSource: 15,
    /** frozen: the first frame held for the whole round must score this or less. */
    frozenMaxScore: 10,
    /** seated: legs hidden must be capped at this, on a clip whose legs swing at least `seated.legRangeDeg`. */
    seatedMaxScore: 50,
    /** walked out: no body for this share of the round, in the middle; no score or capped. */
    walkedOutShare: 0.4,
    walkedOutMaxScore: 50,
    /** jittered: every point moved by up to this share of the frame (0.003 is about 2 pixels at 640 wide). */
    jitter: 0.003,
    jitterMaxMove: 5,
  },
} as const;
