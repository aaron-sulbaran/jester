import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, bestOf, modeFor, nextRound, rankDuel, startElimination, type DuelResult } from "../src/match.ts";

const r = (id: string, score: number | null, lagMs: number | null = 0): DuelResult => ({ id, score, lagMs });
const places = (rows: DuelResult[]) => rankDuel(rows).map((p) => `${p.id}:${p.place}`);

test("modeFor: one subject is a duel, more is a cast", () => {
  assert.equal(modeFor(1, 2), "duel");
  assert.equal(modeFor(1, 6), "duel");
  assert.equal(modeFor(2, 2), "cast");
  assert.equal(modeFor(3, 8), "cast");
});

test("rankDuel: highest score first, missing score last", () => {
  assert.deepEqual(places([r("a", 40), r("b", null), r("c", 90), r("d", 70)]), ["c:1", "d:2", "a:3", "b:4"]);
});

test("rankDuel: a score tie goes to the smaller absolute lag", () => {
  assert.deepEqual(places([r("a", 80, 400), r("b", 80, -100)]), ["b:1", "a:2"]);
  assert.deepEqual(places([r("a", 80, null), r("b", 80, 600)]), ["b:1", "a:2"]);
});

test("rankDuel: exact ties share a place, the next place skips", () => {
  assert.deepEqual(places([r("a", 80, 100), r("b", 80, -100), r("c", 50)]), ["a:1", "b:1", "c:3"]);
  assert.deepEqual(places([r("a", 60), r("b", null), r("c", null)]), ["a:1", "b:2", "c:2"]);
});

test("nextRound: drops last place and names the winner when one is left", () => {
  assert.deepEqual(nextRound(["a", "b", "c"], [r("a", 90), r("b", 50), r("c", 70)]), { alive: ["a", "c"], dropped: ["b"], replay: false, winner: null });
  assert.deepEqual(nextRound(["a", "c"], [r("a", 90), r("c", 70)]), { alive: ["a"], dropped: ["c"], replay: false, winner: "a" });
});

test("nextRound: everyone tied for last goes; a full tie replays", () => {
  assert.deepEqual(nextRound(["a", "b", "c"], [r("a", 90), r("b", 50), r("c", 50)]).dropped, ["b", "c"]);
  assert.deepEqual(nextRound(["a", "b"], [r("a", 50), r("b", 50)]), { alive: ["a", "b"], dropped: [], replay: true, winner: null });
});

test("nextRound: a player still in with no result counts as no score; players already out are ignored", () => {
  assert.deepEqual(nextRound(["a", "b", "c"], [r("a", 10), r("c", 20), r("z", 99)]).dropped, ["b"]);
});

test("bestOf: first to two wins out of three; a tie for first counts for nobody", () => {
  const ab = ["a", "b"];
  assert.equal(bestOf(3, ab, [[r("a", 80), r("b", 60)]]).winner, null);
  assert.equal(bestOf(3, ab, [[r("a", 80), r("b", 60)], [r("a", 50), r("b", 60)], [r("a", 90), r("b", 60)]]).winner, "a");
  const tied = bestOf(3, ab, [[r("a", 80), r("b", 80)], [r("b", 70), r("a", 10)], [r("b", 70), r("a", 10)]]);
  assert.deepEqual({ winner: tied.winner, decided: tied.decided, needed: tied.needed }, { winner: "b", decided: 2, needed: 2 });
});

test("advance: elimination down to two, then a best of three final", () => {
  let m = startElimination(["a", "b", "c"]);
  let step = advance(m, [r("a", 90), r("b", 40), r("c", 70)]);
  assert.deepEqual(step.dropped, ["b"]);
  m = step.state;
  step = advance(m, [r("a", 90), r("c", 70)]);
  assert.equal(step.state.winner, null);
  assert.equal(step.final?.wins["a"], 1);
  m = step.state;
  step = advance(m, [r("a", 60), r("c", 60)]);
  assert.equal(step.replay, true);
  m = step.state;
  step = advance(m, [r("a", 95), r("c", 70)]);
  assert.equal(step.state.winner, "a");
  assert.deepEqual(step.state.out, ["b", "c"]);
});
