import assert from "node:assert/strict";
import { test } from "node:test";
import { isJump, largestStep, outlineOffBox, steadyMarks, type MarkBox, type MarkPoint } from "../src/markerSteady.ts";

const box = (cx: number, cy = 0.5, h = 0.6, w = 0.2): MarkBox => ({ cx, cy, w, h });
const square = (b: MarkBox): MarkPoint[] => [[b.cx - b.w / 2, b.cy - b.h / 2], [b.cx + b.w / 2, b.cy - b.h / 2], [b.cx + b.w / 2, b.cy + b.h / 2], [b.cx - b.w / 2, b.cy + b.h / 2]];

test("a person's own step is not a jump; a hop to someone across the frame is", () => {
  assert.equal(isJump(box(0.3), box(0.32), 1, 15, 1), false);
  assert.equal(isJump(box(0.3), box(0.7), 1, 15, 1), true);
  // The same distance over a second is a walk.
  assert.equal(isJump(box(0.3), box(0.7), 15, 15, 1), false);
});

test("a short hop to the other fighter and back glides instead of snapping", () => {
  // Our fighter at 0.3, drifting right; for frames 5 to 7 the track lands on the other fighter at 0.75.
  const boxes = Array.from({ length: 14 }, (_, i) => box(i >= 5 && i <= 7 ? 0.75 : 0.3 + i * 0.002));
  const outlines = boxes.map((b) => square(b));
  const before = largestStep(boxes, 1);
  const m = steadyMarks({ boxes, outlines }, 15, 1);
  const after = largestStep(m.boxes, 1);
  assert.ok(before > 0.4, `before ${before}`);
  assert.ok(after < 0.01, `after ${after}`);
  assert.deepEqual(m.held.map((h, i) => (h ? i : -1)).filter((i) => i >= 0), [5, 6, 7]);
  // The outline in the held frames is our fighter's, never the other one's.
  for (const i of [5, 6, 7]) assert.ok(m.outlines[i]!.every(([x]) => x < 0.5), `frame ${i}`);
});

test("a move that does not come back is kept (it is what the turn is scored on)", () => {
  const boxes = Array.from({ length: 30 }, (_, i) => box(i < 10 ? 0.3 : 0.75));
  const m = steadyMarks({ boxes, outlines: boxes.map(() => null) }, 15, 1);
  assert.equal(m.boxes[20]!.cx, 0.75);
  assert.equal(m.held.some(Boolean), false);
});

test("skeletons glide across a jump too", () => {
  const pose = (x: number) => Array.from({ length: 33 }, () => [x, 0.5, 1] as const);
  const xs = [0.3, 0.3, 0.3, 0.8, 0.3, 0.3];
  const m = steadyMarks({ boxes: xs.map((x) => box(x)), outlines: xs.map(() => null), landmarks: xs.map((x) => pose(x)) }, 15, 1);
  assert.ok(Math.abs(m.landmarks![3]![0]![0] - 0.3) < 1e-9);
});

test("an outline of someone else, or of two people, is swapped for the last good one", () => {
  const b = box(0.3);
  assert.equal(outlineOffBox(square(b), b, 1), false);
  assert.equal(outlineOffBox(square(box(0.7)), b, 1), true);
  assert.equal(outlineOffBox(square({ ...b, w: 0.8 }), b, 1), true);
  const boxes = [b, b, b, b];
  const outlines = [square(b), square(b), square(box(0.7)), square(b)];
  const m = steadyMarks({ boxes, outlines }, 15, 1);
  assert.ok(m.outlines[2]!.every(([x]) => x < 0.5));
});

test("frames with a box but no outline borrow the nearest good outline, so the marker does not flick", () => {
  const boxes = [box(0.3), box(0.31), box(0.32), box(0.33)];
  const m = steadyMarks({ boxes, outlines: [square(boxes[0]!), null, null, square(boxes[3]!)] }, 15, 1);
  assert.ok(m.outlines.every((o) => o !== null));
  // Moved with the box.
  const mid = (o: MarkPoint[]) => (Math.min(...o.map((p) => p[0])) + Math.max(...o.map((p) => p[0]))) / 2;
  assert.ok(Math.abs(mid(m.outlines[1]!) - 0.31) < 1e-9);
});
