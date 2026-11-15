// 0.11.0 either side. A player may copy the dancer as a mirror (the dancer raises her right arm, the player their
// left) or with the same side (the player raises their own right arm). Both must score the same. Since 0.10.0's
// still gate, a same-side copy read only as a mirror copy scored near 0 (Aaron's live round: 87 in 0.9.0, 0 in 0.10.0).

import assert from "node:assert/strict";
import { test } from "node:test";
import { comparePoses, scorePoseRound } from "../src/index.ts";
import { dance, landmarks, mirrorCopy, STAND, timeline, type Pose2D } from "./synth.ts";

const D = 16;
/** A clip that mostly stands and waves the right hand, like Aaron's live round. */
function wave(t: number): Pose2D {
  const on = t % 4 < 2 ? Math.sin(Math.PI * ((t % 4) / 2)) : 0;
  return { ...STAND, lUpper: 14, lFore: 18, rUpper: -14 - 50 * on, rFore: -18 - 120 * on + 35 * on * Math.sin(2 * Math.PI * 2 * t) };
}

const clips = {
  dance: timeline(dance, { durationS: D }),
  wave: timeline(wave, { durationS: D }),
};
const motions = { dance, wave };

// On an unmirrored camera, a same-side copy looks exactly like the clip; a mirror copy looks like its mirror image.
const mirrorCopyOf = (m: (t: number) => Pose2D, delayMs = 0) => timeline(m, { durationS: D, transform: mirrorCopy, delayMs });
const sameSideCopyOf = (m: (t: number) => Pose2D, delayMs = 0) => timeline(m, { durationS: D, delayMs });

test("either side: a same-side copy scores like the mirror copy, on time and late", () => {
  for (const name of ["dance", "wave"] as const) {
    for (const delay of [0, 400]) {
      const mirror = scorePoseRound(clips[name], mirrorCopyOf(motions[name], delay));
      const same = scorePoseRound(clips[name], sameSideCopyOf(motions[name], delay));
      const oneReading = scorePoseRound(clips[name], sameSideCopyOf(motions[name], delay), { eitherSide: false });
      console.log(`${name} late ${delay}: mirror copy ${mirror.score}, same-side copy ${same.score} (mirror reading only: ${oneReading.score})`);
      assert.equal(mirror.orientation, "mirror");
      assert.equal(same.orientation, "same-side");
      assert.ok(same.score !== null && mirror.score !== null && Math.abs(same.score - mirror.score) <= 1, `${name} ${delay}: ${same.score} vs ${mirror.score}`);
      assert.ok(mirror.score >= 50, `${name} ${delay}: ${mirror.score}`);
    }
  }
});

test("either side: a genuine mirror copy gets exactly the mirror-only result", () => {
  for (const name of ["dance", "wave"] as const) {
    const player = mirrorCopyOf(motions[name], 300);
    assert.deepEqual(scorePoseRound(clips[name], player), scorePoseRound(clips[name], player, { eitherSide: false }));
  }
});

test("either side: standing still stays low in either stance", () => {
  for (const name of ["dance", "wave"] as const) {
    const first = motions[name](0);
    for (const [label, pose] of [["clip stance, mirrored", mirrorCopy(first)], ["clip stance, same side", first], ["arms down", STAND]] as const) {
      const r = scorePoseRound(clips[name], timeline(() => pose, { durationS: D }));
      console.log(`${name}: still, ${label}: ${r.score} (${r.orientation})`);
      assert.ok(r.score !== null && r.score < 20, `${name} ${label}: ${r.score}`);
    }
  }
});

test("either side: an exact tie keeps the mirror reading (or the preferred one)", () => {
  // A left-right symmetric clip reads the same both ways.
  const sym = (t: number): Pose2D => {
    const a = 60 + 50 * Math.sin(2 * Math.PI * 0.5 * t);
    return { ...STAND, lUpper: a, lFore: a, rUpper: -a, rFore: -a };
  };
  const ref = timeline(sym, { durationS: 10 });
  const player = timeline(sym, { durationS: 10, delayMs: 200 });
  const r = scorePoseRound(ref, player);
  assert.equal(r.orientation, "mirror");
  assert.equal(scorePoseRound(ref, player, { mirror: false }).orientation, "same-side");
  // Live feedback too.
  const live = comparePoses(landmarks(sym(1)), landmarks(sym(1)));
  assert.equal(live.orientation, "mirror");
  // A still player scores 0 both ways: still the mirror reading.
  assert.equal(scorePoseRound(clips.dance, timeline(() => STAND, { durationS: D })).orientation, "mirror");
});

test("either side: deterministic", () => {
  const a = scorePoseRound(clips.wave, sameSideCopyOf(wave, 250));
  const b = scorePoseRound(clips.wave, sameSideCopyOf(wave, 250));
  assert.deepEqual(a, b);
});
