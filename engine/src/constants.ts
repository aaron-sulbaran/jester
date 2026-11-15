// Every tunable number of the engine lives here. Change a value, bump SCORER_VERSION,
// so a stored score can always be traced to the rules that produced it.

export const SCORER_VERSION = "jester-engine/0.11.0";

/** The fixed time grid every timeline is resampled to. Frame k is at k * 1000 / GRID_HZ ms. */
export const GRID_HZ = 30;
export const GRID_MS = 1000 / GRID_HZ;

/** Inputs are rounded to this many decimals after resampling, so tiny float noise cannot move a score. */
export const QUANTIZE_DECIMALS = 4;

/** Resampling: interpolate between two detected input frames only if they are at most this far apart. */
export const MAX_INTERP_GAP_MS = 100;

/**
 * 0.11.0 either side. Players copy a dancer two ways: as a mirror (the dancer raises her right arm, the player
 * raises their left) or with the same side (the player raises their own right arm). Both are the dance someone
 * would expect, so neither costs points: a round is scored both ways through the whole pipeline (lag, motion
 * and moved shares, still gate, gain) and the better score is kept, with no penalty. On an exact tie the mirror
 * reading wins, so a mirror copy keeps its 0.10.0 score. Before this a same-side copy scored near 0 under the
 * 0.10.0 still gate (Aaron's live round: 87 in 0.9.0, 0 in 0.10.0).
 */
export const ORIENTATION = {
  /** Score pose rounds and live pose comparisons both mirrored and same side, keep the better. */
  eitherSide: true,
  /**
   * Trajectory rounds (an object's box, or a person's box followed with one body part): off by default. For an
   * object there is no "same side": stepping the other way from a car is a wrong-way copy and must score low
   * (car wrong way: 10 or less). A same-side copy of a person's sideways travel does lose here, so a caller
   * following a person can pass { eitherSide: true } to scoreTrajectoryRound.
   */
  eitherSideTrajectory: false,
} as const;

export const POSE = {
  /** Angle error at or below this gets full credit (degrees). */
  thetaInDeg: 15,
  /** Angle error at or above this gets zero (degrees). */
  thetaOutDeg: 60,
  /** A limb counts only if its least visible endpoint, on both sides, reaches this. */
  minVisibility: 0.5,
  /** A frame is scorable only if the visible limb weight is at least this share of the total. */
  minCoveredWeightShare: 0.4,
  /** Limb weight multiplier = base + (1 - base) * (normalized reference motion of that limb). */
  motionWeightBase: 0.5,
  /** Half-width of the window used to measure a reference limb's motion (frames). */
  motionWindowFrames: 15,
  /**
   * 0.3.0: a limb the clip shows and is using, but the camera cannot see on the player, counts as a miss.
   * Its weight is the limb's full weight times min(1, max(motion share * this, posed)). Motion share is 0
   * for a limb the clip holds still and 1 for its busiest limb; posed is 0 for a limb hanging as when
   * standing and 1 for one held 60 degrees or more away (a squat). 2 means a limb moving at half the
   * busiest rate costs its full weight. 0 turns off the motion part. Before 0.3.0 hidden limbs dropped out,
   * and a player sitting down scored 98 on the starter clip, which has squats.
   */
  unseenPenalty: 2,
  /** 0.4.0 hidden cap: a frame counts as the clip using a limb when its activity (see unseenPenalty) is at least this. */
  hiddenActiveMin: 0.5,
  /** ... and the limb counts for the cap only if the clip uses it in at least this share of scored frames. */
  hiddenUsedMinShare: 0.1,
  /** ... and the round is capped when the player's limb was out of view for at least this share of those frames. */
  hiddenCapShare: 0.5,
  /** Round fails as "low tracking" when more than this share of frames is unscorable. */
  maxInvalidShare: 0.3,
} as const;

export const LAG = {
  /** Global lag search range: player may be up to this early (ms, negative) ... */
  minMs: -200,
  /** ... and up to this late (ms). A first-time player following unseen moves ran 700 ms late. */
  maxMs: 1200,
  /** Local slack around the chosen lag, per frame (frames each side). */
  slackFrames: 3,
} as const;

