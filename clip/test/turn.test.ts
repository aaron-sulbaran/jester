import assert from "node:assert/strict";
import { test } from "node:test";
import type { Landmark } from "../../engine/src/index.ts";
import { bodyTurns, frameTurn, widestSpread, type Guide } from "../src/index.ts";

const ASPECT = 16 / 9;
const DEG = Math.PI / 180;

/**
 * A body standing in the middle of a 16:9 frame, turned `yawDeg` about the vertical axis (positive
 * moves its left side away from the camera). Points are in units of image height, z away from the
 * camera; the tracker's depth is in units of image width, like x.
 */
function body(yawDeg: number, faceVisibility = 1) {
  const t = yawDeg * DEG;
  const parts: Record<number, [number, number, number]> = {
    0: [0, 0.2, -0.05], // nose, in front of the head
    7: [0.035, 0.21, 0], 8: [-0.035, 0.21, 0], // ears
    11: [0.09, 0.35, 0], 12: [-0.09, 0.35, 0], // shoulders
    23: [0.055, 0.6, 0], 24: [-0.055, 0.6, 0], // hips
  };
  const landmarks: Landmark[] = [];
  const depth: number[] = [];
  for (let i = 0; i < 33; i++) {
    const [x, y, z] = parts[i] ?? [0, 0.5, 0];
    const xr = x * Math.cos(t) - z * Math.sin(t);
    const zr = x * Math.sin(t) + z * Math.cos(t);
    const v = i === 0 || i === 7 || i === 8 ? faceVisibility : 1;
    landmarks.push([(0.5 * ASPECT + xr) / ASPECT, y + 0.1, v]);
    depth.push(zr / ASPECT);
  }
  return { landmarks, depth };
}

const near = (actual: number, expected: number, within = 2 * DEG) =>
  assert.ok(Math.abs(actual - expected) <= within, `expected ${(expected / DEG).toFixed(1)} deg, got ${(actual / DEG).toFixed(1)} deg`);

const frontWidest = widestSpread([body(0).landmarks], ASPECT);

test("frameTurn: square to the camera is no turn, face seen", () => {
  const { landmarks, depth } = body(0);
  for (const d of [depth, null]) {
    const turn = frameTurn(landmarks, d, ASPECT, frontWidest)!;
    near(turn.yaw, 0);
    assert.equal(turn.face, 1);
  }
});

test("frameTurn: with depth, the angle comes from how far one shoulder sits behind the other", () => {
  for (const deg of [30, -50, 75]) {
    const { landmarks, depth } = body(deg);
    near(frameTurn(landmarks, depth, ASPECT, frontWidest)!.yaw, deg * DEG);
  }
});

test("frameTurn: without depth, narrowness gives the size and the nose gives the side", () => {
  for (const deg of [60, -60, 35]) {
    const { landmarks } = body(deg);
    near(frameTurn(landmarks, null, ASPECT, frontWidest)!.yaw, deg * DEG);
  }
});

test("frameTurn: depth of the wrong length is ignored, not trusted", () => {
  const { landmarks } = body(60);
  near(frameTurn(landmarks, [0.1, 0.2], ASPECT, frontWidest)!.yaw, 60 * DEG);
});

test("frameTurn: in profile with one ear hidden, the seen ear stands in for the head's middle", () => {
  const { landmarks } = body(70);
  const hidden = landmarks.map((l, i): Landmark => (i === 7 ? [l[0], l[1], 0.1] : l));
  const turn = frameTurn(hidden, null, ASPECT, frontWidest)!;
  assert.ok(turn.yaw > 45 * DEG, `got ${(turn.yaw / DEG).toFixed(1)} deg`);
  assert.equal(turn.face, 1);
});

test("frameTurn: when the nose and ears are not clearly seen the turn fades to 0 and the face is gone", () => {
  for (const d of [true, false]) {
    const { landmarks, depth } = body(50, 0.1);
    const turn = frameTurn(landmarks, d ? depth : null, ASPECT, frontWidest)!;
    near(turn.yaw, 0);
    assert.equal(turn.face, 0);
  }
  const half = frameTurn(body(50, 0.5).landmarks, body(50).depth, ASPECT, frontWidest)!;
  assert.ok(half.face > 0 && half.face < 1);
  assert.ok(half.yaw > 0 && half.yaw < 50 * DEG);
});

