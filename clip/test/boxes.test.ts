import assert from "node:assert/strict";
import { test } from "node:test";
import { boxFromLandmarks, iou } from "../src/index.ts";
import type { Landmark } from "../../engine/src/index.ts";

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test("boxFromLandmarks: wraps known points", () => {
  const points: Landmark[] = [[0.2, 0.1, 1], [0.6, 0.1, 1], [0.2, 0.9, 1], [0.6, 0.9, 1], [0.4, 0.5, 1]];
  const box = boxFromLandmarks(points)!;
  near(box.cx, 0.4);
  near(box.cy, 0.5);
  near(box.w, 0.4);
  near(box.h, 0.8);
});

test("boxFromLandmarks: ignores points below the visibility floor", () => {
  const points: Landmark[] = [[0.2, 0.1, 1], [0.6, 0.1, 1], [0.2, 0.9, 1], [0.6, 0.9, 1], [0.99, 0.99, 0.1]];
  const box = boxFromLandmarks(points)!;
  near(box.w, 0.4);
  near(box.h, 0.8);
});

test("boxFromLandmarks: null when fewer than 4 points qualify", () => {
  const points: Landmark[] = [[0.2, 0.1, 1], [0.6, 0.1, 1], [0.2, 0.9, 1], [0.6, 0.9, 0.2]];
  assert.equal(boxFromLandmarks(points), null);
  assert.ok(boxFromLandmarks(points, 0.1));
});

test("iou: identical boxes are 1, disjoint are 0, half-offset unit squares are 1/3", () => {
  const a = { cx: 0.5, cy: 0.5, w: 1, h: 1 };
  near(iou(a, a), 1);
  assert.equal(iou(a, { cx: 5, cy: 5, w: 1, h: 1 }), 0);
  near(iou(a, { cx: 1, cy: 0.5, w: 1, h: 1 }), 1 / 3);
});
