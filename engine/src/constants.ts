// Every tunable number of the engine lives here. Change a value, bump SCORER_VERSION,
// so a stored score can always be traced to the rules that produced it.

export const SCORER_VERSION = "jester-engine/0.2.0";

/** The fixed time grid every timeline is resampled to. Frame k is at k * 1000 / GRID_HZ ms. */
export const GRID_HZ = 30;
export const GRID_MS = 1000 / GRID_HZ;

/** Inputs are rounded to this many decimals after resampling, so tiny float noise cannot move a score. */
export const QUANTIZE_DECIMALS = 4;

/** Resampling: interpolate between two detected input frames only if they are at most this far apart. */
export const MAX_INTERP_GAP_MS = 100;

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
  /** If standing still already earns more than 1 - this, the clip has little to copy: use plain accuracy. */
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
  /** Activity: player RMS speed (body units / s) below `activityMin` gives no continuous credit. */
  activityMin: 0.3,
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