export const TIMING = {
  /**
   * Lag at or below this is normal: full timing credit (ms). Covers reaction to moves the player has not
   * seen plus tracker latency (frames are stamped when tracking finishes). 0.2.0: was 300, after a real
   * webcam round of a good copy came in 700 ms late and lost most of its timing credit.
   */
  freeMs: 650,
  /** Lag at or above this gets zero timing credit (ms). 0.2.0: was 800. */
  zeroMs: 1200,
} as const;

export const ROUND = {
  /**
   * Raw = gain * (accuracyWeight + (1 - accuracyWeight) * timing), where gain is the accuracy above
   * what standing still would earn on this clip. Timing scales the score, so doing nothing earns nothing.
   */
  accuracyWeight: 0.85,
  /** Raw value that maps to score 0. */
  floor: 0,
  /** Raw value that maps to score 100. 1.0 until calibrated on good human copies (then likely about 0.9). */
  ceiling: 1.0,
  /**
   * 0.4.0: the highest score a round can get when a major limb the clip uses stayed out of view (see
   * PoseRoundResult.hiddenLimbs). 50 is the "OK" tier: a seated player scored 82 "Great" on the starter
   * clip under 0.3.0, which the team judged far too high.
   */
  hiddenCap: 50,
  /** If standing still already earns more than 1 - this, the clip has little to copy: use plain accuracy. */
  minHeadroom: 0.1,
} as const;

/**
 * 0.9.0 moving credit. Before 0.9.0 the round scored only accuracy above what a perfect standing-still pose
 * earns. On low-motion dance clips that pose already earns 0.80 to 0.85, and a real webcam player (tracker
 * noise, loose timing) lands below it, so every blind round scored 0. Now the round also earns an absolute
 * accuracy credit, gated by how much the player moves like the clip: the gain is
 * max(gain over still, gate * absolute credit). Standing still does not move, so its gate stays shut.
 *
 * Motion is measured per limb as the angle a limb direction turns over `motionSpanMs`, after a short
 * smoothing and minus a noise floor, so tracker jitter on a still body does not count as moving. Each limb's
 * player motion is capped at the clip's motion for that limb, so flailing the arms cannot stand in for
 * legs the clip moves. Motion share = sum of capped player motion / sum of clip motion, over the round.
 */
export const MOTION = {
  /** Directions are averaged over this many grid frames (centered, odd) before motion is measured. */
  smoothFrames: 5,
  /** Motion is the angle a limb turns between t and t + this (ms). */
  spanMs: 250,
  /** Turning less than this over the span counts as no motion (degrees): covers tracker jitter. */
  noiseFloorDeg: 6,
  /** Motion share at or below this opens no gate ... */
  gateLow: 0.15,
  /** ... and at or above this opens it fully (linear in between). */
  gateHigh: 0.5,
  /** Absolute accuracy credit: 0 at or below this accuracy ... */
  accuracyFloor: 0.55,
  /** ... and 1 at or above this accuracy (linear in between). */
  accuracyFull: 1.0,
  /**
   * 0.10.0 still gate. For the moved share, each limb turn (degrees over spanMs, after smoothing) counts only
   * the part above this, for player and clip alike: covers tracker jitter, breathing and sway on a body that
   * is standing still.
   */
  movedFloorDeg: 12,
  /** Moved share (raw player motion over the clip's) at or below this gives no gain over still ... */
  movedLow: 0.2,
  /** ... and at or above this the full gain over still (linear in between). */
  movedHigh: 0.5,
} as const;

/**
 * 0.5.0 placement: where the body is and how big it looks (src/placement.ts). Anchor = shoulder midpoint,
 * size = torso length. Distances are in torso lengths, size differences in natural log of the size ratio.
 */
