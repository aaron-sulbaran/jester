// 0.9.0 fair scoring on low-motion clips. Before 0.9.0 the round only paid accuracy above what standing
// still earns; on a clip of gentle moves that baseline is about 0.8, and a real webcam player (tracker noise,
// loose timing) landed under it and scored 0. These tests use a synthetic low-motion clip of that kind.

import assert from "node:assert/strict";
import { test } from "node:test";
import { scorePoseRound } from "../src/index.ts";
import type { PoseTimeline } from "../src/types.ts";
import { mirrorCopy, STAND, timeline, type Pose2D } from "./synth.ts";

/** A gentle groove: arms swing 35 degrees around hanging, a small knee bounce, a little lean. */
function groove(t: number): Pose2D {
  const w = 2 * Math.PI * 0.5;
  return {
    ...STAND,
    lUpper: 20 + 35 * Math.sin(w * t), lFore: 25 + 45 * Math.sin(w * t + 0.6),
    rUpper: -20 + 35 * Math.sin(w * t + 1.2), rFore: -25 + 45 * Math.sin(w * t + 1.8),
    lThigh: 3 + 10 * Math.max(0, Math.sin(2 * w * t)), lShin: -8 * Math.max(0, Math.sin(2 * w * t)),
    rThigh: -3 - 10 * Math.max(0, Math.sin(2 * w * t)), rShin: 8 * Math.max(0, Math.sin(2 * w * t)),
  };
}

const D = 16;
const ref = timeline(groove, { durationS: D });

/** Deterministic pseudo random numbers (a fixed LCG), so every run sees the same noise. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}
function gaussian(r: () => number): number {
  return Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
}

/** Tracker noise: every landmark moves by a fresh Gaussian of `sigma` frame heights, every frame. */
function withNoise(tl: PoseTimeline, sigma: number, seed = 7): PoseTimeline {
  const r = rng(seed), aspect = tl.source.width / tl.source.height;
  return { ...tl, frames: tl.frames.map((f) => ({ ...f, landmarks: f.landmarks && f.landmarks.map(([x, y, v]) => [x + (gaussian(r) * sigma) / aspect, y + gaussian(r) * sigma, v] as const) })) };
}

/** Smooth wobble: every landmark drifts on its own slow sine of `amp` frame heights (a loose copy). */
function withWobble(tl: PoseTimeline, amp: number, seed = 11): PoseTimeline {
  const r = rng(seed), aspect = tl.source.width / tl.source.height;
  const ph = Array.from({ length: 33 }, () => [r() * 6.28, r() * 6.28, 0.3 + 0.7 * r(), 0.3 + 0.7 * r()] as const);
  return {
    ...tl,
    frames: tl.frames.map((f) => {
      const s = (f.tMs / 1000) * 2 * Math.PI;
      return { ...f, landmarks: f.landmarks && f.landmarks.map(([x, y, v], j) => {
        const p = ph[j]!;
        return [x + (amp * Math.sin(s * p[2] + p[0])) / aspect, y + amp * Math.sin(s * p[3] + p[1]), v] as const;
      }) };
    }),
  };
}

const copy = (o: Parameters<typeof timeline>[1] = {}) => timeline(groove, { durationS: D, transform: mirrorCopy, ...o });
const still = () => timeline(() => STAND, { durationS: D });

test("fair: the clip is the kind that zeroed everyone (standing still already earns most of the accuracy)", () => {
  const r = scorePoseRound(ref, still());
  assert.ok(r.stillBaseline > 0.7, `baseline ${r.stillBaseline}`);
});

test("fair: an exact copy scores 100 and moves like the clip", () => {
  const r = scorePoseRound(ref, copy());
  assert.equal(r.score, 100);
  assert.ok(r.motion.share > 0.97, `share ${r.motion.share}`);
});

