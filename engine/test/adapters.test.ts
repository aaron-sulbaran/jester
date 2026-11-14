import assert from "node:assert/strict";
import { test } from "node:test";
import { fromClipSamples, fromWebcamFrames, scorePoseRound, type WebcamFrame } from "../src/index.ts";
import { dance, landmarks, mirrorCopy } from "./synth.ts";

const toObjects = (lms: ReturnType<typeof landmarks>) => lms.map(([x, y, visibility]) => ({ x, y, z: 0, visibility }));

test("webcam adapter: Lisa's frame shape becomes a timeline on the clip clock", () => {
  const frames: WebcamFrame[] = [
    { t: 900, landmarks: toObjects(landmarks(dance(0))), aspect: 16 / 9, mirrored: false },
    { t: 1000, landmarks: toObjects(landmarks(dance(0.1))), aspect: 16 / 9, mirrored: false },
    { t: 1033, landmarks: null, aspect: 16 / 9, mirrored: false },
  ];
  const tl = fromWebcamFrames(frames, { trackerTimeAtClipStartMs: 1000 });
  assert.equal(tl.frames.length, 2, "frames before the clip started are dropped");
  assert.equal(tl.frames[0]!.tMs, 0);
  assert.equal(tl.frames[1]!.landmarks, null);
  assert.ok(Math.abs(tl.source.width / tl.source.height - 16 / 9) < 1e-3);
  assert.deepEqual(tl.frames[0]!.landmarks![11]!.length, 3);
});

test("webcam adapter: per-frame clip time wins over the offset", () => {
  const tl = fromWebcamFrames([{ t: 5000, clipTimeMs: 40, landmarks: null, aspect: 4 / 3 }], { trackerTimeAtClipStartMs: 1000 });
  assert.equal(tl.frames[0]!.tMs, 40);
});

test("end to end: clip samples in seconds and webcam frames in tracker time score a perfect copy at 100", () => {
  const clip = fromClipSamples(
    Array.from({ length: 301 }, (_, i) => ({ t: i / 30, landmarks: toObjects(landmarks(dance(i / 30), 16 / 9)) })),
    { width: 1920, height: 1080, timeUnit: "s" },
  );
  // Webcam at an uneven ~28 fps, tracker started 2.5 s before the clip.
  const cam: WebcamFrame[] = [];
  for (let k = 0; k < 400; k++) {
    const t = 2500 + k * 35.7;
    cam.push({ t, landmarks: toObjects(landmarks(mirrorCopy(dance((t - 2500) / 1000)), 4 / 3)), aspect: 4 / 3, mirrored: false });
  }
  const r = scorePoseRound(clip, fromWebcamFrames(cam, { trackerTimeAtClipStartMs: 2500 }));
  assert.equal(r.score, 100, JSON.stringify({ acc: r.accuracy, lag: r.lagMs, valid: r.validShare }));
});
