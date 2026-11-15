// Synthetic people for tests: 33 landmarks laid out so their extremes sit exactly on a box.

import type { Landmark, PoseFrame, PoseTimeline } from "../../engine/src/index.ts";
import { landmarks } from "../../engine/test/synth.ts";
import type { Pose2D } from "../../engine/test/synth.ts";
import { STAND } from "../../engine/test/synth.ts";
import type { Box, Detection, FrameDetections, Track } from "../src/types.ts";

export function landmarksInBox(box: Box): Landmark[] {
  return Array.from({ length: 33 }, (_, i): Landmark => [
    box.cx - box.w / 2 + (box.w * (i % 3)) / 2,
    box.cy - box.h / 2 + (box.h * Math.floor(i / 3)) / 10,
    1,
  ]);
}

/** The box's four corners as an outline, clockwise from top left. */
export function outlineOfBox(box: Box): [number, number][] {
  const left = box.cx - box.w / 2, right = box.cx + box.w / 2, top = box.cy - box.h / 2, bottom = box.cy + box.h / 2;
  return [[left, top], [right, top], [right, bottom], [left, bottom]];
}

export function person(box: Box): Detection {
  return { box, landmarks: landmarksInBox(box), outline: outlineOfBox(box) };
}

export function frame(index: number, people: Detection[]): FrameDetections {
  return { tMs: index * 100, people, signature: [] };
}

/** A track with one point per listed frame, 100 ms apart, the box given by `boxAt(frame)`. */
export function trackOf(id: number, frames: readonly number[], boxAt: (frame: number) => Box, shot = 0): Track {
  return {
    id,
    shot,
    points: frames.map((f) => {
      const box = boxAt(f);
      return { frame: f, tMs: f * 100, box, landmarks: landmarksInBox(box), outline: outlineOfBox(box) };
    }),
  };
}

/** Consecutive frame numbers from `start` for `count` frames. */
export function range(start: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => start + i);
}

/** Poses for timeline tests, as limb angles for the engine's stick figure (see engine/test/synth.ts). */
export const POSES: Record<string, Pose2D> = {
  armsUp: { ...STAND, lUpper: 160, lFore: 170, rUpper: -160, rFore: -170 },
  tPose: { ...STAND, lUpper: 90, lFore: 90, rUpper: -90, rFore: -90, lThigh: 8, rThigh: -8 },
  squat: { ...STAND, lUpper: 80, lFore: 60, rUpper: -80, rFore: -60, lThigh: 70, lShin: -10, rThigh: -70, rShin: 10 },
  leanRight: { ...STAND, lUpper: 140, lFore: 150, rUpper: -40, rFore: -30, rThigh: -15, rShin: -5 },
  leftArmUp: { ...STAND, lUpper: 170, lFore: 175, rUpper: -10, rFore: -5 },
  rest: { ...STAND },
};

const NUMERIC_FIELDS = ["cx", "cy", "scale", "lUpper", "lFore", "rUpper", "rFore", "lThigh", "lShin", "rThigh", "rShin"] as const;

function blend(a: Pose2D, b: Pose2D, amount: number): Pose2D {
  const out: Pose2D = { ...a };
  for (const key of NUMERIC_FIELDS) out[key] = a[key] + (b[key] - a[key]) * amount;
  return out;
}

/** Holds each named pose for `holdMs`, then eases to the next over `moveMs`; frames every `stepMs`. */
export function sequenceTimeline(
  names: readonly string[],
  o: { holdMs?: number; moveMs?: number; stepMs?: number } = {},
): PoseTimeline {
  const { holdMs = 2000, moveMs = 800, stepMs = 1000 / 12 } = o;
  const segment = holdMs + moveMs;
  const frames: PoseFrame[] = [];
  for (let t = 0; t < names.length * segment - 1e-9; t += stepMs) {
    const index = Math.min(names.length - 1, Math.floor(t / segment));
    const within = t - index * segment;
    const current = POSES[names[index]!]!;
    const next = POSES[names[Math.min(names.length - 1, index + 1)]!]!;
    const u = Math.min(1, Math.max(0, (within - holdMs) / moveMs));
    const pose = within < holdMs ? current : blend(current, next, u * u * (3 - 2 * u));
    frames.push({ tMs: Math.round(t), landmarks: landmarks(pose, 1) });
  }
  return { schema: "pose-timeline/1", source: { width: 1000, height: 1000, mirrored: false }, frames };
}
