import assert from "node:assert/strict";
import { test } from "node:test";
import { detectEvents, scoreTrajectoryRound } from "../src/index.ts";
import { referenceSignals, REFERENCE_THRESHOLDS } from "../src/trajectory.ts";
import { boxTrack, playerCopyingSprite, spritePath, STAND, timeline } from "./synth.ts";

const track = boxTrack(spritePath, 24);

test("reference events: the sprite's jumps, ducks and lane changes are found", () => {
  const n = track.frames.length;
  const sig = referenceSignals(track, n);
  const ev = detectEvents(sig, REFERENCE_THRESHOLDS);
  const count = (t: string) => ev.filter((e) => e.type === t).length;
  assert.equal(count("jump"), 8);
  assert.equal(count("crouch"), 8);
  assert.ok(count("moveRight") + count("moveLeft") >= 8, JSON.stringify(ev));
});

test("trajectory round: a good copy scores high", () => {
  const player = timeline(playerCopyingSprite, { durationS: 24 });
  const r = scoreTrajectoryRound(track, player);
  assert.equal(r.failure, null);
  assert.ok(r.score !== null && r.score >= 80, `score ${r.score} ${JSON.stringify({ c: r.continuous, f1: r.eventF1, a: r.activity })}`);
  assert.ok(r.eventF1 !== null && r.eventF1 > 0.9, `f1 ${r.eventF1}`);
});

test("trajectory round: a late copy is found at the right lag", () => {
  const player = timeline(playerCopyingSprite, { durationS: 24, delayMs: 300 });
  const r = scoreTrajectoryRound(track, player);
  assert.ok(Math.abs(r.lagMs - 300) <= 34, `lag ${r.lagMs}`);
  assert.ok(r.score !== null && r.score >= 80, `score ${r.score}`);
});

test("trajectory round: standing still scores near zero", () => {
  const player = timeline(() => STAND, { durationS: 24 });
  const r = scoreTrajectoryRound(track, player);
  assert.ok(r.score !== null && r.score <= 5, `score ${r.score}`);
});

test("trajectory round: moving the wrong way scores low", () => {
  // Steps the opposite lane direction, never jumps or ducks.
  const player = timeline((t) => ({ ...playerCopyingSprite(t), cx: 1 - playerCopyingSprite(t).cx, cy: STAND.cy, lThigh: 3, lShin: 0, rThigh: -3, rShin: 0 }), { durationS: 24 });
  const r = scoreTrajectoryRound(track, player);
  assert.ok(r.score !== null && r.score < 30, `score ${r.score}`);
});

test("trajectory round: a box that never moves has nothing to mimic", () => {
  const still = boxTrack(() => ({ cx: 0.5, cy: 0.6, w: 0.08, h: 0.2 }), 10);
  const r = scoreTrajectoryRound(still, timeline(() => STAND, { durationS: 10 }));
  assert.equal(r.failure, "nothing-to-mimic");
  assert.equal(r.score, null);
});
