// Shared types for the clip side. Coordinates are MediaPipe normalized image coordinates,
// unmirrored, as in the engine: x by image width, y by image height, origin top-left.

import type { BoxTrack, Landmark, PoseTimeline } from "../../engine/src/index.ts";

/** A box by centre and size, normalized like landmarks. */
export interface Box { cx: number; cy: number; w: number; h: number }

/** A closed polygon in normalized image coordinates, first point not repeated, at most 60 points. */
export type Outline = [number, number][];

/** One person found in one frame. `outline` is null when the tracker gave no usable mask. */
export interface Detection { box: Box; landmarks: readonly Landmark[]; outline: Outline | null }

/** Everything found in one sampled frame, plus a colour signature used for cut detection. */
export interface FrameDetections { tMs: number; people: Detection[]; signature: number[] }

/** One person in one frame of a track. `frame` indexes the frames array given to linking. */
export interface TrackPoint { frame: number; tMs: number; box: Box; landmarks: readonly Landmark[]; outline: Outline | null }

/** One person followed through one shot. */
export interface Track { id: number; shot: number; points: TrackPoint[] }

export interface ClipSource { width: number; height: number; durationMs: number; sampleHz: number }

export type Pace = "slow" | "medium" | "fast";

export interface Candidate { trackId: number; number: number; label: string; score: number; boxAtConfirm: Box | null }

/** One hand's 21 Hand Landmarker points (0 wrist, 1-4 thumb, 5-8 index, 9-12 middle, 13-16 ring, 17-20 pinky), normalized like landmarks. */
export type HandPoints = [number, number][];

/** The hands of the subject at one timeline frame; null where a hand was not found. `left` is the pose model's left wrist (landmark 15). */
export interface GuideHands { left: HandPoints | null; right: HandPoints | null }

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
  /** The subject's outline at each timeline frame (same times as `boxTrack.frames`); null where absent. */
  outlines: (Outline | null)[];
  keyMoments: { tMs: number }[];
  /** Finger detail per timeline frame (same indices as `timeline.frames`). Absent on clips analysed without the hands pass. */
  hands?: (GuideHands | null)[];
  pace: Pace;
  warnings: string[];
  /** The AI form arrives in Version 2. */
  check: null;
}