export const PLACEMENT = {
  /** Share of the round score that comes from relative moves, when the clip travels enough to score them. */
  weight: 0.25,
  /** Within a placement credit: position share; the rest is size. */
  positionShare: 0.7,
  /** Relative position error: full credit within this many torso lengths, zero at the second. */
  posFullTorsos: 0.25,
  posZeroTorsos: 1.0,
  /** Size error (|log ratio|): full credit within 0.1 (about 10 percent), zero at 0.4 (about 50 percent). */
  sizeFullLog: 0.1,
  sizeZeroLog: 0.4,
  /** Outline fit (shown, not scored): anchor offset from the subject's, in the subject's torso lengths. */
  outlinePosFullTorsos: 0.15,
  outlinePosZeroTorsos: 0.8,
  /** Placement needs anchor and size on at least this share of matched frames (seated players often hide hips). */
  minFrameShare: 0.5,
  /** Staying in place must lose at least this much placement credit, or the clip does not travel enough to score. */
  minHeadroom: 0.1,
} as const;

/** Score tiers, highest first. */
export const TIERS = [
  { name: "Perfect", min: 90 },
  { name: "Great", min: 75 },
  { name: "Good", min: 55 },
  { name: "OK", min: 35 },
  { name: "Miss", min: 0 },
] as const;

export const TRAJECTORY = {
  /** Smoothing before taking velocity: centered moving average width (frames, odd). */
  smoothFrames: 7,
  /** Noise floor for robust z-score of velocity, in body units per second. */
  velocityFloor: 0.3,
  /** Correlation windows. */
  windowFrames: 120,
  windowStepFrames: 30,
  /** A reference axis counts only if its p95 - p5 range reaches this (in box heights). */
  minRangeX: 0.25,
  minRangeY: 0.15,
  /** Number of fixed circular shifts used for the chance baseline. */
  surrogateCount: 16,
  /** Shifts shorter than this are skipped (frames). */
  minSurrogateShiftFrames: 60,
  /** Correlation that maps to full continuous credit (calibrate: median of good copies). */
  goodCorrelation: 0.65,
  /** Continuous and event weights; events weigh more on short clips. */
  continuousWeight: 0.6,
  shortClipFrames: 500,
  continuousWeightShort: 0.4,
  /** Activity: player RMS speed (torso lengths / s) below `activityMin` gives no continuous credit... */
  activityMin: 0.3,
  /**
   * ... and full credit at a target speed: the object's speed across its own range of travel (per second)
   * times the body part's reach (BODY_PARTS in trajectory.ts), kept between activityTargetMin and activityTarget. 0.6.0: was half the
   * object's speed in its own box heights, which a small fast object made impossible.
   */
  activityTarget: 0.8,
  activityTargetMin: 0.25,
  /** 0.7.0: when hips are hidden (at a desk), torso length is estimated as shoulder width times this. */
  torsoPerShoulderWidth: 1.4,
  /** 0.8.0: for a body part, events are found on its path scaled toward the object's range. Only an axis that moves at least this many torso lengths is scaled. */
  partEventMinRange: 0.1,
  /** 0.8.0: the most that path is scaled up. */
  partEventMaxScale: 3,
  /** 0.6.0: the reference unit is the box height, but never under this share of the frame height (a small ball). */
  minReferenceUnit: 0.25,
  /** Event matching window (ms) after the global lag. */
  matchWindowMs: 250,
  /** Same-type events closer than this are merged (ms). */
  refractoryMs: 250,
  /** Gaps up to this many frames are bridged by linear interpolation in signals. */
  maxBridgeFrames: 5,
} as const;

/** Event thresholds. Player units are torso lengths (L); reference units are box heights (H). */
export const EVENTS = {
  jumpStartSpeed: 1.5,
  playerJumpStart: 0.15,
  playerJumpMinApex: 0.25,
  refJumpStart: 0.1,
  refJumpMinApex: 0.3,
  jumpLandMargin: 0.05,
  jumpMinMs: 150,
  /** 0.6.0: the longest a jump may stay in the upper half of its rise (standing up and staying up is longer). */
  jumpMaxMs: 1200,
  playerCrouchEnter: 0.85,
  playerCrouchExit: 0.92,
  refCrouchEnter: 0.75,
  refCrouchExit: 0.85,
  crouchMinMs: 200,
  moveDeadband: 0.3,
  playerMoveMin: 0.35,
  refMoveMin: 0.5,
  moveMinMs: 150,
  baselineFrames: 60,
} as const;
