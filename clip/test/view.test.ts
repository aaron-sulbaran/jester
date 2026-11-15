import assert from "node:assert/strict";
import { test } from "node:test";
import { placeSubject } from "../src/index.ts";
import type { Box, ClipSource, Guide } from "../src/index.ts";

const source: ClipSource = { width: 1280, height: 720, durationMs: 1000, sampleHz: 10 };

function guideOf(boxes: (Box | null)[]): Pick<Guide, "source" | "boxTrack" | "outlines"> {
  return {
    source,
    boxTrack: { schema: "box-track/1", source: { width: 1280, height: 720 }, frames: boxes.map((box, i) => ({ tMs: i * 100, box })) },
    outlines: boxes.map(() => null),
  };
}

test("placeSubject: exact fits the whole frame into the canvas, centred", () => {
  const view = placeSubject(guideOf([{ cx: 0.3, cy: 0.5, w: 0.2, h: 0.5 }]), { width: 400, height: 300 }, "exact");
  assert.equal(view.scale, 400 / 1280);
  assert.equal(view.offsetX, 0);
  assert.equal(view.offsetY, (300 - 720 * (400 / 1280)) / 2);
});

test("placeSubject: fit centres a still subject and makes it 70 percent of the canvas height", () => {
  const box = { cx: 0.3, cy: 0.5, w: 0.1, h: 0.5 };
  const view = placeSubject(guideOf([box, box, null]), { width: 400, height: 300 }, "fit");
  assert.ok(Math.abs(view.scale * 0.5 * 720 - 0.7 * 300) < 1e-9);
  assert.ok(Math.abs(0.3 * 1280 * view.scale + view.offsetX - 200) < 1e-9);
  assert.ok(Math.abs(0.5 * 720 * view.scale + view.offsetY - 150) < 1e-9);
});

test("placeSubject: fit shrinks a subject that moves a lot so all of its movement stays on the canvas", () => {
  const boxes = [0.1, 0.5, 0.9].map((cx) => ({ cx, cy: 0.5, w: 0.1, h: 0.5 }));
  const view = placeSubject(guideOf(boxes), { width: 400, height: 300 }, "fit");
  for (const b of boxes) {
    assert.ok((b.cx - b.w / 2) * 1280 * view.scale + view.offsetX >= 0);
    assert.ok((b.cx + b.w / 2) * 1280 * view.scale + view.offsetX <= 400);
  }
});
