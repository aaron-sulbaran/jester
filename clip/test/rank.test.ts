import assert from "node:assert/strict";
import { test } from "node:test";
import { motionPerFrame, pickConfirmFrame, rankCandidates, withConfirmBoxes } from "../src/index.ts";
import type { Box } from "../src/index.ts";
import { range, trackOf } from "./synth.ts";

const still = (cx: number, h = 0.5) => (): Box => ({ cx, cy: 0.5, w: h / 2, h });
const info = { sampleHz: 10, frameCount: 40 };

test("motionPerFrame: a box moving 0.05 of the width per frame at height 0.5 moves 0.1 box heights per frame", () => {
  const track = trackOf(0, range(0, 10), (f) => ({ cx: 0.2 + f * 0.05, cy: 0.5, w: 0.25, h: 0.5 }));
  assert.ok(Math.abs(motionPerFrame(track) - 0.1) < 1e-9);
});

test("motionPerFrame: a still track and a one point track are 0", () => {
  assert.equal(motionPerFrame(trackOf(0, range(0, 10), still(0.5))), 0);
  assert.equal(motionPerFrame(trackOf(0, [3], still(0.5))), 0);
});

test("rankCandidates: tracks shorter than sampleHz points are dropped", () => {
  const short = trackOf(0, range(0, 9), still(0.5));
  const long = trackOf(1, range(0, 10), still(0.5));
  const ranked = rankCandidates([short, long], info);
  assert.deepEqual(ranked.map((c) => c.trackId), [1]);
});

test("rankCandidates: of two equal tracks the larger box ranks first", () => {
  const small = trackOf(0, range(0, 30), still(0.5, 0.3));
  const large = trackOf(1, range(0, 30), still(0.5, 0.7));
  assert.deepEqual(rankCandidates([small, large], info).map((c) => c.trackId), [1, 0]);
});

test("rankCandidates: of two equal tracks the one that moves ranks first", () => {
  const idle = trackOf(0, range(0, 30), still(0.5));
  const mover = trackOf(1, range(0, 30), (f) => ({ cx: 0.4 + f * 0.003, cy: 0.5, w: 0.25, h: 0.5 }));
  assert.deepEqual(rankCandidates([idle, mover], info).map((c) => c.trackId), [1, 0]);
});

test("rankCandidates: numbers run 1 to n in rank order with Person labels, boxAtConfirm null", () => {
  const a = trackOf(0, range(0, 30), still(0.5, 0.3));
  const b = trackOf(1, range(0, 30), still(0.5, 0.6));
  const c = trackOf(2, range(0, 30), still(0.5, 0.45));
  const ranked = rankCandidates([a, b, c], info);
  assert.deepEqual(ranked.map((x) => x.trackId), [1, 2, 0]);
  assert.deepEqual(ranked.map((x) => x.number), [1, 2, 3]);
  assert.deepEqual(ranked.map((x) => x.label), ["Person 1", "Person 2", "Person 3"]);
  assert.ok(ranked.every((x) => x.boxAtConfirm === null));
  assert.ok(ranked[0]!.score > ranked[1]!.score && ranked[1]!.score > ranked[2]!.score);
});

test("rankCandidates: a centred person outranks one at the edge, all else equal", () => {
  const edge = trackOf(0, range(0, 30), still(0.9));
  const middle = trackOf(1, range(0, 30), still(0.5));
  assert.deepEqual(rankCandidates([edge, middle], info).map((c) => c.trackId), [1, 0]);
});

test("pickConfirmFrame: the earliest frame where the most candidates are present", () => {
  const a = trackOf(0, range(0, 30), still(0.3));
  const b = trackOf(1, range(12, 20), still(0.7));
  const c = trackOf(2, range(15, 15), still(0.5));
  const ranked = rankCandidates([a, b, c], info);
  assert.equal(pickConfirmFrame(ranked, [a, b, c]), 15);
});

test("pickConfirmFrame: with no candidates it is frame 0", () => {
  assert.equal(pickConfirmFrame([], []), 0);
});

test("withConfirmBoxes: each candidate gets its box at the frame, or null, and the input is untouched", () => {
  const a = trackOf(0, range(0, 30), (f) => ({ cx: 0.3, cy: 0.5, w: 0.2, h: 0.4 + f * 0.001 }));
  const b = trackOf(1, range(20, 10), still(0.7));
  const ranked = rankCandidates([a, b], info);
  const filled = withConfirmBoxes(ranked, [a, b], 5);
  const forA = filled.find((c) => c.trackId === 0)!;
  const forB = filled.find((c) => c.trackId === 1)!;
  assert.deepEqual(forA.boxAtConfirm, a.points[5]!.box);
  assert.equal(forB.boxAtConfirm, null);
  assert.ok(ranked.every((c) => c.boxAtConfirm === null));
});
