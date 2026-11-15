import assert from "node:assert/strict";
import { test } from "node:test";
import { constants, fromClipSamples, LIMBS, scorePoseRound, type ClipSample, type Landmark, type PoseTimeline } from "../../engine/src/index.ts";
import { makeSequenceTimeline } from "../../spikes/pose-match/synthetic.mjs";
import type { RoundRecord } from "../src/record.ts";
import { applySettings, asServed, honestRound, LIMB_ENDS, steadier, turningRate } from "../src/serving.ts";

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

const dance = (names: string[], idleDegrees = 0): PoseTimeline =>
  fromClipSamples(makeSequenceTimeline(names, { idleDegrees, aspect: 4 / 3 }) as ClipSample[], { width: 1333, height: 1000, timeUnit: "s" });

test("applySettings: a what-if changes the score, and undo puts the engine back exactly", () => {
  const reference = dance(["rest", "armsUp", "tPose", "leftArmUp", "squat", "rest"]);
  const player = dance(["rest", "tPose", "armsUp", "tPose", "squat", "rest"], 4);
  const before = scorePoseRound(reference, player).score;
  const applied = applySettings(["POSE.thetaInDeg=40", "LIMB.hands=0", "LIMB.rightForearm=1"]);
  assert.equal(applied.error, null);
  assert.equal(constants.POSE.thetaInDeg, 40);
  assert.equal(LIMBS.leftHand!.weight, 0);
  assert.equal(LIMBS.rightHand!.weight, 0);
  assert.equal(LIMBS.rightForearm!.weight, 1);
  const during = scorePoseRound(reference, player).score;
  assert.notEqual(during, before, "looser angles move the score");
  applied.data!();
  assert.equal(constants.POSE.thetaInDeg, 15);
  assert.equal(LIMBS.leftHand!.weight, 0.5);
  assert.equal(LIMBS.rightForearm!.weight, 1.5);
  assert.equal(scorePoseRound(reference, player).score, before);
});

test("applySettings: a bad setting is refused and changes nothing, even after a good one", () => {
  for (const bad of [["POSE.thetaInDeg=20", "POSE.nope=1"], ["POSE.thetaInDeg=20", "LIMB.tail=1"], ["POSE.thetaInDeg"], ["LIMB.hands=wide"]]) {
    const applied = applySettings(bad);
    assert.ok(applied.error, `refused: ${bad.join(", ")}`);
    assert.equal(constants.POSE.thetaInDeg, 15);
    assert.equal(LIMBS.leftHand!.weight, 0.5);
  }
});

test("turningRate: a busy dance turns faster than one that mostly stands", () => {
  const busy = turningRate(dance(["rest", "armsUp", "tPose", "squat", "armsUp", "rest"]))!;
  const calm = turningRate(dance(["rest", "rest", "rest", "rest", "armsUp", "rest"]))!;
  assert.ok(busy > calm * 1.5, `${busy} vs ${calm}`);
});
