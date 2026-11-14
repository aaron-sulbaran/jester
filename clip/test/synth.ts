// Synthetic people for tests: 33 landmarks laid out so their extremes sit exactly on a box.

import type { Landmark } from "../../engine/src/index.ts";
import type { Box, Detection, FrameDetections } from "../src/types.ts";

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
