import type { Landmark } from "../../engine/src/index.ts";
import type { Box } from "./types.ts";

const MIN_POINTS = 4;

/** The box around the landmarks seen well enough, or null when fewer than 4 qualify. */
export function boxFromLandmarks(landmarks: readonly Landmark[], minVisibility = 0.3): Box | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let count = 0;
  for (const [x, y, visibility] of landmarks) {
    if (visibility < minVisibility) continue;
    count++;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (count < MIN_POINTS) return null;
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY };
}

/** Intersection over union of two boxes, 0 to 1. */
export function iou(a: Box, b: Box): number {
  const overlapW = Math.min(a.cx + a.w / 2, b.cx + b.w / 2) - Math.max(a.cx - a.w / 2, b.cx - b.w / 2);
  const overlapH = Math.min(a.cy + a.h / 2, b.cy + b.h / 2) - Math.max(a.cy - a.h / 2, b.cy - b.h / 2);
  if (overlapW <= 0 || overlapH <= 0) return 0;
  const intersection = overlapW * overlapH;
  const union = a.w * a.h + b.w * b.h - intersection;
  return union > 0 ? intersection / union : 0;
}
