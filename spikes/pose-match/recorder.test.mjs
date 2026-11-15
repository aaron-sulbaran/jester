import { test } from "node:test";
import assert from "node:assert/strict";
import { PerformanceRecorder } from "./recorder.mjs";
import { serializeTimeline, deserializeTimeline } from "./serialize.mjs";
import { makeStickPose, POSES } from "./synthetic.mjs";

const pose = makeStickPose(POSES.tPose);
const frame = { landmarks: pose, outline: [[0.1, 0.2], [0.5, 0.9], [0.9, 0.2]] };

test("countdown and out-of-order frames are ignored", () => {
  const r = new PerformanceRecorder();
  assert.equal(r.add(frame, -500), false);
  assert.equal(r.add(frame, 100), true);
  assert.equal(r.add(frame, 100), false);
  assert.equal(r.add(frame, 50), false);
  assert.equal(r.finish().frames.length, 1);
});

test("lost frames lower coverage but keep the timeline", () => {
  const r = new PerformanceRecorder();
  r.add(frame, 0); r.add(null, 33); r.add({ landmarks: null }, 66); r.add(frame, 100);
  const t = r.finish({ durationMs: 120 });
  assert.equal(t.frames.length, 2);
  assert.equal(t.coverage, 0.5);
  assert.equal(t.durationMs, 120);
});

test("the recorder never keeps the mask", () => {
  const r = new PerformanceRecorder();
  r.add({ landmarks: pose, outline: null, mask: { width: 4, height: 4, data: new Uint8Array(16) } }, 0);
  assert.equal("mask" in r.finish().frames[0], false);
});

test("frame cap stops recording", () => {
  const r = new PerformanceRecorder({ maxFrames: 3 });
  for (let i = 0; i < 10; i++) r.add(frame, i * 33);
  assert.equal(r.finish().frames.length, 3);
});

test("serialize round trip keeps positions within 0.002 and outline points", () => {
  const r = new PerformanceRecorder();
  for (let i = 0; i < 5; i++) r.add(frame, i * 33);
  const original = r.finish({ aspect: 16 / 9 });
  const back = deserializeTimeline(JSON.parse(JSON.stringify(serializeTimeline(original))));
  assert.equal(back.frames.length, 5);
  assert.equal(back.aspect, 16 / 9);
  back.frames[0].landmarks.forEach((p, i) => {
    assert.ok(Math.abs(p.x - pose[i].x) < 0.002 && Math.abs(p.y - pose[i].y) < 0.002);
    assert.ok(Math.abs(p.visibility - (pose[i].visibility ?? 1)) <= 0.01);
  });
  assert.equal(back.frames[0].outline.length, 3);
});

test("slightly off-screen joints survive and the compact form is much smaller", () => {
  const off = pose.map((p, i) => (i === 27 ? { ...p, y: 1.2 } : p));
  const r = new PerformanceRecorder();
  for (let i = 0; i < 30; i++) r.add({ landmarks: off, outline: null }, i * 33);
  const timeline = r.finish();
  const back = deserializeTimeline(serializeTimeline(timeline));
  assert.ok(Math.abs(back.frames[0].landmarks[27].y - 1.2) < 0.002);
  assert.ok(JSON.stringify(serializeTimeline(timeline)).length < JSON.stringify(timeline).length / 2);
});

test("unknown formats are rejected", () => {
  assert.throws(() => deserializeTimeline({ v: 2 }));
  assert.throws(() => deserializeTimeline(null));
});

test("every: 2 keeps half the frames and stays readable", () => {
  const r = new PerformanceRecorder();
  for (let i = 0; i < 10; i++) r.add(frame, i * 33);
  const timeline = r.finish();
  const data = serializeTimeline(timeline, { every: 2 });
  assert.equal(data.f.length, 5);
  assert.equal(deserializeTimeline(data).frames.length, 5);
});
