import assert from "node:assert/strict";
import { test } from "node:test";
import { scorePoseRound } from "../src/index.ts";
import { dance, mirrorCopy, timeline, type Pose2D } from "./synth.ts";

// A clip that travels: steps side to side, dips down, and walks toward the camera and back.
const travel = (t: number): Pose2D => ({
  ...dance(t),
  cx: 0.5 + 0.15 * Math.sin(2 * Math.PI * 0.15 * t),
  cy: 0.55 + 0.05 * Math.max(0, Math.sin(2 * Math.PI * 0.3 * t)),
  scale: 0.25 * (1 + 0.3 * Math.max(0, Math.sin(2 * Math.PI * 0.1 * t))),
});
const ref = timeline(travel, { durationS: 20 });

test("placement: a perfect copy scores full placement and a perfect outline", () => {
  const r = scorePoseRound(ref, timeline(travel, { durationS: 20, transform: mirrorCopy }));
  assert.equal(r.placement.used, true);
  assert.ok(r.placement.gain > 0.97, `gain ${r.placement.gain}`);
  assert.ok(r.score !== null && r.score >= 97, `score ${r.score}`);
  assert.ok(r.placement.outlineFit !== null && r.placement.outlineFit >= 95, `outline ${r.placement.outlineFit}`);
});

test("placement: relative moves ignore framing, the outline does not", () => {
  // Same moves, but the player stands off to one side and further from the camera, so every move
  // also looks 0.6 times as big on screen.
  const k = 0.6;
  const shifted = (t: number) => { const p = mirrorCopy(travel(t)); return { ...p, cx: 0.35 + (p.cx - 0.5) * k, cy: 0.55 + (p.cy - 0.55) * k, scale: p.scale * k }; };
  const r = scorePoseRound(ref, timeline(shifted, { durationS: 20 }));
  assert.ok(r.placement.gain > 0.95, `gain ${r.placement.gain}`);
  assert.ok(r.score !== null && r.score >= 95, `score ${r.score}`);
  assert.ok(r.placement.outlineFit !== null && r.placement.outlineFit < 50, `outline ${r.placement.outlineFit}`);
  assert.equal(r.placement.outlineHints.distance, "closer");
});

test("placement: perfect limbs while staying in place loses points on a travelling clip", () => {
  const inPlace = (t: number) => ({ ...mirrorCopy(travel(t)), cx: 0.5, cy: 0.55, scale: 0.25 });
  const full = scorePoseRound(ref, timeline(travel, { durationS: 20, transform: mirrorCopy }));
  const r = scorePoseRound(ref, timeline(inPlace, { durationS: 20 }));
  console.log(`travel clip: copy ${full.score}, in place ${r.score}, placement gain ${r.placement.gain.toFixed(2)}`);
  assert.ok(r.placement.gain < 0.2, `gain ${r.placement.gain}`);
  assert.ok(r.score !== null && full.score !== null && r.score <= full.score - 15, `in place ${r.score} vs ${full.score}`);
  assert.ok(r.placement.worst === "sideways" || r.placement.worst === "distance", `worst ${r.placement.worst}`);
});

test("placement: a clip that never travels leaves the score to the limbs", () => {
  const r = scorePoseRound(timeline(dance, { durationS: 20 }), timeline(dance, { durationS: 20, transform: mirrorCopy }));
  assert.equal(r.placement.used, false);
  assert.ok(r.score !== null && r.score >= 99, `score ${r.score}`);
});
