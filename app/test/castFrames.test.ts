// Run from app/: npm test. The cast checker's frame sampling and its "same place, contents change" check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boxAt, changeFlags, cropRect, meanAbsDiff, samePlace, sampleTimes } from "../castFrames.ts";

test("sampleTimes: the middle of each equal slice of the stretch", () => {
  assert.deepEqual(sampleTimes({ startMs: 0, endMs: 12000 }, 12), [500, 1500, 2500, 3500, 4500, 5500, 6500, 7500, 8500, 9500, 10500, 11500]);
  assert.deepEqual(sampleTimes({ startMs: 1000, endMs: 3000 }, 4), [1250, 1750, 2250, 2750]);
  assert.deepEqual(sampleTimes({ startMs: 0, endMs: 0 }, 12), []);
});

test("boxAt: the nearest box-track frame, null where unseen or too far away", () => {
  const a = { cx: 0.5, cy: 0.5, w: 0.2, h: 0.4 };
  const frames = [{ tMs: 0, box: null }, { tMs: 66.7, box: a }, { tMs: 133.3, box: null }, { tMs: 1000, box: a }];
  assert.equal(boxAt(frames, 70), a);
  assert.equal(boxAt(frames, 130), null);
  assert.equal(boxAt(frames, 600), null, "nothing within 100 ms");
  assert.equal(boxAt(frames, 950), a);
});

test("cropRect: padded, kept inside the frame, even sizes", () => {
  const r = cropRect({ cx: 0.5, cy: 0.5, w: 0.2, h: 0.4 }, { width: 1000, height: 1000 }, 0.2);
  assert.deepEqual(r, { x: 360, y: 220, w: 280, h: 560 });
  const edge = cropRect({ cx: 0.95, cy: 0.05, w: 0.3, h: 0.3 }, { width: 576, height: 1024 }, 0.2);
  assert.ok(edge.x >= 0 && edge.y >= 0 && edge.x + edge.w <= 576 && edge.y + edge.h <= 1024);
  assert.equal(edge.w % 2, 0);
  assert.equal(edge.h % 2, 0);
  const tight = cropRect({ cx: 0.5, cy: 0.5, w: 0.2, h: 0.4 }, { width: 1000, height: 1000 }, 0);
  assert.deepEqual(tight, { x: 400, y: 300, w: 200, h: 400 });
});

test("meanAbsDiff and samePlace", () => {
  assert.equal(meanAbsDiff(new Uint8Array([0, 0, 0, 0]), new Uint8Array([0, 0, 0, 0])), 0);
  assert.equal(meanAbsDiff(new Uint8Array([0, 100, 200, 50]), new Uint8Array([10, 90, 250, 50])), 17.5);
  const car = { cx: 0.8, cy: 0.6, w: 0.3, h: 0.2 };
  assert.ok(samePlace(car, { ...car, cx: 0.83 }));
  assert.ok(!samePlace(car, { ...car, cx: 0.5 }), "moved across the frame");
  assert.ok(!samePlace(car, { ...car, w: 0.6 }), "twice as wide");
});

test("changeFlags: a box that stays put while the picture inside it changes", () => {
  const tv = { cx: 0.3, cy: 0.3, w: 0.2, h: 0.15 };
  const dark = new Uint8Array(256).fill(20), bright = new Uint8Array(256).fill(200), nearDark = new Uint8Array(256).fill(30);
  const flags = changeFlags("TV 1", [
    { tMs: 500, box: tv, thumb: dark },
    { tMs: 1500, box: tv, thumb: nearDark },
    { tMs: 2500, box: tv, thumb: bright },
    { tMs: 3500, box: null, thumb: null },
    { tMs: 4500, box: { ...tv, cx: 0.8 }, thumb: dark },
  ]);
  assert.deepEqual(flags, [{ label: "TV 1", fromS: 1.5, toS: 2.5, diff: 170 }], "the move across the frame is not a change in place");
  assert.deepEqual(changeFlags("Car 1", [{ tMs: 0, box: tv, thumb: dark }, { tMs: 1000, box: tv, thumb: nearDark }]), []);
});
