import assert from "node:assert/strict";
import { test } from "node:test";
import { linkTracks } from "../src/index.ts";
import type { Box } from "../src/index.ts";
import { frame, person } from "./synth.ts";

const box = (cx: number, cy = 0.5, w = 0.1, h = 0.4): Box => ({ cx, cy, w, h });

test("linkTracks: one person across 30 frames is one track of 30 points", () => {
  const frames = Array.from({ length: 30 }, (_, i) => frame(i, [person(box(0.3 + i * 0.005))]));
  const tracks = linkTracks(frames, []);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]!.points.length, 30);
  assert.equal(tracks[0]!.shot, 0);
  assert.equal(tracks[0]!.points[7]!.frame, 7);
  assert.equal(tracks[0]!.points[7]!.tMs, 700);
});

test("linkTracks: a gap of 3 frames keeps one track, a gap of 8 makes two", () => {
  const build = (missing: number) =>
    Array.from({ length: 30 }, (_, i) => frame(i, i >= 10 && i < 10 + missing ? [] : [person(box(0.5))]));
  assert.equal(linkTracks(build(3), []).length, 1);
  assert.equal(linkTracks(build(8), []).length, 2);
});

test("linkTracks: two people side by side keep stable ids", () => {
  const frames = Array.from({ length: 20 }, (_, i) =>
    frame(i, [person(box(0.25 + i * 0.002)), person(box(0.75 - i * 0.002))]));
  const tracks = linkTracks(frames, []);
  assert.equal(tracks.length, 2);
  assert.deepEqual(tracks.map((t) => t.id), [0, 1]);
  for (const t of tracks) assert.equal(t.points.length, 20);
  assert.ok(tracks[0]!.points.every((p) => p.box.cx < 0.5));
  assert.ok(tracks[1]!.points.every((p) => p.box.cx > 0.5));
});

test("linkTracks: two people walking through each other stay two tracks", () => {
  const count = 31;
  const frames = Array.from({ length: count }, (_, i) => {
    const t = i / (count - 1);
    // Same size and height, so overlap alone cannot tell them apart at the crossing.
    const leftToRight = person(box(0.2 + 0.6 * t));
    const rightToLeft = person(box(0.8 - 0.6 * t));
    return frame(i, [leftToRight, rightToLeft]);
  });
  const tracks = linkTracks(frames, []);
  assert.equal(tracks.length, 2);
  const starts = tracks.map((t) => t.points[0]!.box.cx);
  const ends = tracks.map((t) => t.points[t.points.length - 1]!.box.cx);
  const fromLeft = starts.findIndex((x) => x < 0.5);
  const fromRight = starts.findIndex((x) => x > 0.5);
  assert.ok(ends[fromLeft]! > 0.5, "the track that began on the left ends on the right");
  assert.ok(ends[fromRight]! < 0.5, "the track that began on the right ends on the left");
  for (const t of tracks) assert.equal(t.points.length, count);
});

test("linkTracks: a cut ends every track and moves on to the next shot", () => {
  const frames = Array.from({ length: 20 }, (_, i) => frame(i, [person(box(0.5))]));
  const tracks = linkTracks(frames, [10]);
  assert.equal(tracks.length, 2);
  assert.deepEqual(tracks.map((t) => t.shot), [0, 1]);
  assert.equal(tracks[0]!.points.length, 10);
  assert.equal(tracks[1]!.points[0]!.frame, 10);
});
