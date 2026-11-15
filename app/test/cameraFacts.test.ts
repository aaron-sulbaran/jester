// What a recorded round keeps about the camera. Run from app/: npm test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cameraFacts, type CameraTrack } from "../src/dev/cameraFacts.ts";

const track: CameraTrack = { label: "Sam's Phone Camera", getSettings: () => ({ width: 1280, height: 720, frameRate: 30 }) };

test("a live-site round keeps no camera name, only its size and frame rate", () => {
  const facts = cameraFacts(track, true);
  assert.equal(facts.label, null);
  assert.deepEqual(facts, { label: null, width: 1280, height: 720, frameRate: 30 });
  assert.ok(!JSON.stringify(facts).includes("Sam"));
});

test("a dev-server round keeps the camera name for the team", () => {
  assert.equal(cameraFacts(track, false).label, "Sam's Phone Camera");
});

test("missing settings become null, never a guess", () => {
  assert.deepEqual(cameraFacts({ label: "x", getSettings: () => ({}) }, true), { label: null, width: null, height: null, frameRate: null });
});
