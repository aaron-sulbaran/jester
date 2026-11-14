import assert from "node:assert/strict";
import { test } from "node:test";
import { comparePoses, limbCredit, scorePoseRound } from "../src/index.ts";
import { dance, landmarks, mirrorCopy, STAND, timeline } from "./synth.ts";

test("limb credit: dead zone, falloff, zero", () => {
  assert.equal(limbCredit(0), 1);
  assert.equal(limbCredit(15), 1);
  assert.ok(Math.abs(limbCredit(37.5) - 0.75) < 1e-9);
  assert.equal(limbCredit(60), 0);
  assert.equal(limbCredit(120), 0);
});

test("comparePoses: a mirror copy scores 1, the same unmirrored pose does not", () => {
  // Clearly one-sided: left arm up, right arm down, one knee raised.
  const p = { ...STAND, lUpper: 170, lFore: 175, rUpper: -10, rFore: -5, lThigh: 80, lShin: 0 };
  const ref = landmarks(p);
  const copy = comparePoses(ref, landmarks(mirrorCopy(p)));
  assert.ok(copy.credit !== null && copy.credit > 0.999, `got ${copy.credit}`);
  const wrongSide = comparePoses(ref, landmarks(p));
  assert.ok(wrongSide.credit !== null && wrongSide.credit < 0.8, `got ${wrongSide.credit}`);
});

test("comparePoses: size, position and aspect do not matter", () => {
  const p = dance(2.1);
  const ref = landmarks(p, 16 / 9);
  const player = landmarks({ ...mirrorCopy(p), cx: 0.3, cy: 0.7, scale: 0.12 }, 4 / 3);
  const r = comparePoses(ref, player, { referenceAspect: 16 / 9, playerAspect: 4 / 3 });
  assert.ok(r.credit !== null && r.credit > 0.999, `got ${r.credit}`);
});

test("comparePoses: hidden limbs drop out instead of counting as wrong", () => {
  const p = dance(0.7);
  const ref = landmarks(p);
  const player = landmarks(mirrorCopy(p)).map((l, i) => (i >= 23 ? ([l[0], l[1], 0.1] as const) : l));
  const r = comparePoses(ref, player);
  assert.ok(r.credit !== null && r.credit > 0.999, `got ${r.credit}`);
  assert.ok(r.limbs.every((l) => !l.limb.includes("Thigh") && !l.limb.includes("Shin")));
});

test("comparePoses: too little visible body gives null, never a made-up number", () => {
  const ref = landmarks(STAND);
  const player = landmarks(STAND).map((l, i) => (i === 0 ? l : ([l[0], l[1], 0.1] as const)));
  assert.equal(comparePoses(ref, player).credit, null);
  assert.equal(comparePoses(ref, null).credit, null);
});

const ref = timeline(dance, { durationS: 20 });

test("round: a perfect mirror copy scores 100", () => {
  const player = timeline(dance, { durationS: 20, transform: mirrorCopy });
  const r = scorePoseRound(ref, player);
  assert.equal(r.score, 100);
  assert.equal(r.tier, "Perfect");
  assert.equal(r.lagMs, 0);
  assert.equal(r.failure, null);
});

test("round: a player 300 ms late is found at the right lag and keeps full timing", () => {
  const player = timeline(dance, { durationS: 20, transform: mirrorCopy, delayMs: 300 });
  const r = scorePoseRound(ref, player);
  assert.ok(Math.abs(r.lagMs - 300) <= 34, `lag ${r.lagMs}`);
  assert.equal(r.timing, 1);
  assert.ok(r.score !== null && r.score >= 97, `score ${r.score}`);
});

test("round: a player 700 ms late (a first-time player on a real webcam) keeps most timing credit", () => {
  const player = timeline(dance, { durationS: 20, transform: mirrorCopy, delayMs: 700 });
  const r = scorePoseRound(ref, player);
  assert.ok(Math.abs(r.lagMs - 700) <= 34, `lag ${r.lagMs}`);
  assert.ok(r.timing > 0.85, `timing ${r.timing}`);
  assert.ok(r.score !== null && r.score >= 95, `score ${r.score}`);
});

