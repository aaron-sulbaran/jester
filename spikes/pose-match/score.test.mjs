import { test } from "node:test";
import assert from "node:assert/strict";
import { comparePoses, mirrorPose, rate, weakestLimb, feedbackLine, totalScore, LANDMARK, RATING_THRESHOLDS } from "./score.mjs";
import { makeStickPose, POSES } from "./synthetic.mjs";

const tPose = makeStickPose(POSES.tPose);
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, a + " is not close to " + b);

test("identical poses score 1", () => {
  const result = comparePoses(tPose, tPose, { mirror: false });
  close(result.score, 1);
  assert.equal(result.usedLimbs, 11);
});

test("a mirrored copy scores 1 with mirroring on", () => {
  const asymmetric = makeStickPose(POSES.leftArmUp);
  const playerFacingScreen = mirrorPose(asymmetric);
  close(comparePoses(asymmetric, playerFacingScreen, { mirror: true }).score, 1);
  assert.ok(comparePoses(asymmetric, playerFacingScreen, { mirror: false }).score < 0.95);
});

test("mirroring twice returns the original pose", () => {
  const pose = makeStickPose(POSES.leanRight);
  assert.deepEqual(mirrorPose(mirrorPose(pose)).map((p) => [p.x.toFixed(9), p.y]), pose.map((p) => [p.x.toFixed(9), p.y]));
});

test("one arm rotated 90 degrees lowers the score and is the weakest limb", () => {
  const rotated = makeStickPose({ ...POSES.tPose, leftUpperArm: 0, leftForearm: 0 });
  const result = comparePoses(tPose, rotated, { mirror: false });
  assert.ok(result.score < 0.95, "score was " + result.score);
  assert.ok(["leftUpperArm", "leftForearm"].includes(weakestLimb(result)));
  close(result.perLimb.leftUpperArm.similarity, 0.5);
  assert.equal(feedbackLine([result]), "Your left upper arm was low.");
});

test("uniform scaling and translation do not change the score", () => {
  const reference = makeStickPose(POSES.squat);
  const moved = makeStickPose(POSES.squat, { centerX: 0.3, groundY: 0.7, scale: 0.5 });
  close(comparePoses(reference, moved, { mirror: false }).score, 1);
});

test("aspect ratio is corrected per source", () => {
  const wide = makeStickPose(POSES.tPose, { aspect: 16 / 9 });
  const tall = makeStickPose(POSES.tPose, { aspect: 9 / 16 });
  close(comparePoses(wide, tall, { mirror: false, referenceAspect: 16 / 9, playerAspect: 9 / 16 }).score, 1);
  assert.ok(comparePoses(wide, tall, { mirror: false }).score < 0.999);
});

test("low visibility limbs are skipped", () => {
  const hidden = makeStickPose({ ...POSES.tPose, leftUpperArm: 0, leftForearm: 0 });
  hidden[LANDMARK.leftElbow].visibility = 0.1;
  const result = comparePoses(tPose, hidden, { mirror: false });
  assert.equal(result.perLimb.leftUpperArm, undefined);
  assert.equal(result.perLimb.leftForearm, undefined);
  assert.equal(result.usedLimbs, 9);
  close(result.score, 1);
});

test("too few visible limbs returns a null score", () => {
  const mostlyHidden = tPose.map((lm) => ({ ...lm, visibility: 0.1 }));
  for (const i of [LANDMARK.leftShoulder, LANDMARK.rightShoulder, LANDMARK.leftElbow]) mostlyHidden[i].visibility = 1;
  const result = comparePoses(tPose, mostlyHidden, { mirror: false });
  assert.equal(result.score, null);
  assert.equal(rate(result.score), "Miss");
});

test("rate maps scores to named tiers", () => {
  assert.equal(rate(1), "Perfect");
  assert.equal(rate(RATING_THRESHOLDS.Great), "Great");
  assert.equal(rate(RATING_THRESHOLDS.OK), "OK");
  assert.equal(rate(0.2), "Miss");
  assert.equal(totalScore(["Perfect", "Miss"]), 50);
});
