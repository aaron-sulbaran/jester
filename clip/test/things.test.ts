import assert from "node:assert/strict";
import { test } from "node:test";
import { scoreTrajectoryRound } from "../../engine/src/index.ts";
import { playerCopyingSprite, spritePath, timeline } from "../../engine/test/synth.ts";
import {
  boxEllipse, boxTrackAt, buildThingGuide, linkThings, rankThings, rejoinThings, THING_OTHER_SHOT, THING_STILL, thingGuides,
  thingHint, thingMoves, thingName, thingObjectName, withoutPeople,
} from "../src/index.ts";
import type { Box, ClipSource, ThingFrame, ThingTrack } from "../src/index.ts";

const HZ = 15;
const source: ClipSource = { width: 1280, height: 720, durationMs: 0, sampleHz: HZ };
const aspect = source.width / source.height;

/** `count` analysed frames at 15 per second, the detector looking at every third, things from `at(frame)`. */
function thingFrames(count: number, at: (frame: number) => { box: Box; category: string }[]): ThingFrame[] {
  return Array.from({ length: count }, (_, f) => ({
    tMs: (f * 1000) / HZ,
    things: f % 3 === 0 ? at(f).map((t) => ({ ...t, score: 0.9 })) : null,
  }));
}

const dogAt = (f: number): Box => ({ cx: 0.2 + f * 0.01, cy: 0.6, w: 0.2, h: 0.25 });
const ballAt = (cx: number): Box => ({ cx, cy: 0.5, w: 0.04, h: 0.07 });

test("linkThings: gaps between sightings are filled so every frame has a box", () => {
  const frames = thingFrames(31, (f) => [{ box: dogAt(f), category: "dog" }]);
  const tracks = linkThings(frames, [], { aspect });
  assert.equal(tracks.length, 1);
  const track = tracks[0]!;
  assert.deepEqual(track.points.map((p) => p.frame), Array.from({ length: 31 }, (_, f) => f));
  const filled = track.points[4]!;
  assert.equal(filled.detected, false);
  assert.ok(Math.abs(filled.box.cx - dogAt(4).cx) < 1e-9);
});

test("linkThings: two categories that overlap stay two tracks", () => {
  const frames = thingFrames(30, (f) => [{ box: dogAt(f), category: "dog" }, { box: dogAt(f), category: "cat" }]);
  const tracks = linkThings(frames, [], { aspect });
  assert.deepEqual(tracks.map((t) => t.category).sort(), ["cat", "dog"]);
});

test("linkThings: a fast small ball with no overlap between sightings stays one track", () => {
  const frames = thingFrames(30, (f) => [{ box: ballAt(0.1 + f * 0.025), category: "sports ball" }]);
  assert.equal(linkThings(frames, [], { aspect }).length, 1);
});

test("linkThings: a gap of 15 frames is bridged, a longer one starts a new track", () => {
  const seenUntil = (lastSeen: number, back: number) => (f: number) =>
    f <= lastSeen || f >= back ? [{ box: dogAt(0), category: "dog" }] : [];
  assert.equal(linkThings(thingFrames(45, seenUntil(12, 27)), []).length, 1);
  assert.equal(linkThings(thingFrames(45, seenUntil(12, 30)), []).length, 2);
});

test("linkThings: a cut ends the track", () => {
  const frames = thingFrames(30, () => [{ box: dogAt(0), category: "dog" }]);
  const tracks = linkThings(frames, [15]);
  assert.deepEqual(tracks.map((t) => t.shot), [0, 1]);
});

test("withoutPeople: a thing box that is mostly a person is dropped", () => {
  const frames = thingFrames(3, () => [{ box: dogAt(0), category: "dog" }, { box: ballAt(0.8), category: "sports ball" }]);
  const kept = withoutPeople(frames, frames.map(() => [dogAt(0)]));
  assert.deepEqual(kept[0]!.things!.map((t) => t.category), ["sports ball"]);
  assert.equal(kept[1]!.things, null);
});

test("rankThings: short tracks are dropped; a big moving thing outranks a small still one; labels number per category", () => {
  const frames = thingFrames(60, (f) => [
    { box: dogAt(f % 30), category: "dog" },
    { box: ballAt(0.8), category: "sports ball" },
    ...(f < 9 ? [{ box: { cx: 0.5, cy: 0.2, w: 0.1, h: 0.1 }, category: "cat" }] : []),
  ]);
  const tracks = linkThings(frames, [], { aspect });
  const ranked = rankThings(tracks, { sampleHz: HZ, frameCount: frames.length, aspect });
  assert.deepEqual(ranked.map((c) => c.label), ["Dog 1", "Ball 1"]);
  assert.deepEqual(ranked.map((c) => c.moves), [true, false]);
  assert.equal(thingName("sports ball"), "Ball");
});

