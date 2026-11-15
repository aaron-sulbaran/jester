import assert from "node:assert/strict";
import { test } from "node:test";
import { hideUnsureJoints, UNSURE_RADIUS } from "../src/index.ts";
import type { PoseTimeline } from "../../engine/src/index.ts";

/** A timeline of `n` frames whose joint 0 has visibility `vis(i)` and every other joint 0.9. */
function timeline(n: number, vis: (i: number) => number, empty: number[] = []): PoseTimeline {
  return {
    schema: "pose-timeline/1",
    source: { width: 100, height: 100, mirrored: false },
    frames: Array.from({ length: n }, (_, i) => ({
      tMs: i * 66,
      landmarks: empty.includes(i) ? null : Array.from({ length: 33 }, (_, k) => [0.5, 0.5, k === 0 ? vis(i) : 0.9] as const),
    })),
  };
}

test("hideUnsureJoints: a joint unsure for a long while is hidden, a brief dip is not", () => {
  const out = hideUnsureJoints(timeline(60, (i) => (i < 30 ? 0.1 : i === 45 ? 0.1 : 0.8)));
  // Hidden where every frame within the radius is unsure.
  for (let i = 0; i < 30 - UNSURE_RADIUS; i++) assert.equal(out.frames[i]!.landmarks![0]![2], 0, `frame ${i}`);
  // Shown near the sure stretch and through the one-frame dip.
  for (let i = 30 - UNSURE_RADIUS; i < 60; i++) assert.ok(out.frames[i]!.landmarks![0]![2] > 0, `frame ${i}`);
  // Other joints and positions are untouched.
  assert.equal(out.frames[3]!.landmarks![5]![2], 0.9);
  assert.equal(out.frames[3]!.landmarks![0]![0], 0.5);
});

test("hideUnsureJoints: never looks across a frame with no person", () => {
  // Sure on frames 0 to 9, a gap at 10, unsure after: the frames after the gap are hidden right away.
  const out = hideUnsureJoints(timeline(30, (i) => (i < 10 ? 0.9 : 0.1), [10]));
  assert.equal(out.frames[10]!.landmarks, null);
  assert.equal(out.frames[11]!.landmarks![0]![2], 0);
  assert.equal(out.frames[9]!.landmarks![0]![2], 0.9);
});
