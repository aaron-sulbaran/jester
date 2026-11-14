import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFraming, Calibrator, playerStance, placementHint } from "./calibration.mjs";
import { makeStickPose, POSES } from "./synthetic.mjs";

const full = makeStickPose(POSES.rest);
const hideLegs = (pose) => pose.map((p, i) => ([25, 26, 27, 28].includes(i) ? { ...p, visibility: 0.1 } : p));

test("full body in frame passes framing", () => { assert.equal(checkFraming(full).ok, true); });

test("legs out of view says step back for knees and ankles", () => {
  const r = checkFraming(hideLegs(full));
  assert.equal(r.ok, false);
  assert.ok(r.missing.includes("leftAnkle"));
  assert.match(r.message, /knees and ankles/);
});

test("no body found asks the player to step in", () => {
  const r = checkFraming(null);
  assert.equal(r.ok, false);
  assert.match(r.message, /frame/);
});

test("joint off the bottom of the image counts as missing", () => {
  const low = full.map((p, i) => (i === 27 ? { ...p, y: 1.2 } : p));
  assert.ok(checkFraming(low).missing.includes("leftAnkle"));
});

test("calibrator passes after enough good frames and resets on a bad one", () => {
  const c = new Calibrator({ holdFrames: 5 });
  for (let i = 0; i < 4; i++) assert.equal(c.update(full).passed, false);
  c.update(hideLegs(full));
  assert.equal(c.good, 0);
  let last;
  for (let i = 0; i < 5; i++) last = c.update(full);
  assert.equal(last.passed, true);
  assert.equal(last.progress, 1);
});

test("low fps suggests the lite model", () => {
  assert.equal(new Calibrator().update(full, 10).model, "lite");
  assert.equal(new Calibrator().update(full, 30).model, "full");
});

test("placement: matching stance is ok, offsets give the player's own left or right", () => {
  const ref = { x: 0.5, y: 0.5, torso: 0.3 };
  assert.equal(placementHint({ x: 0.5, y: 0.5, torso: 0.3 }, ref).hint, "ok");
  // raw x 0.8 shows at 0.2 on the mirror view, left of the clip subject, so move right
  assert.equal(placementHint({ x: 0.8, y: 0.5, torso: 0.3 }, ref).hint, "move right");
  assert.equal(placementHint({ x: 0.2, y: 0.5, torso: 0.3 }, ref).hint, "move left");
});

test("placement: size beats position", () => {
  const ref = { x: 0.5, y: 0.5, torso: 0.3 };
  assert.equal(placementHint({ x: 0.5, y: 0.5, torso: 0.45 }, ref).hint, "step back");
  assert.equal(placementHint({ x: 0.5, y: 0.5, torso: 0.15 }, ref).hint, "step closer");
});

test("stance reads hip centre and torso length from a pose", () => {
  const s = playerStance(full);
  assert.ok(s.torso > 0.2 && s.torso < 0.4, "torso " + s.torso);
  assert.equal(playerStance(null), null);
});
