// Turn what the CV stages actually emit into the engine's PoseTimeline.

import type { Landmark, PoseFrame, PoseTimeline } from "./types.ts";

/** A MediaPipe-style landmark object, as both CV stages produce it. */
export interface LandmarkObject {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
}

/**
 * One frame from Lisa's webcam module (spikes/pose-match/webcam.mjs):
 * `{ t, landmarks, aspect, mirrored, mask, outline }`, with `t` in ms since the tracker started.
 * `clipTimeMs` is optional: if the app shell tags each frame with the clip's media time, it wins.
 */
export interface WebcamFrame {
  t: number;
  landmarks: readonly LandmarkObject[] | null;
  aspect: number;
  mirrored?: boolean;
  clipTimeMs?: number;
}

export interface WebcamAdapterOptions {
  /**
   * Tracker time (the frames' `t`) at which the clip was at 0 ms. The app shell knows this: it is
   * `t` of the frame captured when the clip started playing. Ignored for frames that carry `clipTimeMs`.
   * Default 0 (tracker and clip started together).
   */
  trackerTimeAtClipStartMs?: number;
}

function toTuples(lms: readonly LandmarkObject[] | null): readonly Landmark[] | null {
  if (!lms || lms.length < 33) return null;
  return lms.map((l) => [l.x, l.y, l.visibility ?? 1] as const);
}

/** Only the ratio matters to the engine, so a fixed height stands in for the real size. */
function sourceFromAspect(aspect: number, mirrored: boolean) {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 4 / 3;
  return { width: Math.round(a * 1000), height: 1000, mirrored };
}

/** Build the player's PoseTimeline from webcam frames, on the clip's clock. Frames before the clip started are dropped. */
export function fromWebcamFrames(frames: readonly WebcamFrame[], options: WebcamAdapterOptions = {}): PoseTimeline {
  const offset = options.trackerTimeAtClipStartMs ?? 0;
  const first = frames[0];
  const out: PoseFrame[] = [];
  for (const f of frames) {
    const tMs = f.clipTimeMs ?? f.t - offset;
    if (!(tMs >= 0)) continue;
    out.push({ tMs, landmarks: toTuples(f.landmarks) });
  }
  return { schema: "pose-timeline/1", source: sourceFromAspect(first?.aspect ?? 4 / 3, first?.mirrored ?? false), frames: out };
}

/** One sample from a clip analysis pass: time and the chosen subject's landmarks (or null). */
export interface ClipSample {
  t: number;
  landmarks: readonly LandmarkObject[] | null;
}

export interface ClipAdapterOptions {
  width: number;
  height: number;
  /** Unit of `t` in the samples. The pose-match spike uses seconds. Default "ms". */
  timeUnit?: "s" | "ms";
}

/** Build the clip subject's PoseTimeline from analysis samples. */
export function fromClipSamples(samples: readonly ClipSample[], options: ClipAdapterOptions): PoseTimeline {
  const scale = options.timeUnit === "s" ? 1000 : 1;
  return {
    schema: "pose-timeline/1",
    source: { width: options.width, height: options.height, mirrored: false },
    frames: samples.map((s) => ({ tMs: s.t * scale, landmarks: toTuples(s.landmarks) })),
  };
}
