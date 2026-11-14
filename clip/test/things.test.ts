import assert from "node:assert/strict";
import { test } from "node:test";
import { scoreTrajectoryRound } from "../../engine/src/index.ts";
import { playerCopyingSprite, spritePath, timeline } from "../../engine/test/synth.ts";
import {
  boxPolygon, buildThingGuide, linkThings, rankThings, THING_STILL, thingGuides, thingName, withoutPeople,
} from "../src/index.ts";
import type { Box, ClipSource, ThingFrame } from "../src/index.ts";

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

test("buildThingGuide: a moving thing gives a trajectory guide with a box track and a four point outline", () => {
  const frames = thingFrames(30, (f) => (f >= 6 ? [{ box: dogAt(f), category: "dog" }] : []));
  const track = linkThings(frames, [], { aspect })[0]!;
  const result = buildThingGuide({ fingerprint: "f", source, frames, track, shot: { start: 0, end: 30 }, label: "Dog 1", warnings: [] });
  assert.equal(result.error, null);
  const { guide, outline } = result.data!;
  assert.deepEqual(guide.subject, { kind: "thing", label: "Dog 1" });
  assert.equal(guide.channel, "trajectory");
  assert.equal(guide.timeline, null);
  assert.deepEqual(guide.keyMoments, []);
  assert.equal(guide.boxTrack.schema, "box-track/1");
  assert.equal(guide.boxTrack.frames.length, 30);
  assert.equal(guide.boxTrack.frames[0]!.box, null);
  assert.deepEqual(guide.boxTrack.frames[6]!.box, dogAt(6));
  assert.equal(outline.length, 30);
  assert.equal(outline[0]!.points, null);
  assert.deepEqual(outline[6]!.points, boxPolygon(dogAt(6)));
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
  const result = scoreTrajectoryRound(guides[0]!.guide.boxTrack, player);
  assert.equal(result.failure, null);
  assert.equal(typeof result.score, "number");
});
