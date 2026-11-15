import assert from "node:assert/strict";
import { test } from "node:test";
import type { Landmark } from "../../engine/src/index.ts";
import { boneLengths, facingOf, liftPose, type Guide } from "../src/index.ts";

const W = 1280, H = 720, DEG = Math.PI / 180;
type V = [number, number, number];

/** A body in metres (x to its left, y up, z away), turned `yawDeg`, with a knee lifted forward by `kneeUp`. */
function body(yawDeg: number, kneeUp = 0) {
  const j: Record<number, V> = {
    0: [0, 1.62, -0.1], 7: [0.075, 1.6, 0], 8: [-0.075, 1.6, 0],
    11: [0.18, 1.42, 0], 12: [-0.18, 1.42, 0], 13: [0.2, 1.15, 0], 14: [-0.2, 1.15, 0], 15: [0.2, 0.9, 0], 16: [-0.2, 0.9, 0],
    23: [0.1, 0.92, 0], 24: [-0.1, 0.92, 0], 25: [0.1, 0.5 + kneeUp * 0.4, -kneeUp * 0.4], 26: [-0.1, 0.5, 0],
    27: [0.1, 0.08 + kneeUp * 0.4, -kneeUp * 0.4], 28: [-0.1, 0.08, 0], 29: [0.1, 0.03, 0.05], 30: [-0.1, 0.03, 0.05], 31: [0.11, 0.0, -0.15], 32: [-0.11, 0.0, -0.15],
  };
  const t = yawDeg * DEG, s = 0.4;
  const lm: Landmark[] = [], depth: number[] = [];
  for (let i = 0; i < 33; i++) {
    const p = j[i];
    if (!p) { lm.push([0.5, 0.2, 0]); depth.push(0); continue; }
    const xr = p[0] * Math.cos(t) - p[2] * Math.sin(t), zr = p[0] * Math.sin(t) + p[2] * Math.cos(t);
    lm.push([0.5 + (xr * s * H) / W, 0.95 - p[1] * s, 1]);
    depth.push((zr * s * H) / W);
  }
  return { lm, depth };
}

const front = body(0);
const guide: Pick<Guide, "source" | "timeline"> = {
  source: { width: W, height: H, durationMs: 1000, sampleHz: 10 },
  timeline: { schema: "pose-timeline/1", source: { width: W, height: H, mirrored: false }, frames: [{ tMs: 0, landmarks: front.lm }] },
};
const lengths = boneLengths(guide);
const len3 = (a: V, b: V) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test("facingOf: the face toward us keeps the yaw, the back turns it round", () => {
  assert.equal(facingOf({ yaw: 0.5, face: 1 }), 0.5);
  assert.ok(Math.abs(Math.abs(facingOf({ yaw: 0, face: 0 })) - Math.PI) < 1e-9);
  assert.ok(Math.abs(facingOf({ yaw: 0.3, face: 0.5 }) - Math.PI / 2) < 1e-9);
});

test("liftPose: every joint stays where the tracker put it on screen", () => {
  const { joints } = liftPose(front.lm, front.depth, { yaw: 0, face: 1 }, lengths, W, H);
  for (const i of [11, 13, 15, 23, 25, 27]) {
    assert.ok(Math.abs(joints[i]![0] - front.lm[i]![0] * W) < 1e-6);
    assert.ok(Math.abs(joints[i]![1] - front.lm[i]![1] * H) < 1e-6);
  }
});

test("liftPose: a shortened bone keeps its full length, pointing the way the tracker says", () => {
  const kick = body(0, 1);
  const { joints } = liftPose(kick.lm, kick.depth, { yaw: 0, face: 1 }, lengths, W, H);
  const thigh = len3(joints[23] as V, joints[25] as V);
  assert.ok(Math.abs(thigh - lengths.thigh) < 1, `thigh ${thigh.toFixed(1)} vs ${lengths.thigh.toFixed(1)}`);
  // The raised knee comes toward the camera.
  assert.ok(joints[25]![2] < joints[23]![2]);
});

test("liftPose: without depth, a shortened thigh still goes forward, toward the camera when facing it", () => {
  const kick = body(0, 1);
  const { joints } = liftPose(kick.lm, null, { yaw: 0, face: 1 }, lengths, W, H);
  assert.ok(joints[25]![2] < joints[23]![2]);
  const back = liftPose(kick.lm, null, { yaw: 0, face: 0 }, lengths, W, H);
  assert.ok(back.joints[25]![2] > back.joints[23]![2], "with the back to us, forward is away");
});

test("liftPose: turned, the far shoulder sits behind the near one", () => {
  const turned = body(60);
  const { joints, facing } = liftPose(turned.lm, turned.depth, { yaw: 60 * DEG, face: 1 }, lengths, W, H);
  assert.ok(Math.abs(facing - 60 * DEG) < 1e-9);
  assert.ok(joints[11]![2] > joints[12]![2], "left shoulder farther as the body faces the image's right");
});

test("liftPose: nobody in the frame gives no joints", () => {
  const { joints } = liftPose(null, null, { yaw: 0, face: 1 }, lengths, W, H);
  assert.equal(joints.every((j) => j === null), true);
});