test("buildThingGuide: a thing that never moves is refused", () => {
  const frames = thingFrames(30, () => [{ box: ballAt(0.5), category: "sports ball" }]);
  const track = linkThings(frames, [], { aspect })[0]!;
  const result = buildThingGuide({ fingerprint: "f", source, frames, track, shot: { start: 0, end: 30 }, label: "Ball 1", warnings: [] });
  assert.equal(result.error, THING_STILL);
  assert.equal(THING_STILL, "This one does not move, so there is nothing to copy.");
});

test("buildThingGuide: a moving thing gives a trajectory guide with a box track and an ellipse outline", () => {
  const frames = thingFrames(30, (f) => (f >= 6 ? [{ box: dogAt(f), category: "dog" }] : []));
  const track = linkThings(frames, [], { aspect })[0]!;
  const result = buildThingGuide({ fingerprint: "f", source, frames, track, shot: { start: 0, end: 30 }, label: "Dog 1", warnings: [] });
  assert.equal(result.error, null);
  const guide = result.data!;
  assert.deepEqual(guide.subject, { kind: "thing", label: "Dog 1" });
  assert.equal(guide.channel, "trajectory");
  assert.equal(guide.timeline, null);
  assert.deepEqual(guide.keyMoments, []);
  assert.equal(guide.boxTrack.schema, "box-track/1");
  assert.equal(guide.boxTrack.frames.length, 30);
  assert.equal(guide.boxTrack.frames[0]!.box, null);
  assert.deepEqual(guide.boxTrack.frames[6]!.box, dogAt(6));
  assert.equal(guide.outlines.length, 30);
  assert.equal(guide.outlines[0], null);
  assert.deepEqual(guide.outlines[6], boxEllipse(dogAt(6)));
  assert.equal(guide.outlines[6]!.length, 24);
});

test("a thing's box track scores against a player through the engine's trajectory channel", () => {
  // The engine's test sprite (lane changes, jumps, ducks), seen by the detector every third frame.
  const seconds = 12;
  const frames = thingFrames(seconds * HZ, (f) => [{ box: spritePath(f / HZ), category: "dog" }]);
  const tracks = linkThings(frames, [], { aspect });
  const candidates = rankThings(tracks, { sampleHz: HZ, frameCount: frames.length, aspect });
  const { guides, skipped } = thingGuides({ fingerprint: "f", source, frames, cuts: [], tracks, candidates, warnings: [] });
  assert.deepEqual(skipped, []);
  assert.equal(guides.length, 1);
  const player = timeline(playerCopyingSprite, { durationS: seconds });
  const result = scoreTrajectoryRound(guides[0]!.boxTrack, player);
  assert.equal(result.failure, null);
  assert.equal(typeof result.score, "number");
});

test("thingGuides: with a shot given, a thing in another shot is skipped with a reason", () => {
  const frames = thingFrames(60, (f) => [{ box: dogAt(f % 30), category: "dog" }]);
  const tracks = linkThings(frames, [30], { aspect });
  const candidates = rankThings(tracks, { sampleHz: HZ, frameCount: frames.length, aspect, cuts: [30] });
  const { guides, skipped } = thingGuides({ fingerprint: "f", source, frames, cuts: [30], tracks, candidates, warnings: [], shot: 0 });
  assert.equal(guides.length, 1);
  assert.deepEqual(skipped.map((s) => s.reason), [THING_OTHER_SHOT]);
});

test("thingHint, thingObjectName and boxTrackAt give what an object round needs", () => {
  const frames = thingFrames(30, (f) => [{ box: dogAt(f), category: "dog" }]);
  const track = linkThings(frames, [], { aspect })[0]!;
  const guide = buildThingGuide({ fingerprint: "f", source, frames, track, shot: { start: 0, end: 30 }, label: "Dog 1", warnings: [] }).data!;
  assert.equal(thingObjectName("Dog 1"), "dog");
  assert.equal(thingHint(guide), "Copy the dog: step sideways when it moves sideways.");
  assert.deepEqual(boxTrackAt(guide.boxTrack, 400), dogAt(6));
  assert.deepEqual(boxTrackAt(guide.boxTrack, 420), dogAt(6));
  assert.equal(boxTrackAt(guide.boxTrack, -1), null);
  assert.equal(boxTrackAt(guide.boxTrack, 5000), null);
});

