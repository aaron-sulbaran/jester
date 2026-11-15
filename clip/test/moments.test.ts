import assert from "node:assert/strict";
import { test } from "node:test";
import { comparePoses } from "../../engine/src/index.ts";
import { keyMoments, paceOf } from "../src/index.ts";
import type { Track } from "../src/index.ts";
import { POSES, range, sequenceTimeline, trackOf } from "./synth.ts";
import { landmarks } from "../../engine/test/synth.ts";

const frameAt = (timeline: ReturnType<typeof sequenceTimeline>, tMs: number) =>
  timeline.frames.reduce((best, f) => (Math.abs(f.tMs - tMs) < Math.abs(best.tMs - tMs) ? f : best));

test("keyMoments: a timeline holding 4 distinct poses yields those 4, in order", () => {
  const names = ["armsUp", "tPose", "squat", "leanRight"];
  const timeline = sequenceTimeline(names, { holdMs: 2000, moveMs: 800 });
  const moments = keyMoments(timeline);
  assert.equal(moments.length, 4);
  moments.forEach((moment, i) => {
    const held = frameAt(timeline, moment.tMs).landmarks;
    const credit = comparePoses(landmarks(POSES[names[i]!]!, 1), held, { mirror: false }).credit;
    assert.ok(credit !== null && credit > 0.99, `moment ${i} at ${moment.tMs} ms is not ${names[i]}`);
  });
});

test("keyMoments: a static timeline falls back to 8 evenly spaced moments", () => {
  const still = landmarks(POSES.rest!, 1);
  const frames = Array.from({ length: 240 }, (_, i) => ({ tMs: Math.round((i * 1000) / 12), landmarks: still }));
  const moments = keyMoments({ schema: "pose-timeline/1", source: { width: 1000, height: 1000, mirrored: false }, frames });
  assert.equal(moments.length, 8);
  const gaps = moments.slice(1).map((m, i) => m.tMs - moments[i]!.tMs);
  for (const gap of gaps) assert.ok(Math.abs(gap - gaps[0]!) < 200, `uneven gaps ${gaps.join(", ")}`);
});

test("keyMoments: spacing between moments is at least 1.2 seconds and there are 4 to 8", () => {
  const names = ["armsUp", "tPose", "squat", "leanRight", "leftArmUp", "rest", "armsUp", "squat", "tPose", "leanRight", "leftArmUp", "rest"];
  const moments = keyMoments(sequenceTimeline(names, { holdMs: 700, moveMs: 300 }));
  assert.ok(moments.length >= 4 && moments.length <= 8, `got ${moments.length}`);
  for (let i = 1; i < moments.length; i++) {
    assert.ok(moments[i]!.tMs - moments[i - 1]!.tMs >= 1200 - 1e-9, `gap at ${i}`);
  }
});

test("keyMoments: frames with no pose are ignored, and an empty timeline has no moments", () => {
  const empty = { schema: "pose-timeline/1" as const, source: { width: 1000, height: 1000, mirrored: false }, frames: [] };
  assert.deepEqual(keyMoments(empty), []);
  const blanks = { ...empty, frames: [{ tMs: 1000, landmarks: null }, { tMs: 2000, landmarks: null }] };
  assert.deepEqual(keyMoments(blanks), []);
});

// Box height 0.5 at 10 samples per second: moving `perSecond` box heights per second means the box
// shifts perSecond * 0.5 / 10 of the width each frame.
const movingTrack = (perSecond: number): Track =>
  trackOf(0, range(0, 20), (f) => ({ cx: 0.1 + (f * perSecond * 0.5) / 10, cy: 0.5, w: 0.25, h: 0.5 }));

test("paceOf: under 0.3 box heights per second is slow, under 1.0 medium, otherwise fast", () => {
  assert.equal(paceOf(movingTrack(0.1), 10), "slow");
  assert.equal(paceOf(movingTrack(0.28), 10), "slow");
  assert.equal(paceOf(movingTrack(0.32), 10), "medium");
  assert.equal(paceOf(movingTrack(0.96), 10), "medium");
  assert.equal(paceOf(movingTrack(1.04), 10), "fast");
  assert.equal(paceOf(movingTrack(2), 10), "fast");
});

test("paceOf: a track that does not move is slow", () => {
  assert.equal(paceOf(trackOf(0, range(0, 20), () => ({ cx: 0.5, cy: 0.5, w: 0.25, h: 0.5 })), 10), "slow");
});

