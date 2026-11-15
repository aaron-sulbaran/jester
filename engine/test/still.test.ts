// 0.10.0 still gate. In 0.9.0 the gain over the fixed arms-down still pose needed no motion, so on a clip whose
// subject mostly stands a player who never moved scored up to 66 (Aaron's live blind round, frozen copy): their
// own standing pose beats the fixed pose by a lot. Now that gain counts only as far as the player moved at all.

import assert from "node:assert/strict";
import { test } from "node:test";
import { MOTION } from "../src/constants.ts";
import { LIMB_NAMES, scorePoseRound } from "../src/index.ts";
import { limbTurns, movedShare } from "../src/pose.ts";
import type { PoseTimeline } from "../src/types.ts";
import { mirrorCopy, STAND, timeline, type Pose2D } from "./synth.ts";

/**
 * A clip that mostly stands: a relaxed stance (arms a little out, a slight bend at the elbows) with a
 * right-hand wave for 2 s out of every 4 s. Like the live round: only the waving forearm moves.
 */
function wave(t: number): Pose2D {
  const on = t % 4 < 2 ? Math.sin(Math.PI * ((t % 4) / 2)) : 0;
  return {
    ...STAND,
    lUpper: 14, lFore: 18, rUpper: -14 - 50 * on, rFore: -18 - 120 * on + 35 * on * Math.sin(2 * Math.PI * 2 * t),
  };
}

const D = 16;
const ref = timeline(wave, { durationS: D });

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
/** Sway: every landmark drifts on its own slow sine of `amp` frame heights. */
function withSway(tl: PoseTimeline, amp: number, seed = 11): PoseTimeline {
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

const held = (p: Pose2D) => timeline(() => p, { durationS: D, transform: mirrorCopy });
const copy = (delayMs = 0) => timeline(wave, { durationS: D, transform: mirrorCopy, delayMs });

test("still: the clip is mostly standing, so a held standing pose beats the fixed still pose", () => {
  const r = scorePoseRound(ref, held(wave(0)));
  assert.ok(r.accuracy > r.stillBaseline, `accuracy ${r.accuracy} baseline ${r.stillBaseline}`);
  assert.ok(r.motion.gainOverStill > 0.2, `gain over still ${r.motion.gainOverStill}`);
});

test("still: standing still scores low on a mostly standing clip, in any pose, with noise or sway", () => {
  const cases: Record<string, PoseTimeline> = {
    "the clip's own stance held": held(wave(0)),
    "player's own stance held": held(STAND),
    "stance, noise 0.005": withNoise(held(wave(0)), 0.005),
    "stance, noise 0.01": withNoise(held(wave(0)), 0.01),
    "stance, sway 0.01": withSway(held(wave(0)), 0.01),
    "stance, sway 0.01, noise 0.005": withNoise(withSway(held(wave(0)), 0.01), 0.005),
  };
  for (const [name, player] of Object.entries(cases)) {
    const r = scorePoseRound(ref, player);
    console.log(`wave clip: ${name}: ${r.score} (moved ${r.motion.moved.toFixed(2)}, still gate ${r.motion.stillGate.toFixed(2)}, gain over still ${r.motion.gainOverStill.toFixed(2)})`);
    assert.ok(r.motion.moved < MOTION.movedHigh, `${name}: moved ${r.motion.moved}`);
    assert.ok(r.score !== null && r.score < 20, `${name}: ${r.score}`);
  }
});

test("still: a genuine copy keeps its score (the still gate is fully open)", () => {
  for (const [name, player] of [
    ["exact", copy()],
    ["late 400 ms", copy(400)],
    ["late 400 ms, noise 0.01", withNoise(copy(400), 0.01)],
    ["late 400 ms, sway 0.02", withSway(copy(400), 0.02)],
  ] as const) {
    const r = scorePoseRound(ref, player);
    console.log(`wave clip: copy ${name}: ${r.score} (moved ${r.motion.moved.toFixed(2)})`);
    assert.equal(r.motion.stillGate, 1, `${name}: still gate ${r.motion.stillGate}`);
    assert.ok(r.score !== null && r.score >= 50, `${name}: ${r.score}`);
  }
});

test("still: waving the other hand is not a copy of this clip", () => {
  // The same wave done with the left hand: the right forearm the clip moves stays still.
  const other = timeline((t) => { const p = wave(t); return { ...p, lUpper: -p.rUpper, lFore: -p.rFore, rUpper: -14, rFore: -18 }; }, { durationS: D, transform: mirrorCopy });
  const r = scorePoseRound(ref, other);
  assert.ok(r.motion.moved < MOTION.movedLow + 0.05, `moved ${r.motion.moved}`);
  assert.ok(r.score !== null && r.score < 20, `score ${r.score}`);
});

test("still: moved share is 0 for a statue, 1 for an exact copy, and 1 when the clip never moves", () => {
  const n = 90;
  const frame = (dx: number, dy: number) => [{ x: dx, y: dy, visibility: 1 }];
  const turning = Array.from({ length: n }, (_, i) => frame(Math.cos(i * 0.1), Math.sin(i * 0.1)));
  const fixed = Array.from({ length: n }, () => frame(0, 1));
  const match = Array.from({ length: n }, (_, i) => i), valid = match.map(() => true);
  // One moving limb (the first); every other limb is out of view on both sides.
  const pad = (rows: { x: number; y: number; visibility: number }[][]) => rows.map((r) => [...r, ...new Array(LIMB_NAMES.length - 1).fill(null)]);
  const t = (rows: ReturnType<typeof pad>) => limbTurns(rows);
  assert.equal(movedShare(t(pad(turning)), t(pad(fixed)), match, valid), 0);
  assert.ok(Math.abs(movedShare(t(pad(turning)), t(pad(turning)), match, valid) - 1) < 1e-9);
  assert.equal(movedShare(t(pad(fixed)), t(pad(turning)), match, valid), 1);
});

test("still: the gain is max(still gate * gain over still, gate * credit)", () => {
  for (const p of [copy(), copy(400), held(wave(0)), withNoise(held(STAND), 0.01)]) {
    const m = scorePoseRound(ref, p).motion;
    assert.ok(m.gain === Math.max(m.stillGate * m.gainOverStill, m.gate * m.credit));
    assert.ok(m.stillGate >= 0 && m.stillGate <= 1 && m.moved >= 0 && m.moved <= 1);
  }
});
