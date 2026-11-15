import { test } from "node:test";
import assert from "node:assert/strict";
import { smoothTimeline } from "../src/smooth.ts";
import type { Landmark, PoseTimeline } from "../src/types.ts";

const POINTS = 33;
/** A person whose every point sits at (x, y), with visibility v. */
const pose = (x: number, y: number, v = 0.9): Landmark[] => Array.from({ length: POINTS }, () => [x, y, v] as const);
const timeline = (frames: (Landmark[] | null)[]): PoseTimeline => ({
  schema: "pose-timeline/1", source: { width: 720, height: 1280, mirrored: false },
  frames: frames.map((landmarks, i) => ({ tMs: Math.round((i * 1000) / 15), landmarks })),
});
const xAt = (t: PoseTimeline, i: number) => t.frames[i]!.landmarks![0]![0];

test("keeps frame count and times", () => {
  const raw = timeline(Array.from({ length: 20 }, (_, i) => pose(0.3 + i * 0.01, 0.5)));
  const out = smoothTimeline(raw);
  assert.equal(out.frames.length, raw.frames.length);
  assert.deepEqual(out.frames.map((f) => f.tMs), raw.frames.map((f) => f.tMs));
});

test("a steady movement stays where it was", () => {
  const raw = timeline(Array.from({ length: 30 }, (_, i) => pose(0.2 + i * 0.01, 0.5)));
  const out = smoothTimeline(raw);
  for (let i = 3; i < 27; i++) assert.ok(Math.abs(xAt(out, i) - xAt(raw, i)) < 1e-6, `frame ${i}`);
});

test("a one-frame spike is removed", () => {
  const frames = Array.from({ length: 21 }, () => pose(0.5, 0.5));
  frames[10] = pose(0.9, 0.1); // the tracker threw every point across the frame for one frame
  const out = smoothTimeline(timeline(frames));
  assert.ok(Math.abs(xAt(out, 10) - 0.5) < 0.01, `x at the spike: ${xAt(out, 10)}`);
});

test("jitter is softened", () => {
  // Points shaking 0.04 back and forth every frame around a still person.
  const raw = timeline(Array.from({ length: 40 }, (_, i) => pose(0.5 + (i % 2 ? 0.02 : -0.02), 0.5)));
  const out = smoothTimeline(raw);
  let rawMove = 0, outMove = 0;
  for (let i = 6; i < 34; i++) { rawMove += Math.abs(xAt(raw, i) - xAt(raw, i - 1)); outMove += Math.abs(xAt(out, i) - xAt(out, i - 1)); }
  assert.ok(outMove < rawMove * 0.25, `moved ${outMove.toFixed(3)} vs raw ${rawMove.toFixed(3)}`);
});

test("short gaps are filled, long ones stay empty", () => {
  const frames: (Landmark[] | null)[] = Array.from({ length: 40 }, (_, i) => pose(0.2 + i * 0.01, 0.5));
  for (let i = 10; i < 13; i++) frames[i] = null; // 3 frames: filled
  for (let i = 25; i < 35; i++) frames[i] = null; // 10 frames: left empty
  const out = smoothTimeline(timeline(frames));
  for (let i = 10; i < 13; i++) assert.ok(out.frames[i]!.landmarks, `frame ${i} filled`);
  assert.ok(Math.abs(xAt(out, 11) - (0.2 + 11 * 0.01)) < 0.005);
  for (let i = 25; i < 35; i++) assert.equal(out.frames[i]!.landmarks, null, `frame ${i} empty`);
});

test("an unsure point is pulled toward its sure neighbours", () => {
  const frames = Array.from({ length: 21 }, () => pose(0.5, 0.5, 0.95));
  frames[9] = pose(0.6, 0.5, 0.05);
  frames[10] = pose(0.6, 0.5, 0.05);
  frames[11] = pose(0.6, 0.5, 0.05);
  const out = smoothTimeline(timeline(frames));
  assert.ok(xAt(out, 10) < 0.58, `x ${xAt(out, 10)}`);
});

test("with no fill limit and held ends, every frame gets a best guess", () => {
  const frames: (Landmark[] | null)[] = Array.from({ length: 40 }, (_, i) => pose(0.2 + i * 0.01, 0.5));
  for (let i = 0; i < 4; i++) frames[i] = null;
  for (let i = 15; i < 30; i++) frames[i] = null; // a whole second lost
  for (let i = 36; i < 40; i++) frames[i] = null;
  const out = smoothTimeline(timeline(frames), { maxFill: Infinity, holdEnds: true });
  assert.ok(out.frames.every((f) => f.landmarks), "no empty frame");
  assert.ok(Math.abs(xAt(out, 22) - (0.2 + 22 * 0.01)) < 0.005, `straight line across the gap: ${xAt(out, 22)}`);
  assert.ok(Math.abs(xAt(out, 0) - 0.24) < 0.001 && Math.abs(xAt(out, 3) - 0.24) < 0.005, `start held at the first pose: ${xAt(out, 0)}`);
  assert.ok(Math.abs(xAt(out, 39) - 0.55) < 0.001, `end held at the last pose: ${xAt(out, 39)}`);
});
