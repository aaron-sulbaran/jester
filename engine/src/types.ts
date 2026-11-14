// Shared data types between the CV stages and the engine.
// Coordinates are MediaPipe normalized image coordinates: x by image width, y by image
// height, origin top-left, y grows downward.

/** One body point: [x, y, visibility]. Visibility in 0..1. */
export type Landmark = readonly [number, number, number];

/** 33 MediaPipe Pose landmarks, or null when no person was found in that frame. */
export type Landmarks = readonly Landmark[] | null;

export interface PoseFrame {
  /**
   * Time in ms on the CLIP's timeline. For the clip this is media time. For the player it is the
   * clip's media time at the moment the camera frame was captured (or capture time plus a known offset).
   * Timestamps may be uneven; the engine resamples them to a fixed grid.
   */
  tMs: number;
  landmarks: Landmarks;
}

export interface SourceInfo {
  width: number;
  height: number;
  /**
   * True if the frames were horizontally flipped before tracking (a mirrored selfie preview).
   * Data is expected unmirrored; the engine handles the mirror rule itself.
   */
  mirrored: boolean;
}

export interface PoseTimeline {
  schema: "pose-timeline/1";
  source: SourceInfo;
  frames: readonly PoseFrame[];
}

export interface BoxFrame {
  tMs: number;
  /** null when the subject is not visible. Center x, y and size, normalized like landmarks. */
  box: { cx: number; cy: number; w: number; h: number } | null;
}

export interface BoxTrack {
  schema: "box-track/1";
  source: Omit<SourceInfo, "mirrored">;
  frames: readonly BoxFrame[];
  /**
   * Optional per-input-frame horizontal background scroll in normalized x units (side-scrollers).
   * Same length as frames. World x = cx + cumulative scroll.
   */
  scrollX?: readonly number[];
}

export type Tier = "Perfect" | "Great" | "Good" | "OK" | "Miss";

export interface LimbBreakdown {
  /** Mean per-limb credit 0..1 over scorable frames where the limb was visible. */
  credit: number;
  /** Mean angle error in degrees. */
  meanErrorDeg: number;
  /** "low", "high" or "angle": the most common way the player's limb was off. */
  direction: "low" | "high" | "angle";
  framesSeen: number;
}

export interface PoseRoundResult {
  channel: "pose";
  scorerVersion: string;
  /** 0..100 integer, or null if tracking was too poor to score. */
  score: number | null;
  tier: Tier | null;
  failure: "low-tracking" | "no-reference" | null;
  /** Mean per-frame pose credit over scorable frames, 0..1. */
  accuracy: number;
  /** What standing still would have earned on the same frames, 0..1. The score rewards accuracy above this. */
  stillBaseline: number;
  /** Timing credit 0..1 from the global lag. */
  timing: number;
  /** Player lag in ms; positive means the player was behind the clip. */
  lagMs: number;
  /** Share of grid frames that were scorable. */
  validShare: number;
  perLimb: Record<string, LimbBreakdown>;
  /** The limb with the largest weighted loss, named from the player's own side. */
  worstLimb: { limb: string; label: string; direction: "low" | "high" | "angle" } | null;
  /** Per grid frame credit (0..1) or null when unscorable. Useful for a timeline chart. */
  frameCredits: (number | null)[];
}

export type EventType = "jump" | "crouch" | "moveLeft" | "moveRight";

export interface MotionEvent {
  type: EventType;
  /** Grid frame index of the event's moment (apex for jumps, entry for crouch, peak speed for moves). */
  frame: number;
}

export interface EventMatch {
  type: EventType;
  refFrame: number;
  playerFrame: number | null;
  /** Player minus reference time in ms, after removing the global lag. null when missed. */
  dtMs: number | null;
  credit: number;
}

export interface TrajectoryRoundResult {
  channel: "trajectory";
  scorerVersion: string;
  score: number | null;
  tier: Tier | null;
  failure: "low-tracking" | "nothing-to-mimic" | null;
  lagMs: number;
  timing: number;
  /** Lag-corrected correlation above chance, mapped to 0..1. */
  continuous: number | null;
  correlation: number | null;
  chanceCorrelation: number | null;
  activity: number;
  eventF1: number | null;
  matches: EventMatch[];
  extraPlayerEvents: MotionEvent[];
  axes: { x: boolean; y: boolean; h: boolean };
}
