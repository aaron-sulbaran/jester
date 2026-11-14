// The core promise: the same inputs always give the same result, bit for bit.

import assert from "node:assert/strict";
import { test } from "node:test";
import { scorePoseRound, scoreTrajectoryRound, skeletonGate } from "../src/index.ts";
import { boxTrack, dance, mirrorCopy, playerCopyingSprite, spritePath, timeline } from "./synth.ts";

// A slightly imperfect, late, jittery player, so the result is not a trivial 100.
const noisy = (p: ReturnType<typeof dance>) => mirrorCopy({ ...p, lUpper: p.lUpper + 40, rFore: p.rFore - 35 });

test("pose round: identical inputs give a byte-identical result", () => {
  const ref = timeline(dance, { durationS: 15 });
  const player = timeline(dance, { durationS: 15, transform: noisy, delayMs: 230, jitterMs: 6, fps: 29 });
  const a = JSON.stringify(scorePoseRound(ref, player));
  // Rebuild the inputs from JSON, as if they had been stored and loaded again.
  const b = JSON.stringify(scorePoseRound(JSON.parse(JSON.stringify(ref)), JSON.parse(JSON.stringify(player))));
  assert.equal(a, b);
  assert.ok(JSON.parse(a).score > 0 && JSON.parse(a).score < 100);
});

test("pose round: float noise below the quantization step does not change the score", () => {
  const ref = timeline(dance, { durationS: 15 });
  const player = timeline(dance, { durationS: 15, transform: noisy, delayMs: 230 });
  // Nudge every coordinate by about 1e-7: what a different GPU or build might do.
  const nudged = {
    ...player,
    frames: player.frames.map((f, i) => ({
      ...f,
      landmarks: f.landmarks ? f.landmarks.map((l, k) => [l[0] + 1e-7 * Math.sin(i + k), l[1] - 1e-7 * Math.cos(i * k), l[2]] as const) : null,
    })),
  };
  assert.equal(scorePoseRound(ref, nudged).score, scorePoseRound(ref, player).score);
});

test("trajectory round: identical inputs give a byte-identical result", () => {
  const track = boxTrack(spritePath, 20);
  const player = timeline(playerCopyingSprite, { durationS: 20, delayMs: 260, jitterMs: 5 });
  const a = JSON.stringify(scoreTrajectoryRound(track, player));
  const b = JSON.stringify(scoreTrajectoryRound(JSON.parse(JSON.stringify(track)), JSON.parse(JSON.stringify(player))));
  assert.equal(a, b);
});

test("gate: identical inputs give identical decisions", () => {
  const ref = timeline(dance, { durationS: 10 });
  assert.deepEqual(skeletonGate(ref), skeletonGate(JSON.parse(JSON.stringify(ref))));
});