test("frameTurn: a back with the nose and ears marked seen still reads as a back, from depth or from shoulder order", () => {
  // As on the test squat clip: the tracker gives the face full visibility on a turned back, without swapping sides.
  const { landmarks, depth } = body(180);
  for (const d of [depth, null]) {
    const turn = frameTurn(landmarks, d, ASPECT, frontWidest)!;
    assert.equal(turn.face, 0);
    near(turn.yaw, 0);
  }
  // Side on, nothing says back.
  assert.equal(frameTurn(body(80).landmarks, body(80).depth, ASPECT, frontWidest)!.face, 1);
  assert.equal(frameTurn(body(-80).landmarks, null, ASPECT, frontWidest)!.face, 1);
});

test("frameTurn: no landmarks, or no shoulders and hips, is unknown", () => {
  assert.equal(frameTurn(null, null, ASPECT, frontWidest), null);
  const { landmarks } = body(0);
  const noHips = landmarks.map((l, i): Landmark => (i === 23 ? [l[0], l[1], 0] : l));
  assert.equal(frameTurn(noHips, null, ASPECT, frontWidest), null);
});

test("widestSpread: a clip that never faces the camera still reads as turned", () => {
  const frames = Array.from({ length: 20 }, () => body(70).landmarks);
  const widest = widestSpread(frames, ASPECT);
  assert.ok(frameTurn(frames[0]!, null, ASPECT, widest)!.yaw > 45 * DEG);
});

test("widestSpread: one bent-over frame wider than the rest does not set it", () => {
  const frames = Array.from({ length: 30 }, (_, i) => (i === 7 ? body(0).landmarks.map((l, k): Landmark => (k >= 23 && k <= 24 ? [l[0], 0.4, 1] : l)) : body(0).landmarks));
  near(frameTurn(frames[0]!, null, ASPECT, widestSpread(frames, ASPECT))!.yaw, 0);
});

function guideOf(degs: (number | null)[], withDepth: boolean): Pick<Guide, "source" | "timeline" | "depths"> {
  const bodies = degs.map((d) => (d === null ? null : body(d)));
  return {
    source: { width: 1280, height: 720, durationMs: degs.length * 100, sampleHz: 10 },
    timeline: { schema: "pose-timeline/1", source: { width: 1280, height: 720, mirrored: false }, frames: bodies.map((b, i) => ({ tMs: i * 100, landmarks: b?.landmarks ?? null })) },
    ...(withDepth ? { depths: bodies.map((b) => b?.depth ?? null) } : {}),
  };
}

test("bodyTurns: one turn per timeline frame, a one-frame flip is damped by its neighbours", () => {
  const degs = [40, 40, 40, 40, -40, 40, 40, 40, 40];
  const turns = bodyTurns(guideOf(degs, true));
  assert.equal(turns.length, degs.length);
  assert.ok(turns[4]!.yaw > 0 && turns[4]!.yaw < 40 * DEG, `got ${(turns[4]!.yaw / DEG).toFixed(1)} deg`);
  near(turns[0]!.yaw, 40 * DEG, 20 * DEG);
});

test("bodyTurns: frames with nobody borrow their neighbours; a guide saved without depth still works", () => {
  const turns = bodyTurns(guideOf([60, 60, null, 60, 60, 0], false));
  assert.equal(turns.length, 6);
  assert.ok(turns[2]!.yaw > 30 * DEG);
  const empty = bodyTurns(guideOf([null, null, null, null, null, null, null], false));
  assert.deepEqual(empty.map((t) => t.yaw), [0, 0, 0, 0, 0, 0, 0]);
});

test("bodyTurns: a thing (no timeline) has no turns", () => {
  assert.deepEqual(bodyTurns({ source: { width: 1280, height: 720, durationMs: 1000, sampleHz: 10 }, timeline: null }), []);
});
