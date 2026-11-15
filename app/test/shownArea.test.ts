import assert from "node:assert/strict";
import { test } from "node:test";
import { shownArea } from "../src/clipside/shownArea.ts";

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 0.01, `${a} is not ${b}`);

test("cover crops a wide canvas in a tall box: only the middle shows, and a CSS pixel is several canvas pixels", () => {
  // The part screen on a phone: a 640x480 guide canvas in a 203x270 box.
  const a = shownArea(640, 480, 203, 270, "cover");
  near(a.sx, 480 / 270); near(a.sy, 480 / 270);
  near(a.w, 203 * (480 / 270)); near(a.x, (640 - a.w) / 2);
  near(a.y, 0); near(a.h, 480);
  // The box's middle is the canvas's middle.
  near(a.offX + (203 / 2) * a.sx, 320);
});

test("contain shows the whole canvas, scaled by the tighter side", () => {
  const a = shownArea(640, 480, 400, 400, "contain");
  near(a.sx, 1.6); near(a.x, 0); near(a.w, 640); near(a.y, 0); near(a.h, 480);
});

test("fill stretches each side on its own", () => {
  const a = shownArea(640, 480, 320, 120, "fill");
  near(a.sx, 2); near(a.sy, 4); near(a.x, 0); near(a.w, 640);
});

test("before layout (an empty box) the whole canvas counts, one canvas pixel to a CSS pixel", () => {
  const a = shownArea(640, 480, 0, 0, "cover");
  assert.deepEqual([a.x, a.y, a.w, a.h, a.sx, a.sy], [0, 0, 640, 480, 1, 1]);
});