test("round: a player 1100 ms late is found and loses timing credit", () => {
  const player = timeline(dance, { durationS: 20, transform: mirrorCopy, delayMs: 1100 });
  const r = scorePoseRound(ref, player);
  assert.ok(Math.abs(r.lagMs - 1100) <= 34, `lag ${r.lagMs}`);
  assert.ok(r.timing < 0.5, `timing ${r.timing}`);
  assert.ok(r.score !== null && r.score < 100);
});

test("round: standing still scores low", () => {
  const player = timeline(() => STAND, { durationS: 20 });
  const r = scorePoseRound(ref, player);
  assert.ok(r.score !== null && r.score < 35, `score ${r.score}`);
});

test("round: uneven timestamps (a live camera) score like an even grid", () => {
  const player = timeline(dance, { durationS: 20, transform: mirrorCopy, fps: 24, jitterMs: 8 });
  const r = scorePoseRound(ref, player);
  assert.ok(r.score !== null && r.score >= 97, `score ${r.score}`);
});

test("round: an already-mirrored camera feed is not flipped twice", () => {
  // Pixels flipped before tracking: the tracker sees the mirror image directly.
  const player = timeline(dance, { durationS: 20, transform: mirrorCopy, mirrored: true });
  const flippedBack = { ...player, frames: player.frames.map((f) => ({ ...f, landmarks: f.landmarks })) };
  const r = scorePoseRound(ref, flippedBack);
  // Data that is already a mirror image of the copy must not be mirrored again: it then reads as wrong-sided.
  const notFlipped = scorePoseRound(ref, timeline(dance, { durationS: 20, transform: mirrorCopy }));
  assert.ok(r.score !== null && notFlipped.score !== null && r.score < notFlipped.score);
});

test("round: a player out of frame most of the time fails as low tracking", () => {
  const player = timeline(dance, { durationS: 20, transform: mirrorCopy, drop: (i) => i % 3 !== 0 && i > 60 });
  const r = scorePoseRound(ref, player);
  assert.equal(r.score, null);
  assert.equal(r.failure, "low-tracking");
});

test("round: worst limb is named from the player's own side", () => {
  // The player gets the performer's left forearm wrong; copying as a mirror, that is the player's right forearm.
  const player = timeline(dance, { durationS: 20, transform: (p) => mirrorCopy({ ...p, lFore: p.lFore + 70 }) });
  const r = scorePoseRound(ref, player);
  assert.equal(r.worstLimb?.limb, "leftForearm");
  assert.equal(r.worstLimb?.label, "right forearm");
});

test("hands and feet are scored: a perfect copy covers them", () => {
  const r = scorePoseRound(ref, timeline(dance, { durationS: 20, transform: mirrorCopy }));
  for (const limb of ["leftHand", "rightHand", "leftFoot", "rightFoot"]) {
    assert.ok(r.perLimb[limb], `${limb} missing`);
    assert.ok(r.perLimb[limb]!.credit > 0.99, `${limb} credit ${r.perLimb[limb]!.credit}`);
  }
});

test("hands: a bent wrist is found and named from the player's own side", () => {
  // Arms right, but the player's hand is bent 70 degrees off the performer's left hand.
  const player = timeline(dance, { durationS: 20, transform: (p) => mirrorCopy({ ...p, lHand: p.lFore + 70 }) });
  const r = scorePoseRound(ref, player);
  assert.ok(r.perLimb.leftHand!.credit < 0.2, `leftHand ${r.perLimb.leftHand!.credit}`);
  assert.ok(r.perLimb.leftForearm!.credit > 0.99, `leftForearm ${r.perLimb.leftForearm!.credit}`);
  assert.equal(r.worstLimb?.limb, "leftHand");
  assert.equal(r.worstLimb?.label, "right hand");
  assert.ok(r.score !== null && r.score < 100 && r.score > 70, `score ${r.score}`);
});
