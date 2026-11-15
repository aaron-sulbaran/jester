// Run from app/: npm test (node 22.6+ runs the TypeScript directly).
import { test } from "node:test";
import assert from "node:assert/strict";
import { awardsFor, cameraTrouble, hostLine, motionOf, rankFor, RANKS } from "../src/feelText.ts";

const named = (name: string, message = "") => Object.assign(new Error(message), { name });

test("camera errors map to the right card", () => {
  assert.equal(cameraTrouble(named("NotAllowedError", "Permission denied")).kind, "refused");
  assert.equal(cameraTrouble(new DOMException("Permission denied", "NotAllowedError")).kind, "refused");
  assert.equal(cameraTrouble(named("NotFoundError")).kind, "missing");
  assert.equal(cameraTrouble(named("OverconstrainedError")).kind, "missing");
  assert.equal(cameraTrouble(named("NotReadableError", "Could not start video source")).kind, "busy");
  assert.equal(cameraTrouble(new TypeError("Cannot read properties of undefined (reading 'getUserMedia')")).kind, "unsupported");
  assert.equal(cameraTrouble(new Error("Failed to fetch dynamically imported module")).kind, "tracker");
  assert.equal(cameraTrouble(undefined).kind, "tracker");
});

test("camera cards use plain words and no em dashes", () => {
  for (const e of [named("NotAllowedError"), named("NotFoundError"), named("NotReadableError"), new TypeError("getUserMedia"), new Error("x")]) {
    const c = cameraTrouble(e);
    assert.doesNotMatch(c.title + c.text, /simulated|tracker|pose/i);
    assert.doesNotMatch(c.title + c.text, /—/);
  }
});

test("ranks follow the score tiers", () => {
  assert.equal(rankFor(100).title, "Top marks");
  assert.equal(rankFor(90).title, "Top marks");
  assert.equal(rankFor(89).title, "Great");
  assert.equal(rankFor(60).title, "Good");
  assert.equal(rankFor(30).title, "Getting there");
  assert.equal(rankFor(29).title, "Keep practising");
  assert.equal(rankFor(0).title, "Keep practising");
  assert.equal(rankFor(null).title, "No score");
  assert.equal(rankFor(Number.NaN).title, "No score");
});

test("rank tiers are ordered best first", () => {
  for (let i = 1; i < RANKS.length; i++) assert.ok(RANKS[i - 1]!.min > RANKS[i]!.min);
  assert.equal(RANKS[RANKS.length - 1]!.min, 0);
  for (const r of RANKS) assert.doesNotMatch(r.title, /—/);
});

test("everyone gets an award, the winner gets the crown", () => {
  const a = awardsFor([
    { score: 82, winner: true, motion: 1.2 },
    { score: 78, winner: false, motion: 0.4 },
    { score: 40, winner: false, motion: 2.5 },
    { score: 55, winner: false, motion: 0.1 },
  ]);
  assert.deepEqual(a, ["Winner", "Close second", "Most movement", "Stillest"]);
  assert.equal(new Set(a).size, a.length);
});

test("ties are joint winners and a player the camera never saw is named so", () => {
  assert.deepEqual(awardsFor([
    { score: 70, winner: true, motion: 1 },
    { score: 70, winner: true, motion: 1 },
    { score: null, winner: false, motion: null },
  ]), ["Joint winner", "Joint winner", "Not seen by the camera"]);
  assert.deepEqual(awardsFor([{ score: 50, winner: true, motion: null }, { score: 20, winner: false, motion: null }]), ["Winner", "Gave it a go"]);
});

test("motion counts wrist and ankle travel per second", () => {
  const still = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 1 }));
  const moved = still.map((p, j) => (j === 15 ? { ...p, x: 0.6 } : p));
  assert.equal(motionOf(null), null);
  assert.equal(motionOf({ frames: [{ t: 0, landmarks: still }] }), null);
  const m = motionOf({ frames: [{ t: 0, landmarks: still }, { t: 1000, landmarks: moved }] })!;
  assert.ok(Math.abs(m - 0.1) < 1e-9);
});

test("host lines fill in the winner and never use em dashes", () => {
  assert.equal(hostLine("crown", { winner: "Ana" }, () => 0), "Ana wins!");
  assert.equal(hostLine("results", { winner: "Ana", title: "Great" }, () => 0), "Here are the scores. Ana: Great.");
  for (const e of ["beat", "roll", "crown", "tie", "nobody", "results"] as const) {
    for (const r of [0, 0.5, 0.99]) assert.doesNotMatch(hostLine(e, { winner: "Ana", title: "X" }, () => r), /—|\{/);
  }
});
