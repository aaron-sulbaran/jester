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

test("every camera card offers the understudy and has no em dashes", () => {
  for (const e of [named("NotAllowedError"), named("NotFoundError"), named("NotReadableError"), new TypeError("getUserMedia"), new Error("x")]) {
    const c = cameraTrouble(e);
    assert.match(c.text, /understudy/);
    assert.doesNotMatch(c.title + c.text, /—/);
  }
});

test("ranks follow the score tiers", () => {
  assert.equal(rankFor(100).title, "Court Favourite");
  assert.equal(rankFor(90).title, "Court Favourite");
  assert.equal(rankFor(89).title, "Royal Jester");
  assert.equal(rankFor(60).title, "Juggler of the Hall");
  assert.equal(rankFor(30).title, "Village Clown");
  assert.equal(rankFor(29).title, "Stable Hand in Bells");
  assert.equal(rankFor(0).title, "Stable Hand in Bells");
  assert.equal(rankFor(null).title, "Lost in the Crowd");
  assert.equal(rankFor(Number.NaN).title, "Lost in the Crowd");
});

test("rank tiers are ordered best first and every one has a blurb", () => {
  for (let i = 1; i < RANKS.length; i++) assert.ok(RANKS[i - 1]!.min > RANKS[i]!.min);
  assert.equal(RANKS[RANKS.length - 1]!.min, 0);
  for (const r of RANKS) { assert.ok(r.blurb.length > 0); assert.doesNotMatch(r.title + r.blurb, /—/); }
});

test("everyone gets an award, the winner gets the crown", () => {
  const a = awardsFor([
    { score: 82, winner: true, motion: 1.2 },
    { score: 78, winner: false, motion: 0.4 },
    { score: 40, winner: false, motion: 2.5 },
    { score: 55, winner: false, motion: 0.1 },
  ]);
  assert.deepEqual(a, ["The Crown", "Nearly Royal", "Most Energetic", "Statue of the Court"]);
  assert.equal(new Set(a).size, a.length);
});

test("ties share the crown and a player the camera never saw is a mystery guest", () => {
  assert.deepEqual(awardsFor([
    { score: 70, winner: true, motion: 1 },
    { score: 70, winner: true, motion: 1 },
    { score: null, winner: false, motion: null },
  ]), ["Shared Crown", "Shared Crown", "Mystery Guest"]);
  assert.deepEqual(awardsFor([{ score: 50, winner: true, motion: null }, { score: 20, winner: false, motion: null }]), ["The Crown", "Bravest Attempt"]);
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
  assert.equal(hostLine("crown", { winner: "Ana" }, () => 0), "Ana takes the crown!");
  assert.equal(hostLine("results", { winner: "Ana", title: "Royal Jester" }, () => 0), "Ana is our Royal Jester!");
  for (const e of ["beat", "roll", "crown", "tie", "nobody", "results"] as const) {
    for (const r of [0, 0.5, 0.99]) assert.doesNotMatch(hostLine(e, { winner: "Ana", title: "X" }, () => r), /—|\{/);
  }
});
