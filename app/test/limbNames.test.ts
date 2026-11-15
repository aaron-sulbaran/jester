import assert from "node:assert/strict";
import { test } from "node:test";
import { listLabels, playerSideLabel } from "../src/limbNames.ts";

test("a mirror copy names limbs from the player's own, opposite side", () => {
  assert.equal(playerSideLabel("leftForearm"), "right forearm");
  assert.equal(playerSideLabel("rightUpperArm", "mirror"), "left upper arm");
});

test("a same-side copy keeps the performer's side words", () => {
  assert.equal(playerSideLabel("leftForearm", "same-side"), "left forearm");
  assert.equal(listLabels(["leftForearm", "rightShin"], "same-side"), "left forearm and right shin");
  assert.equal(listLabels(["leftForearm", "rightShin"], "mirror"), "right forearm and left shin");
});

test("all four leg parts still read as legs", () => {
  assert.equal(listLabels(["leftThigh", "rightThigh", "leftShin", "rightShin"], "same-side"), "legs");
});
