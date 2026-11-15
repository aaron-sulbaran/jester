import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_CAMERA_AGE_MS, stampAt } from "../src/stamp.ts";

test("stampAt: a pose is stamped with the clip time its camera frame was taken", () => {
  // Tracking finished at 10 180 ms; the frame was taken at 10 000 ms, so 180 ms earlier on the clip.
  assert.equal(stampAt(5000, 10180, 10000), 4820);
});

test("stampAt: no capture time, or before the clip starts, keeps the clock as is", () => {
  assert.equal(stampAt(5000, 10180, -1), 5000);
  assert.equal(stampAt(-1, 10180, 10000), -1);
});

test("stampAt: a frame taken before the clip started stays before it", () => {
  assert.equal(stampAt(50, 10180, 10000), -1);
});

test("stampAt: a glitched or future capture time is capped", () => {
  assert.equal(stampAt(5000, 20000, 10000), 5000 - MAX_CAMERA_AGE_MS);
  assert.equal(stampAt(5000, 10000, 10100), 5000);
});
