import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLevel, MIN_SPACING_SECONDS, TARGET_MOMENTS } from "./level.mjs";
import { comparePoses } from "./score.mjs";
import { makeSequenceTimeline, makeStickPose, POSES } from "./synthetic.mjs";

const matchesPose = (landmarks, name) => comparePoses(makeStickPose(POSES[name]), landmarks, { mirror: false }).score > 0.999;

test("a timeline holding 4 distinct poses yields those 4", () => {
  const names = ["armsUp", "tPose", "squat", "leanRight"];
  const timeline = makeSequenceTimeline(names, { holdSeconds: 2, moveSeconds: 0.8 });
  const { moments, usedFallback } = buildLevel(timeline);
  assert.equal(usedFallback, false);
  assert.equal(moments.length, 4);
  moments.forEach((m, i) => assert.ok(matchesPose(m.landmarks, names[i]), "moment " + i + " at " + m.t + " is not " + names[i]));
});

test("a static timeline falls back to evenly spaced moments", () => {
  const still = makeStickPose(POSES.rest);
  const timeline = Array.from({ length: 240 }, (_, i) => ({ t: i / 12, landmarks: still }));
  const { moments, usedFallback } = buildLevel(timeline);
  assert.equal(usedFallback, true);
  assert.equal(moments.length, TARGET_MOMENTS);
  const gaps = moments.slice(1).map((m, i) => m.t - moments[i].t);
  for (const gap of gaps) assert.ok(Math.abs(gap - gaps[0]) < 0.2, "uneven gaps " + gaps.join(", "));
});

test("spacing between key moments is respected", () => {
  const names = ["armsUp", "tPose", "squat", "leanRight", "leftArmUp", "rest", "armsUp", "squat", "tPose", "leanRight", "leftArmUp", "rest"];
  const timeline = makeSequenceTimeline(names, { holdSeconds: 0.7, moveSeconds: 0.3 });
  const { moments } = buildLevel(timeline);
  assert.ok(moments.length >= 4);
  for (let i = 1; i < moments.length; i++) {
    assert.ok(moments[i].t - moments[i - 1].t >= MIN_SPACING_SECONDS - 1e-9, "gap at " + i);
  }
});
