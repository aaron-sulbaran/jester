import assert from "node:assert/strict";
import { test } from "node:test";
import { skeletonGate } from "../../engine/src/index.ts";
import { buildGuide, linkTracks } from "../src/index.ts";
import type { Box, ClipSource } from "../src/index.ts";
import { frame, outlineOfBox, person } from "./synth.ts";

const source: ClipSource = { width: 1280, height: 720, durationMs: 4000, sampleHz: 10 };
const boxAt = (i: number): Box => ({ cx: 0.3 + i * 0.004, cy: 0.5, w: 0.2, h: 0.5 });

// 40 frames, 100 ms apart; the person is missing for frames 10 to 14 and a cut starts a new shot at frame 20.
const frames = Array.from({ length: 40 }, (_, i) => frame(i, i >= 10 && i < 15 ? [] : [person(boxAt(i))]));
const tracks = linkTracks(frames, [20]);
const track = tracks.find((t) => t.shot === 1)!;
const input = { fingerprint: "abc123", source, frames, track, shot: { start: 20, end: 40 }, label: "Person 1", warnings: ["careful"] };

test("buildGuide: timeline time starts at 0 at the shot's first frame and range holds media time", () => {
  const guide = buildGuide(input);
  assert.equal(guide.timeline!.frames[0]!.tMs, 0);
  assert.equal(guide.timeline!.frames[19]!.tMs, 1900);
  assert.deepEqual(guide.range, { startMs: 2000, endMs: 3900 });
  assert.equal(guide.timeline!.frames.length, 20);
});

test("buildGuide: frames in the shot where the track has no point are null", () => {
  const gap = { ...input, frames: frames.map((f, i) => (i >= 25 && i < 28 ? { ...f, people: [] } : f)) };
  const guide = buildGuide({ ...gap, track: linkTracks(gap.frames, [20]).find((t) => t.shot === 1)! });
  for (const i of [5, 6, 7]) {
    assert.equal(guide.timeline!.frames[i]!.landmarks, null);
    assert.equal(guide.boxTrack.frames[i]!.box, null);
  }
  assert.notEqual(guide.timeline!.frames[4]!.landmarks, null);
  assert.deepEqual(guide.boxTrack.frames[4]!.box, boxAt(24));
});

test("buildGuide: box track and timeline have equal length and the same times", () => {
  const guide = buildGuide(input);
  assert.equal(guide.boxTrack.frames.length, guide.timeline!.frames.length);
  assert.deepEqual(guide.boxTrack.frames.map((f) => f.tMs), guide.timeline!.frames.map((f) => f.tMs));
});

test("buildGuide: sources, schema, subject, channel and pass-through fields", () => {
  const guide = buildGuide(input);
  assert.equal(guide.schema, "guide/1");
  assert.equal(guide.fingerprint, "abc123");
  assert.deepEqual(guide.source, source);
  assert.deepEqual(guide.subject, { kind: "person", label: "Person 1" });
  assert.deepEqual(guide.warnings, ["careful"]);
  assert.equal(guide.check, null);
  assert.equal(guide.timeline!.schema, "pose-timeline/1");
  assert.deepEqual(guide.timeline!.source, { width: 1280, height: 720, mirrored: false });
  assert.equal(guide.boxTrack.schema, "box-track/1");
  assert.deepEqual(guide.boxTrack.source, { width: 1280, height: 720 });
  assert.equal(guide.channel, skeletonGate(guide.timeline!).channel);
  assert.ok(["slow", "medium", "fast"].includes(guide.pace));
  assert.ok(Array.isArray(guide.keyMoments));
});

test("buildGuide: the same input twice gives deep-equal results", () => {
  assert.deepEqual(buildGuide(input), buildGuide(input));
});

test("buildGuide: outlines has one entry per timeline frame", () => {
  const guide = buildGuide(input);
  assert.equal(guide.outlines.length, guide.timeline!.frames.length);
});

test("buildGuide: a frame where the track has no point has a null outline", () => {
  const gap = { ...input, frames: frames.map((f, i) => (i >= 25 && i < 28 ? { ...f, people: [] } : f)) };
  const guide = buildGuide({ ...gap, track: linkTracks(gap.frames, [20]).find((t) => t.shot === 1)! });
  for (const i of [5, 6, 7]) assert.equal(guide.outlines[i], null);
  assert.notEqual(guide.outlines[4], null);
});

test("buildGuide: a point's outline is carried through unchanged", () => {
  const guide = buildGuide(input);
  assert.deepEqual(guide.outlines[3], outlineOfBox(boxAt(23)));
});

test("buildGuide: the tracker's depth rides along per frame, and guides without it have no depths", () => {
  const depthOf = (i: number) => Array.from({ length: 33 }, (_, k) => (k + i) / 1000);
  const deep = frames.map((f, i) => ({ ...f, people: f.people.map((p) => ({ ...p, depth: depthOf(i) })) }));
  const guide = buildGuide({ ...input, frames: deep, track: linkTracks(deep, [20]).find((t) => t.shot === 1)! });
  assert.equal(guide.depths!.length, guide.timeline!.frames.length);
  assert.deepEqual(guide.depths![3], depthOf(23));
  assert.equal("depths" in buildGuide(input), false);
});

test("buildGuide: depth never changes the timeline the scorer reads", () => {
  const deep = frames.map((f) => ({ ...f, people: f.people.map((p) => ({ ...p, depth: Array(33).fill(0.2) })) }));
  const withDepth = buildGuide({ ...input, frames: deep, track: linkTracks(deep, [20]).find((t) => t.shot === 1)! });
  assert.deepEqual(withDepth.timeline, buildGuide(input).timeline);
  assert.deepEqual(withDepth.keyMoments, buildGuide(input).keyMoments);
});
