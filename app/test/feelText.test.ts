// Run from app/: npm test (node 22.6+ runs the TypeScript directly).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cameraTrouble, rankFor, RANKS } from "../src/feelText.ts";

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
