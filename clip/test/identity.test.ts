import assert from "node:assert/strict";
import { test } from "node:test";
import { bodyShape, boxFromLandmarks, crossingShare, rankCandidates, repairIdentities, shapeDistance, shapeSignature } from "../src/index.ts";
import type { Track, TrackPoint } from "../src/index.ts";
import { AVERAGE_BUILD, bodyLandmarks, type Build } from "./synth.ts";

const LONG_LEGS: Build = { ...AVERAGE_BUILD, upperArm: 0.38, forearm: 0.33, thigh: 0.75, shin: 0.7 };
const LONG_ARMS: Build = { ...AVERAGE_BUILD, upperArm: 0.55, forearm: 0.5, thigh: 0.5, shin: 0.45, shoulders: 0.6 };

function pointOf(frame: number, cx: number, build: Build, torso = 0.15, cy = 0.5): TrackPoint {
  const landmarks = bodyLandmarks(cx, cy, torso, build, 8 * Math.sin(frame));
  return { frame, tMs: frame * 100, box: boxFromLandmarks(landmarks)!, landmarks, outline: null };
}

/** Two people of different builds walking through each other over 41 frames, crossing at frame 20. */
function crossing() {
  const a = (f: number) => pointOf(f, 0.2 + 0.015 * f, LONG_LEGS);
  const b = (f: number) => pointOf(f, 0.8 - 0.015 * f, LONG_ARMS);
  const frames = Array.from({ length: 41 }, (_, f) => f);
  return { a, b, frames };
}

test("bodyShape: the same build at another size and place has the same shape", () => {
  const near = bodyShape(bodyLandmarks(0.3, 0.6, 0.2, LONG_LEGS))!;
  const far = bodyShape(bodyLandmarks(0.7, 0.4, 0.1, LONG_LEGS))!;
  near.forEach((v, k) => assert.ok(Math.abs(v! - far[k]!) < 1e-9));
  const other = bodyShape(bodyLandmarks(0.3, 0.6, 0.2, LONG_ARMS))!;
  assert.ok(shapeDistance(other, near)! > 0.15);
  assert.ok(shapeDistance(far, near)! < 1e-9);
});

test("bodyShape: null when the torso is not seen well", () => {
  const lms = bodyLandmarks(0.5, 0.5, 0.15, AVERAGE_BUILD).map(([x, y], i) => [x, y, i === 23 ? 0.2 : 1] as const);
  assert.equal(bodyShape(lms), null);
});

test("shapeSignature: needs enough measured frames", () => {
  const points = [0, 1, 2, 3].map((f) => pointOf(f, 0.5, AVERAGE_BUILD));
  assert.equal(shapeSignature(points), null);
  assert.ok(shapeSignature([...points, pointOf(4, 0.5, AVERAGE_BUILD)]));
});

test("repairIdentities: two dancers swapped by linking at a crossing are put back", () => {
  const { a, b, frames } = crossing();
  // As linking might get it wrong: each track takes the other person after the crossing.
  const t0: Track = { id: 0, shot: 0, points: frames.map((f) => (f <= 20 ? a(f) : b(f))) };
  const t1: Track = { id: 1, shot: 0, points: frames.map((f) => (f <= 20 ? b(f) : a(f))) };
  const result = repairIdentities([t0, t1]);
  assert.equal(result.swaps, 1);
  assert.equal(result.dropped, 0);
  const [r0, r1] = result.tracks;
  assert.equal(r0!.points.length, 41);
  assert.ok(r0!.points.every((p, i) => i === 0 || p.box.cx > r0!.points[i - 1]!.box.cx), "track 0 keeps walking right");
  assert.ok(r1!.points.every((p, i) => i === 0 || p.box.cx < r1!.points[i - 1]!.box.cx), "track 1 keeps walking left");
});

test("repairIdentities: correctly linked dancers are left alone, and the input is not changed", () => {
  const { a, b, frames } = crossing();
  const t0: Track = { id: 0, shot: 0, points: frames.map(a) };
  const t1: Track = { id: 1, shot: 0, points: frames.map(b) };
  const before = JSON.stringify([t0, t1]);
  const result = repairIdentities([t0, t1]);
  assert.equal(result.swaps, 0);
  assert.equal(result.dropped, 0);
  assert.deepEqual(result.tracks, [t0, t1]);
  assert.equal(JSON.stringify([t0, t1]), before);
});

test("repairIdentities: dancers of the same build side by side are left alone", () => {
  const frames = Array.from({ length: 60 }, (_, f) => f);
  const t0: Track = { id: 0, shot: 0, points: frames.map((f) => pointOf(f, 0.4, AVERAGE_BUILD)) };
  const t1: Track = { id: 1, shot: 0, points: frames.map((f) => pointOf(f, 0.6, AVERAGE_BUILD)) };
  const result = repairIdentities([t0, t1]);
  assert.equal(result.swaps, 0);
  assert.equal(result.dropped, 0);
});

