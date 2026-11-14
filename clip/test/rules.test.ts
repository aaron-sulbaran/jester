import assert from "node:assert/strict";
import { test } from "node:test";
import { checkClip, checkSubject, rankCandidates } from "../src/index.ts";
import type { Box } from "../src/index.ts";
import { range, trackOf } from "./synth.ts";

const wander = (h = 0.5) => (f: number): Box => ({ cx: 0.4 + f * 0.003, cy: 0.5, w: h / 2, h });
const someone = rankCandidates([trackOf(0, range(0, 30), wander())], { sampleHz: 10, frameCount: 30 });
const cuts = (n: number) => Array.from({ length: n }, (_, i) => i * 10 + 5);

test("checkClip: 2.9 seconds is refused as too short", () => {
  const result = checkClip({ durationMs: 2900, cuts: [], candidates: someone });
  assert.equal(result.refuse, "This clip is under 3 seconds. Pick a longer one.");
});

test("checkClip: 16 cuts in 30 seconds is refused as cutting too often", () => {
  const result = checkClip({ durationMs: 30000, cuts: cuts(16), candidates: someone });
  assert.equal(result.refuse, "This clip cuts too often to follow one person.");
});

test("checkClip: 15 cuts in 30 seconds is allowed", () => {
  assert.equal(checkClip({ durationMs: 30000, cuts: cuts(15), candidates: someone }).refuse, null);
});

test("checkClip: no candidates is refused", () => {
  const result = checkClip({ durationMs: 10000, cuts: [], candidates: [] });
  assert.equal(result.refuse, "No person found in this clip.");
});

test("checkClip: a normal clip has no refusal and no warnings", () => {
  assert.deepEqual(checkClip({ durationMs: 10000, cuts: cuts(2), candidates: someone }), { refuse: null, warnings: [] });
});

test("checkClip: too short wins over the other problems", () => {
  assert.equal(checkClip({ durationMs: 2000, cuts: cuts(5), candidates: [] }).refuse, "This clip is under 3 seconds. Pick a longer one.");
});

test("checkSubject: present in 40 percent of its shot is out of view", () => {
  const track = trackOf(0, range(0, 40), wander());
  const result = checkSubject(track, { start: 0, end: 100 });
  assert.equal(result.refuse, "The person you picked is out of view for most of the clip.");
});

test("checkSubject: median box height 0.2 is too small", () => {
  const track = trackOf(0, range(0, 50), wander(0.2));
  const result = checkSubject(track, { start: 0, end: 50 });
  assert.equal(result.refuse, "The person is too small in the frame. Pick a clip where they fill more of it.");
});

test("checkSubject: out of view is reported before too small", () => {
  const track = trackOf(0, range(0, 40), wander(0.2));
  assert.equal(checkSubject(track, { start: 0, end: 100 }).refuse, "The person you picked is out of view for most of the clip.");
});

test("checkSubject: a still subject gets the warning and no refusal", () => {
  const track = trackOf(0, range(0, 50), () => ({ cx: 0.5, cy: 0.5, w: 0.25, h: 0.5 }));
  assert.deepEqual(checkSubject(track, { start: 0, end: 50 }), {
    refuse: null,
    warnings: ["Nothing much moves here. This will be a hold-this-pose round."],
  });
});

test("checkSubject: a normal subject has no refusal and no warnings", () => {
  const track = trackOf(0, range(0, 50), wander());
  assert.deepEqual(checkSubject(track, { start: 0, end: 50 }), { refuse: null, warnings: [] });
});
