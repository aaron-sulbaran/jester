import assert from "node:assert/strict";
import { test } from "node:test";
import type { Guide } from "../../clip/src/index.ts";
import { DUEL_WINNER_AWARD, duelGuides, duelHeadline, duelPlaces, podiumOrder } from "../src/duelPlay.ts";

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

// Both winner paths together: finishGame's rows (score, plus duelPlaces when duel is set) and the podium.
// game.ts hands showResults the rows sorted by score, best first, so a tie keeps seat order there.
function finishedRows(scores: (number | null)[], lags: (number | null)[], duel: boolean) {
  const places = duel ? duelPlaces(scores, lags) : null;
  const top = Math.max(...scores.map((s) => s ?? -1));
  const rows = scores.map((score, i) => ({
    name: `seat ${i + 1}`, score, winner: score !== null && score === top,
    ...(places ? { duel: true, place: places[i]!.place, winner: places[i]!.winner, tied: places[i]!.tied } : {}),
  }));
  return [...rows].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

test("both paths: a tie on score broken by timing crowns seat 2, and seat 2 is first on the podium", () => {
  const rows = finishedRows([80, 80], [300, 40], true);
  assert.deepEqual(rows.filter((r) => r.winner).map((r) => r.name), ["seat 2"]);
  const podium = podiumOrder(rows);
  assert.deepEqual(podium.map((p) => [p.row.name, p.place]), [["seat 2", 1], ["seat 1", 2]]);
  assert.equal(podium[0]!.row.winner, true);
});

test("both paths: a missing timing loses the tie, on the crown and on the podium", () => {
  const rows = finishedRows([80, 80], [null, 500], true);
  assert.deepEqual(rows.filter((r) => r.winner).map((r) => r.name), ["seat 2"]);
  assert.deepEqual(podiumOrder(rows).map((p) => [p.row.name, p.place]), [["seat 2", 1], ["seat 1", 2]]);
});

test("both paths: an exact tie crowns both and both stand first", () => {
  const rows = finishedRows([80, 80], [60, -60], true);
  assert.equal(rows.filter((r) => r.winner).length, 2);
  assert.deepEqual(podiumOrder(rows).map((p) => p.place), [1, 1]);
});

test("flag off: the podium is exactly as before duels, in the given order with tied scores sharing a place", () => {
  const rows = finishedRows([90, 70, 70, null], [300, 40, 10, null], false);
  assert.deepEqual(podiumOrder(rows).map((p) => [p.row.name, p.place]), [["seat 1", 1], ["seat 2", 2], ["seat 3", 2], ["seat 4", 4]]);
  assert.deepEqual(podiumOrder(rows).map((p) => p.row), rows);
  // Same scores tied for first without a duel: both winners, both 1st, timing ignored.
  const tied = finishedRows([80, 80], [300, 40], false);
  assert.deepEqual(tied.map((r) => r.winner), [true, true]);
  assert.deepEqual(podiumOrder(tied).map((p) => [p.row.name, p.place]), [["seat 1", 1], ["seat 2", 1]]);
});
