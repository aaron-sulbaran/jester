import assert from "node:assert/strict";
import { test } from "node:test";
import type { Landmark, PoseTimeline } from "../../engine/src/index.ts";
import type { RoundRecord } from "../src/record.ts";
import { asServed, honestRound, LIMB_ENDS, steadier } from "../src/serving.ts";

/** 60 frames of a figure whose every joint shakes a little, the wrist (16) a lot. */
function shaky(): PoseTimeline {
  const frames = Array.from({ length: 60 }, (_, i) => ({
    tMs: (i * 1000) / 15,
    landmarks: Array.from({ length: 33 }, (_, k): Landmark => [0.3 + 0.01 * k + (k === 16 ? 0.04 : 0.002) * Math.sin(0.9 * i + k), 0.5 + 0.005 * k, 1]),
  }));
  return { schema: "pose-timeline/1", source: { width: 720, height: 1280, mirrored: false }, frames };
}

const jitter = (t: PoseTimeline, k: number) => {
  let total = 0;
  for (let i = 1; i < t.frames.length; i++) total += Math.abs(t.frames[i]!.landmarks![k]![0] - t.frames[i - 1]!.landmarks![k]![0]);
  return total / (t.frames.length - 1);
};

test("steadier: smooths the chosen joints more and leaves the others exactly as served", () => {
  const raw = shaky();
  const served = asServed(raw);
  const ends = steadier(raw, LIMB_ENDS, 3);
  assert.ok(jitter(ends, 16) < jitter(served, 16) * 0.7, "the wrist shakes less");
  for (const k of [0, 11, 12, 23, 24]) assert.deepEqual(ends.frames.map((f) => f.landmarks![k]), served.frames.map((f) => f.landmarks![k]));
  assert.equal(ends.frames.length, served.frames.length);
});

/** A recorded round with just the fields honestRound reads. */
function round(over: { tag?: RoundRecord["tag"]; camera?: boolean; lagMs?: number; score?: number | null; bankId?: string | null; channel?: "pose" | "trajectory" }): RoundRecord {
  return {
    channel: over.channel ?? "pose", tag: over.tag ?? null,
    clip: { key: "k", bankId: over.bankId === undefined ? "neon-wall-groove" : over.bankId, title: null, subject: "Person 1" },
    device: { userAgent: "", gpu: null, camera: over.camera === false ? null : { label: "cam", width: 640, height: 480, frameRate: 30 }, playerFps: 30 },
    result: { score: over.score === undefined ? 80 : over.score, lagMs: over.lagMs ?? 700 },
  } as unknown as RoundRecord;
}

test("honestRound: nailed rounds count; untagged ones only from a real camera that lagged like a person", () => {
  assert.equal(honestRound(round({ tag: "nailed", lagMs: 100 })), "nailed");
  assert.equal(honestRound(round({})), "untagged");
  assert.equal(honestRound(round({ lagMs: 133 })), null, "a simulated player's lag");
  assert.equal(honestRound(round({ camera: false })), null, "no camera: headless or simulated");
  assert.equal(honestRound(round({ tag: "stood-still" })), null);
  assert.equal(honestRound(round({ score: null })), null);
  assert.equal(honestRound(round({ bankId: null })), null, "not a bank clip");
  assert.equal(honestRound(round({ channel: "trajectory" })), null, "a hand, head or foot play or a thing");
});