test("repairIdentities: a dancer's points are not handed to a short piece that has no body shape", () => {
  // As on a real duo clip: the pose model measures limbs a little differently on every frame, and
  // linking left a one-frame piece beside the dancer. That piece has no body shape of its own, so
  // it must not be read as a better fit for the dancer's later frames.
  const wobble = (f: number): Build => ({
    ...LONG_LEGS,
    upperArm: LONG_LEGS.upperArm * (1 + 0.12 * Math.sin(3.1 * f)),
    forearm: LONG_LEGS.forearm * (1 + 0.12 * Math.cos(2.7 * f)),
    thigh: LONG_LEGS.thigh * (1 + 0.15 * Math.sin(1.7 * f)),
    shin: LONG_LEGS.shin * (1 + 0.15 * Math.cos(2.3 * f)),
  });
  const frames = Array.from({ length: 121 }, (_, f) => f);
  const dancer: Track = { id: 0, shot: 0, points: frames.map((f) => pointOf(f, 0.62, wobble(f))) };
  const piece: Track = { id: 1, shot: 0, points: [pointOf(40, 0.52, AVERAGE_BUILD)] };
  const result = repairIdentities([dancer, piece]);
  assert.equal(result.swaps, 0);
  assert.equal(result.swappedPoints, 0);
  assert.equal(result.tracks[0]!.points.length, 121);
  assert.equal(result.tracks[1]!.points.length, 1);
});

test("repairIdentities: tracks in different shots are never swapped", () => {
  const { a, b, frames } = crossing();
  const t0: Track = { id: 0, shot: 0, points: frames.map((f) => (f <= 20 ? a(f) : b(f))) };
  const t1: Track = { id: 1, shot: 1, points: frames.map((f) => (f <= 20 ? b(f) : a(f))) };
  assert.equal(repairIdentities([t0, t1]).swaps, 0);
});

test("repairIdentities: a few frames of the other dancer's pose while close are dropped to gaps", () => {
  const frames = Array.from({ length: 40 }, (_, f) => f);
  const other = (f: number) => pointOf(f, 0.62, LONG_ARMS, 0.15, 0.55);
  // Track 0 is the dancer on the left, but frames 15 to 18 show the dancer beside them.
  const t0: Track = { id: 0, shot: 0, points: frames.map((f) => (f >= 15 && f <= 18 ? other(f) : pointOf(f, 0.38, LONG_LEGS))) };
  const t1: Track = { id: 1, shot: 0, points: frames.map(other) };
  const result = repairIdentities([t0, t1]);
  assert.equal(result.dropped, 4);
  assert.deepEqual(result.tracks[0]!.points.filter((p) => p.frame >= 14 && p.frame <= 19).map((p) => p.frame), [14, 19]);
  assert.equal(result.tracks[1]!.points.length, 40);
});

test("repairIdentities: a leap with nobody near is kept", () => {
  const frames = Array.from({ length: 40 }, (_, f) => f);
  const t0: Track = { id: 0, shot: 0, points: frames.map((f) => pointOf(f, f >= 15 && f <= 18 ? 0.7 : 0.3, AVERAGE_BUILD)) };
  const result = repairIdentities([t0]);
  assert.equal(result.dropped, 0);
  assert.equal(result.tracks[0]!.points.length, 40);
});

test("repairIdentities: deterministic", () => {
  const { a, b, frames } = crossing();
  const make = (): Track[] => [
    { id: 0, shot: 0, points: frames.map((f) => (f <= 20 ? a(f) : b(f))) },
    { id: 1, shot: 0, points: frames.map((f) => (f <= 20 ? b(f) : a(f))) },
  ];
  assert.deepEqual(repairIdentities(make()), repairIdentities(make()));
});

test("crossingShare and rankCandidates: a person tangled with someone ranks below a clean one", () => {
  const frames = Array.from({ length: 30 }, (_, f) => f);
  // Two people of equal size, place and motion; the second has a third person on top of them for a third of the time.
  const clean: Track = { id: 0, shot: 0, points: frames.map((f) => pointOf(f, 0.4, AVERAGE_BUILD)) };
  const tangled: Track = { id: 1, shot: 0, points: frames.map((f) => pointOf(f, 0.6, AVERAGE_BUILD)) };
  const onTop: Track = { id: 2, shot: 0, points: frames.slice(0, 10).map((f) => pointOf(f, 0.62, AVERAGE_BUILD)) };
  assert.equal(crossingShare(clean, [clean, tangled, onTop]), 0);
  assert.ok(Math.abs(crossingShare(tangled, [clean, tangled, onTop]) - 1 / 3) < 1e-9);
  const ranked = rankCandidates([tangled, clean, onTop], { sampleHz: 5, frameCount: 30 });
  assert.equal(ranked[0]!.trackId, 0);
  assert.equal(ranked[1]!.trackId, 1);
});

test("rankCandidates: a clip that is all crossings still ranks its people", () => {
  const frames = Array.from({ length: 30 }, (_, f) => f);
  const t0: Track = { id: 0, shot: 0, points: frames.map((f) => pointOf(f, 0.5, AVERAGE_BUILD)) };
  const t1: Track = { id: 1, shot: 0, points: frames.map((f) => pointOf(f, 0.52, AVERAGE_BUILD)) };
  const ranked = rankCandidates([t0, t1], { sampleHz: 5, frameCount: 30 });
  assert.equal(ranked.length, 2);
  assert.ok(ranked.every((c) => c.score > 0));
});
