// Shared types for the clip side. Coordinates are MediaPipe normalized image coordinates,
// unmirrored, as in the engine: x by image width, y by image height, origin top-left.

import type { BoxTrack, Landmark, PoseTimeline } from "../../engine/src/index.ts";

/** A box by centre and size, normalized like landmarks. */
export interface Box { cx: number; cy: number; w: number; h: number }

/** One person found in one frame. */
export interface Detection { box: Box; landmarks: readonly Landmark[] }

/** Everything found in one sampled frame, plus a colour signature used for cut detection. */
export interface FrameDetections { tMs: number; people: Detection[]; signature: number[] }

/** One person in one frame of a track. `frame` indexes the frames array given to linking. */
export interface TrackPoint { frame: number; tMs: number; box: Box; landmarks: readonly Landmark[] }

/** One person followed through one shot. */
export interface Track { id: number; shot: number; points: TrackPoint[] }

export interface ClipSource { width: number; height: number; durationMs: number; sampleHz: number }

export type Pace = "slow" | "medium" | "fast";

export interface Candidate { trackId: number; number: number; label: string; score: number; boxAtConfirm: Box | null }

export interface Guide {
  schema: "guide/1";
  fingerprint: string;
  source: ClipSource;
  /** Media time of the shot used; timeline tMs starts at 0 at startMs. */
  range: { startMs: number; endMs: number };
  subject: { kind: "person" | "thing"; label: string };
  channel: "pose" | "trajectory";
  timeline: PoseTimeline | null;
  boxTrack: BoxTrack;
  keyMoments: { tMs: number }[];
  pace: Pace;
  warnings: string[];
  /** The AI form arrives in Version 2. */
  check: null;
}