test("fair: a copy through a noisy tracker stays high", () => {
  const a = scorePoseRound(ref, withNoise(copy(), 0.01));
  const b = scorePoseRound(ref, withNoise(copy(), 0.02));
  const c = scorePoseRound(ref, withNoise(copy(), 0.03));
  console.log(`groove clip: noisy copy 0.01 ${a.score}, 0.02 ${b.score}, 0.03 ${c.score}`);
  assert.ok(a.score! >= 85, `0.01: ${a.score}`);
  assert.ok(b.score! >= 60, `0.02: ${b.score}`);
  assert.ok(c.score! >= 35, `0.03: ${c.score}`);
  assert.ok(a.score! >= b.score! && b.score! >= c.score!);
});

test("fair: a blind copier (late, drifting timing, loose shapes, tracker noise) lands in OK to Good", () => {
  // Timing drifts up to 250 ms either side of a 500 ms lag.
  const player = timeline((t) => groove(Math.max(0, t - 0.25 * Math.sin(2 * Math.PI * 0.3 * t))), { durationS: D, transform: mirrorCopy, delayMs: 500 });
  const r = scorePoseRound(ref, withNoise(withWobble(player, 0.05), 0.015));
  console.log(`groove clip: blind copier ${r.score} (accuracy ${r.accuracy.toFixed(3)}, baseline ${r.stillBaseline.toFixed(3)}, share ${r.motion.share.toFixed(2)})`);
  assert.ok(r.score! >= 35 && r.score! <= 80, `score ${r.score}`);
});

test("fair: a sloppy but genuine copy is not 0, and scores below a cleaner one", () => {
  const loose = scorePoseRound(ref, withWobble(copy(), 0.04));
  const sloppy = scorePoseRound(ref, withWobble(copy(), 0.07));
  console.log(`groove clip: wobble 0.04 ${loose.score}, wobble 0.07 ${sloppy.score}`);
  assert.ok(sloppy.score! > 0, `sloppy ${sloppy.score}`);
  assert.ok(loose.score! > sloppy.score!, `${loose.score} vs ${sloppy.score}`);
});

test("fair: standing still stays low, even with tracker noise or fidgeting", () => {
  const cases = {
    still: still(),
    "still, noise 0.01": withNoise(still(), 0.01),
    "still, noise 0.03": withNoise(still(), 0.03),
    "still, wobble 0.04": withWobble(still(), 0.04),
    "first pose held": timeline(() => groove(0), { durationS: D, transform: mirrorCopy }),
  };
  for (const [name, player] of Object.entries(cases)) {
    const r = scorePoseRound(ref, player);
    // The moving credit stays shut, so a still body keeps only the gain over standing still it had before
    // 0.9.0. The synthetic STAND holds its arms 10 degrees out, a little closer to this clip than the
    // engine's still pose, which earns it a small gain over still (26 here, the same as under 0.8.0).
    assert.ok(r.motion.share < 0.2, `${name}: share ${r.motion.share}`);
    assert.ok(r.motion.gate < 0.1, `${name}: gate ${r.motion.gate}`);
    assert.ok(r.motion.gain - r.motion.gainOverStill < 0.03, `${name}: moving credit ${r.motion.gain - r.motion.gainOverStill}`);
    assert.ok(r.score !== null && r.score < (name === "still" ? 30 : 20), `${name}: ${r.score}`);
  }
});

test("fair: moving, but not like the clip, does not open the moving credit", () => {
  // Arms swing at another tempo and phase: lots of motion, little of it the clip's.
  const other = timeline((t) => groove(t * 1.7 + 0.9), { durationS: D, transform: mirrorCopy });
  const r = scorePoseRound(ref, other);
  assert.ok(r.motion.share < 0.3, `share ${r.motion.share}`);
  assert.ok(r.score !== null && r.score < 35, `score ${r.score}`);
});

test("fair: the gain is never below the gain over standing still", () => {
  for (const p of [copy(), withNoise(copy(), 0.02), still(), withWobble(copy(), 0.07)]) {
    const r = scorePoseRound(ref, p);
    assert.ok(r.motion.gain >= r.motion.gainOverStill);
    assert.ok(r.motion.gain === Math.max(r.motion.gainOverStill, r.motion.gate * r.motion.credit));
  }
});
