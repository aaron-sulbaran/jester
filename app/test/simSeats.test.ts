// Simulated seats score differently, so a game the computer plays has a winner and losers. Run from app/: npm test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromClipSamples, fromWebcamFrames, scorePoseRound } from "../../engine/src/index.ts";
import { DEMO_SEQUENCE, makeSequenceTimeline, simulatedPlayerPose } from "../../spikes/pose-match/synthetic.mjs";
import { seatEffort, seatWobble } from "../src/simSeats.ts";

/** One simulated turn on the demo dance, scored by the engine: the same frames simulatedPlayer sends, 30 a second. */
function scoreSeat(seat: number, slider = 10): number | null {
  const aspect = 16 / 9;
  const samples = makeSequenceTimeline(DEMO_SEQUENCE, { aspect });
  const durationMs = samples[samples.length - 1]!.t * 1000;
  const reference = fromClipSamples(samples as never, { width: 1600, height: 900, timeUnit: "s" });
  const frames = [];
  for (let ms = 0; ms <= durationMs; ms += 1000 / 30) {
    frames.push({ t: ms, landmarks: simulatedPlayerPose(samples, ms / 1000, { noiseDegrees: slider + seatWobble(seat), aspect }), aspect, mirrored: false, clipTimeMs: ms });
  }
  return scorePoseRound(reference, fromWebcamFrames(frames as never)).score;
}

test("two simulated seats do not score the same", () => {
  const first = scoreSeat(0)!, second = scoreSeat(1)!;
  assert.ok(first - second >= 10, `first ${first}, second ${second}`);
});

test("each seat scores lower than the one before, and the same every run", () => {
  const scores = [0, 1, 2, 3].map((seat) => scoreSeat(seat)!);
  for (let i = 1; i < scores.length; i++) assert.ok(scores[i]! < scores[i - 1]!, scores.join(", "));
  assert.deepEqual([0, 1, 2, 3].map((seat) => scoreSeat(seat)), scores);
});

test("seats past the table play like the last one, and effort falls by seat", () => {
  assert.equal(seatWobble(9), seatWobble(3));
  assert.equal(seatEffort(0), 1);
  assert.ok(seatEffort(1) < seatEffort(0) && seatEffort(3) < seatEffort(2));
});
