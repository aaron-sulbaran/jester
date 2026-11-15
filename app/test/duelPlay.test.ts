import assert from "node:assert/strict";
import { test } from "node:test";
import type { Guide } from "../../clip/src/index.ts";
import { DUEL_WINNER_AWARD, duelGuides, duelHeadline, duelPlaces } from "../src/duelPlay.ts";

const guide = (kind: "person" | "thing", label: string) => ({ subject: { kind, label } }) as unknown as Guide;

test("a duel deals the clip's person, never a thing", () => {
  const person = guide("person", "dancer");
  const balls = [guide("thing", "ball"), guide("thing", "ball"), guide("thing", "cone"), guide("thing", "hat")];
  assert.deepEqual(duelGuides([balls[0]!, person, ...balls.slice(1)]), [person]);
  assert.deepEqual(duelGuides([person]), [person]);
});

test("with several people everyone still copies the same one; no person keeps every guide", () => {
  const a = guide("person", "left"), b = guide("person", "right");
  assert.deepEqual(duelGuides([a, b]), [a]);
  const things = [guide("thing", "ball"), guide("thing", "cone")];
  assert.deepEqual(duelGuides(things), things);
});

test("the higher score wins, whatever the timing", () => {
  const places = duelPlaces([70, 85], [10, 300]);
  assert.deepEqual(places.map((p) => p.place), [2, 1]);
  assert.deepEqual(places.map((p) => p.winner), [false, true]);
  assert.equal(places[1]!.tied, false);
});

test("a tie on score goes to the timing closer to the beat", () => {
  const places = duelPlaces([80, 80], [-220, 90]);
  assert.deepEqual(places.map((p) => p.place), [2, 1]);
  assert.deepEqual(places.map((p) => p.winner), [false, true]);
});

test("a missing timing never wins a tie by counting as on the beat", () => {
  const places = duelPlaces([80, 80], [null, 400]);
  assert.deepEqual(places.map((p) => p.winner), [false, true]);
});

test("the same score and the same timing is a tie for first", () => {
  const places = duelPlaces([80, 80], [120, -120]);
  assert.deepEqual(places.map((p) => p.place), [1, 1]);
  assert.ok(places.every((p) => p.winner && p.tied));
});

test("no score comes last and never wins", () => {
  assert.deepEqual(duelPlaces([null, 40], [0, 500]).map((p) => [p.place, p.winner]), [[2, false], [1, true]]);
  assert.ok(duelPlaces([null, null], [null, null]).every((p) => !p.winner));
});

test("the duel's words", () => {
  assert.equal(duelHeadline(["Ana"]), "Ana wins the duel!");
  assert.equal(duelHeadline(["Ana", "Bo"]), "It's a tie!");
  assert.equal(duelHeadline([]), "Everyone played!");
  assert.equal(DUEL_WINNER_AWARD, "Duel winner");
});
