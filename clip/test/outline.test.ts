import assert from "node:assert/strict";
import { test } from "node:test";
import { largestBlobInBox } from "../src/index.ts";
import type { BinaryMask } from "../src/index.ts";

/** A 20 by 20 mask with the given filled rectangles (inclusive pixel bounds). */
function maskWith(rects: [number, number, number, number][]): BinaryMask {
  const data = new Uint8Array(400);
  for (const [x0, y0, x1, y1] of rects) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) data[y * 20 + x] = 1;
  return { width: 20, height: 20, data };
}

const count = (mask: BinaryMask) => mask.data.reduce((sum, v) => sum + v, 0);

test("largestBlobInBox: keeps the largest blob near the box and drops a speck", () => {
  const mask = maskWith([[6, 4, 11, 15], [2, 2, 2, 2]]);
  const kept = largestBlobInBox(mask, { cx: 0.45, cy: 0.5, w: 0.3, h: 0.5 })!;
  assert.equal(count(kept), 6 * 12);
  assert.equal(kept.data[2 * 20 + 2], 0);
});

test("largestBlobInBox: another person outside the widened box is dropped", () => {
  const mask = maskWith([[1, 4, 4, 15], [12, 4, 18, 15]]);
  const kept = largestBlobInBox(mask, { cx: 0.15, cy: 0.5, w: 0.15, h: 0.55 })!;
  assert.equal(count(kept), 4 * 12);
  assert.equal(kept.data[10 * 20 + 15], 0);
});

test("largestBlobInBox: an empty area gives null", () => {
  assert.equal(largestBlobInBox(maskWith([[15, 15, 18, 18]]), { cx: 0.2, cy: 0.2, w: 0.1, h: 0.1 }), null);
});
