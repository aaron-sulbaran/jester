import { test } from "node:test";
import assert from "node:assert/strict";
import { stance, displayedHeight, scaleView, SizeMatcher } from "./fit.mjs";
import { makeStickPose, POSES } from "./synthetic.mjs";

test("stance reads torso length and hip centre from objects and from tuples", () => {
  const pose = makeStickPose(POSES.rest);
  const a = stance(pose, 640, 480);
  const b = stance(pose.map((p) => [p.x, p.y, p.visibility ?? 1]), 640, 480);
  assert.ok(a.torso > 50 && a.torso < 250);
  assert.deepEqual(a, b);
  assert.equal(stance(pose.map((p, i) => (i === 23 ? { ...p, visibility: 0.1 } : p)), 640, 480), null);
  assert.equal(stance(null, 1, 1), null);
});

test("a figure twice as close has a torso twice as long", () => {
  const pose = makeStickPose(POSES.rest);
  const hip = stance(pose, 1, 1);
  const bigger = pose.map((p) => ({ ...p, x: 0.5 + (p.x - hip.hipX) * 2, y: 0.5 + (p.y - hip.hipY) * 2 }));
  assert.ok(Math.abs(stance(bigger, 1, 1).torso / hip.torso - 2) < 1e-9);
});

test("displayed height follows contain and cover", () => {
  // a 4:3 canvas in a 16:9 box 1600x900
  assert.equal(Math.round(displayedHeight(1600, 900, 640, 480, "contain")), 900);   // height limited
  assert.equal(Math.round(displayedHeight(1600, 900, 640, 480, "cover")), 1200);   // width limited, crops top and bottom
  // a tall 9:16 canvas in the same box
  assert.equal(Math.round(displayedHeight(1600, 900, 540, 960, "contain")), 900);
});

test("scaleView keeps the anchor point fixed", () => {
  const v = { scale: 1, offsetX: 100, offsetY: 50 };
  const w = scaleView(v, 2, 300, 200);
  // the anchor in view coordinates: x*scale+offset
  const before = (300 - v.offsetX) / v.scale, after = (300 - w.offsetX) / w.scale;
  assert.ok(Math.abs(before - after) < 1e-9);
  assert.equal(w.scale, 2);
});

test("size matcher converges to the ratio, stays in range, and ignores bad input", () => {
  const m = new SizeMatcher();
  let k = 1;
  for (let i = 0; i < 200; i++) k = m.update(200, 100); // the guide is 100 px at base scale; the player is 200 px
  assert.ok(Math.abs(k - 2) < 0.05, "k " + k);
  const m2 = new SizeMatcher();
  for (let i = 0; i < 500; i++) m2.update(1000, 10);
  assert.ok(m2.k <= 2.5 + 1e-9);
  const before = m2.k;
  assert.equal(m2.update(0, 10), before);
  assert.equal(m2.update(10, NaN), before);
});
