import assert from "node:assert/strict";
import { test } from "node:test";
import { skeletonGate } from "../src/index.ts";
import { dance, timeline } from "./synth.ts";

test("gate: a clean human dance uses the pose channel", () => {
  const g = skeletonGate(timeline(dance, { durationS: 10 }));
  assert.equal(g.usable, true, g.reasons.join("; "));
  assert.equal(g.channel, "pose");
});

test("gate: a subject the tracker mostly misses falls back to trajectory", () => {
  const g = skeletonGate(timeline(dance, { durationS: 10, drop: (i) => i % 2 === 0 }));
  assert.equal(g.channel, "trajectory");
});

test("gate: low-confidence joints (a cartoon) fall back to trajectory", () => {
  const g = skeletonGate(timeline(dance, { durationS: 10, visibility: () => 0.3 }));
  assert.equal(g.channel, "trajectory");
});
