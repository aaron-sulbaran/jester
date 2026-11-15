import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoxTrack } from "../../engine/src/types.ts";
import { partsWorthOffering } from "../src/partChoices.ts";

/** A role's path over 8 seconds at 15 frames a second, its box centre at `cxAt(seconds)`. */
function track(cxAt: (s: number) => number): BoxTrack {
  return {
    schema: "box-track/1",
    source: { width: 720, height: 1280 },
    frames: Array.from({ length: 120 }, (_, i) => ({ tMs: (i * 1000) / 15, box: { cx: cxAt(i / 15), cy: 0.55, w: 0.25, h: 0.6 } })),
  };
}

test("a role who travels across the frame can be copied with every body part", () => {
  const travels = track((s) => 0.5 + 0.25 * Math.sin((2 * Math.PI * s) / 2));
  assert.deepEqual(partsWorthOffering(travels), ["body", "rightHand", "leftHand", "head", "rightFoot", "leftFoot"]);
});

test("a role who dances in one place is offered the whole body only", () => {
  const inPlace = track((s) => 0.5 + 0.005 * Math.sin(7 * s));
  assert.deepEqual(partsWorthOffering(inPlace), ["body"]);
});
