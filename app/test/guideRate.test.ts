import assert from "node:assert/strict";
import { test } from "node:test";
import { steadyFps, typicalMs } from "../src/clipside/guideRate.ts";

const frames = (n: number, ms: number) => new Array<number>(n).fill(ms);

test("one long stall (the camera tracker warming up) does not pull a 60 fps page under the guide's floor", () => {
  const gaps = [...frames(10, 16.7), 1000, ...frames(10, 16.7)];
  assert.ok(steadyFps(gaps) > 55);
});

test("a page that is slow on every frame (software rendering) still reads as slow", () => {
  assert.ok(steadyFps(frames(20, 75)) < 15);
});

test("a page running with the tracker at 30 to 45 fps stays above 20", () => {
  const gaps = [33, 25, 22, 28, 30, 24, 26, 31, 23, 29, 27, 25, 34, 22, 26, 28, 30, 25, 24, 27];
  assert.ok(steadyFps(gaps) > 30);
});

test("the typical draw time ignores one slow draw but not a slow run", () => {
  assert.equal(typicalMs([0.5, 0.6, 40, 0.5, 0.7]), 0.6);
  assert.equal(typicalMs([9, 8, 10]), 9);
});
