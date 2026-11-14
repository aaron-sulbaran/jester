// Synthetic people for tests: 33 landmarks laid out so their extremes sit exactly on a box.

import type { Landmark } from "../../engine/src/index.ts";
import type { Box, Detection, FrameDetections, Track } from "../src/types.ts";

export function landmarksInBox(box: Box): Landmark[] {
  return Array.from({ length: 33 }, (_, i): Landmark => [
    box.cx - box.w / 2 + (box.w * (i % 3)) / 2,
    box.cy - box.h / 2 + (box.h * Math.floor(i / 3)) / 10,
    1,
  ]);
}

export function person(box: Box): Detection {
  return { box, landmarks: landmarksInBox(box) };
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
      return { frame: f, tMs: f * 100, box, landmarks: landmarksInBox(box) };
    }),
  };
}

/** Consecutive frame numbers from `start` for `count` frames. */
export function range(start: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => start + i);
}