// The Brain Rot pattern (bank clip brainrot-d1079c): one dancer in front of ONE parked red car, on a
// 720 x 1280 portrait clip, 30 s at 15 per second, the detector looking at every sixth frame. The car
// is seen either whole or as the right part the dancer does not cover, and linking split it into three
// pieces that hand off at one place. A fourth car crosses the left edge for 1.2 seconds.
const portrait: ClipSource = { width: 720, height: 1280, durationMs: 30000, sampleHz: HZ };
const tall = portrait.width / portrait.height;
const CLIP_FRAMES = 450;
const DETECT_EVERY = 6;
/** The part of the car the dancer leaves uncovered. */
const carPart: Box = { cx: 0.82, cy: 0.63, w: 0.36, h: 0.30 };
/** The whole car, reaching lower at the front. */
const carWhole: Box = { cx: 0.58, cy: 0.67, w: 0.82, h: 0.31 };
/** The dancer covers the front of the car for about 2.7 seconds at a time. */
const carAt = (f: number): Box => (Math.floor(f / 40) % 2 === 0 ? carPart : carWhole);
const blipAt = (f: number): Box => {
  const share = (f - 366) / 18;
  return { cx: 0.19 - 0.1 * share, cy: 0.61, w: 0.37 - 0.18 * share, h: 0.13 };
};

/** A thing track over frames `from` to `to`, seen on every sixth frame and filled in between. */
function piece(id: number, from: number, to: number, boxAt: (f: number) => Box): ThingTrack {
  const points = [];
  for (let f = from; f <= to; f++) {
    points.push({ frame: f, tMs: (f * 1000) / HZ, box: boxAt(f), detected: f % DETECT_EVERY === 0 });
  }
  return { id, category: "car", shot: 0, points };
}

const clipFrames = Array.from({ length: CLIP_FRAMES }, (_, f) => ({ tMs: (f * 1000) / HZ }));

/** The four cars the analysis found: Car 3, Car 1, Car 2 (one parked car) and the Car 4 blip. */
function brainRotPieces(): ThingTrack[] {
  return [
    piece(0, 18, 54, carAt), // 1.2 to 3.6 s
    piece(1, 54, 324, (f) => (f >= 276 ? carPart : carAt(f))), // 3.6 to 21.6 s, the part while Car 2 has the whole
    piece(2, 276, 444, (f) => (f <= 324 ? carWhole : carAt(f))), // 18.4 to 29.6 s
    piece(3, 366, 384, blipAt), // 24.4 to 25.6 s, 19 of 450 frames
  ];
}

test("rejoinThings: the three pieces of one parked car become one track, the blip stays apart", () => {
  const joined = rejoinThings(brainRotPieces(), clipFrames, { aspect: tall });
  assert.deepEqual(joined.map((t) => t.id), [0, 3]);
  const car = joined[0]!;
  assert.deepEqual(car.points.map((p) => p.frame), Array.from({ length: 444 - 18 + 1 }, (_, i) => 18 + i));
  // Where two pieces overlap, the larger box is kept: the whole car, not the uncovered part.
  assert.deepEqual(car.points.find((p) => p.frame === 300)!.box, carWhole);
  assert.equal(car.points.find((p) => p.frame === 300)!.detected, true);
});

test("rankThings: the Brain Rot pattern offers one car, not four, and it is still", () => {
  // Without the rejoin only the longest piece is on screen for half the clip, cut short to 3.6 to 21.6 s.
  const before = rankThings(brainRotPieces(), { sampleHz: HZ, frameCount: CLIP_FRAMES, aspect: tall });
  assert.deepEqual(before.map((c) => c.trackId), [1]);
  const joined = rejoinThings(brainRotPieces(), clipFrames, { aspect: tall });
  const ranked = rankThings(joined, { sampleHz: HZ, frameCount: CLIP_FRAMES, aspect: tall, cuts: [] });
  assert.deepEqual(ranked.map((c) => c.label), ["Car 1"]);
  // A parked car only changes shape as the dancer covers it, so there is nothing to copy.
  assert.deepEqual(ranked.map((c) => c.moves), [false]);
  const { guides, skipped } = thingGuides({
    fingerprint: "f", source: portrait, frames: clipFrames, cuts: [], tracks: joined, candidates: ranked, warnings: [],
  });
  assert.deepEqual(guides, []);
  assert.deepEqual(skipped.map((s) => s.reason), [THING_STILL]);
});

test("Brain Rot from detections: linking, rejoining and ranking leave one car", () => {
  const frames: ThingFrame[] = Array.from({ length: CLIP_FRAMES }, (_, f) => {
    if (f % DETECT_EVERY !== 0) return { tMs: (f * 1000) / HZ, things: null };
    const things = [];
    if (f >= 18 && f <= 444) things.push({ box: carAt(f), category: "car", score: 0.8 });
    // Twice the detector sees the whole car and its uncovered part as two cars.
    if (f === 54 || (f >= 276 && f <= 324)) things.push({ box: carAt(f) === carPart ? carWhole : carPart, category: "car", score: 0.6 });
    if (f >= 366 && f <= 384) things.push({ box: blipAt(f), category: "car", score: 0.5 });
    return { tMs: (f * 1000) / HZ, things };
  });
  const linked = linkThings(frames, [], { aspect: tall, maxGap: 30 });
  // Linking alone gives the same four cars as the analysis did: three pieces of the car and the blip.
  assert.equal(linked.length, 4);
  const joined = rejoinThings(linked, frames, { aspect: tall, maxGap: 45 });
  const ranked = rankThings(joined, { sampleHz: HZ, frameCount: CLIP_FRAMES, aspect: tall, cuts: [] });
  assert.deepEqual(ranked.map((c) => c.label), ["Car 1"]);
  assert.equal(ranked[0]!.moves, false);
});

