import { skeletonGate } from "../../engine/src/index.ts";
import type { BoxFrame, PoseFrame } from "../../engine/src/index.ts";
import { keyMoments, paceOf } from "./moments.ts";
import type { ClipSource, Depth, FrameDetections, Guide, Outline, Track } from "./types.ts";

/**
 * Builds the guide for one subject in one shot. Timeline time starts at 0 at the shot's first
 * frame; `range` holds the matching media times. Frames where the track has no point are null.
 */
export function buildGuide(input: {
  fingerprint: string;
  source: ClipSource;
  frames: readonly FrameDetections[];
  track: Track;
  shot: { start: number; end: number };
  label: string;
  warnings: string[];
}): Guide {
  const { source, frames, track, shot } = input;
  const pointByFrame = new Map(track.points.map((p) => [p.frame, p]));
  const startMs = frames[shot.start]!.tMs;
  const poseFrames: PoseFrame[] = [];
  const boxFrames: BoxFrame[] = [];
  const outlines: (Outline | null)[] = [];
  const depths: (Depth | null)[] = [];
  for (let f = shot.start; f < shot.end; f++) {
    const tMs = frames[f]!.tMs - startMs;
    const point = pointByFrame.get(f);
    poseFrames.push({ tMs, landmarks: point ? point.landmarks : null });
    boxFrames.push({ tMs, box: point ? point.box : null });
    outlines.push(point ? point.outline : null);
    depths.push(point?.depth ?? null);
  }
  const timeline = {
    schema: "pose-timeline/1" as const,
    source: { width: source.width, height: source.height, mirrored: false },
    frames: poseFrames,
  };
  return {
    schema: "guide/1",
    fingerprint: input.fingerprint,
    source,
    range: { startMs, endMs: frames[shot.end - 1]!.tMs },
    subject: { kind: "person", label: input.label },
    channel: skeletonGate(timeline).channel,
    timeline,
    boxTrack: {
      schema: "box-track/1",
      source: { width: source.width, height: source.height },
      frames: boxFrames,
    },
    outlines,
    ...(depths.some((d) => d !== null) ? { depths } : {}),
    keyMoments: keyMoments(timeline),
    pace: paceOf(track, source.sampleHz),
    warnings: input.warnings,
    check: null,
  };
}