test("rejoinThings: a thing lost for longer than linking bridges is joined where it comes back", () => {
  const frames = thingFrames(90, (f) => (f <= 21 || f >= 60 ? [{ box: dogAt(0), category: "dog" }] : []));
  const linked = linkThings(frames, [], { aspect, maxGap: 15 });
  assert.equal(linked.length, 2);
  const joined = rejoinThings(linked, frames, { aspect, maxGap: 45 });
  assert.equal(joined.length, 1);
  assert.deepEqual(joined[0]!.points.map((p) => p.frame), Array.from({ length: 88 }, (_, f) => f));
  // Too long a gap, a different category, another place or another shot each stay apart.
  assert.equal(rejoinThings(linked, frames, { aspect, maxGap: 30 }).length, 2);
  const cat = { ...linked[1]!, category: "cat" };
  assert.equal(rejoinThings([linked[0]!, cat], frames, { aspect, maxGap: 45 }).length, 2);
  const away = { ...linked[1]!, points: linked[1]!.points.map((p) => ({ ...p, box: { ...p.box, cx: p.box.cx + 0.6 } })) };
  assert.equal(rejoinThings([linked[0]!, away], frames, { aspect, maxGap: 45 }).length, 2);
  const nextShot = { ...linked[1]!, shot: 1 };
  assert.equal(rejoinThings([linked[0]!, nextShot], frames, { aspect, maxGap: 45 }).length, 2);
});

test("rejoinThings: two dogs side by side at the same time stay two", () => {
  const frames = thingFrames(60, (f) => [
    { box: dogAt(f), category: "dog" },
    { box: { ...dogAt(f), cx: dogAt(f).cx + 0.22 }, category: "dog" },
  ]);
  const linked = linkThings(frames, [], { aspect });
  assert.equal(linked.length, 2);
  assert.equal(rejoinThings(linked, frames, { aspect }).length, 2);
});

test("rankThings: a thing seen for under half its shot is not offered", () => {
  const frames = thingFrames(60, (f) => [
    { box: dogAt(f % 30), category: "dog" },
    ...(f >= 30 && f < 57 ? [{ box: ballAt(0.1 + (f - 30) * 0.02), category: "sports ball" }] : []),
  ]);
  const tracks = linkThings(frames, [], { aspect });
  // The ball is seen for 25 of 60 frames: over a second, but under half the clip.
  assert.deepEqual(rankThings(tracks, { sampleHz: HZ, frameCount: 60, aspect }).map((c) => c.label), ["Dog 1"]);
  // With a cut at 30 it has a shot of its own, and 25 of 30 frames is plenty.
  const split = linkThings(frames, [30], { aspect });
  const ranked = rankThings(split, { sampleHz: HZ, frameCount: 60, aspect, cuts: [30] });
  assert.deepEqual(ranked.map((c) => c.label).sort(), ["Ball 1", "Dog 1", "Dog 2"]);
});

test("thingMoves: things that really move still move; a box that only changes shape in place does not", () => {
  const moving = (boxAt: (f: number) => Box, frames = 60) =>
    thingMoves(linkThings(thingFrames(frames, (f) => [{ box: boxAt(f), category: "dog" }]), [], { aspect })[0]!, aspect);
  assert.equal(moving((f) => dogAt(f)), true, "a dog walking");
  assert.equal(moving((f) => ballAt(0.1 + f * 0.012)), true, "a ball rolling");
  assert.equal(moving((f) => ({ ...ballAt(0.5), cy: 0.5 - 0.2 * Math.abs(Math.sin(f / 6)) })), true, "a ball bouncing");
  assert.equal(moving((f) => ({ cx: 0.5, cy: 0.6, w: 0.08 + f * 0.003, h: 0.1 + f * 0.004 })), true, "a dog running at the camera");
  assert.equal(moving((f) => spritePath(f / HZ), 180), true, "the engine's test sprite");
  assert.equal(moving(() => ballAt(0.5)), false, "a ball lying still");
  const covered = (f: number): Box => (Math.floor(f / 12) % 2 === 0 ? { cx: 0.7, cy: 0.6, w: 0.2, h: 0.3 } : { cx: 0.55, cy: 0.62, w: 0.5, h: 0.32 });
  assert.equal(moving(covered), false, "a parked thing that someone keeps covering");
});
