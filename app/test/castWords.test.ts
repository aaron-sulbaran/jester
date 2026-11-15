import assert from "node:assert/strict";
import { test } from "node:test";
import { castLine, playerLine, playersFor, sentInBy } from "../src/castWords.ts";

test("players count people and things, or people only", () => {
  assert.equal(playersFor(2, 1), 3);
  assert.equal(playersFor(2, 1, false), 2);
  assert.equal(playerLine(1, 0), "1 player");
  assert.equal(playerLine(2, 0), "2 players");
  assert.equal(playerLine(2, 1), "3 players");
  assert.equal(playerLine(2, 1, false), "2 players");
  assert.equal(playerLine(0, 1), "1 player");
});

test("the card line reads players and seconds", () => {
  assert.equal(castLine(2, 0, 15000), "2 players, 15 s");
  assert.equal(castLine(2, 1, 8200), "3 players, 8 s");
  assert.equal(castLine(2, 1, 8200, false), "2 players, 8 s");
});

test("sent in by a name, or Anonymous", () => {
  assert.equal(sentInBy("Lisa"), "Sent in by Lisa");
  assert.equal(sentInBy("  "), "Sent in by Anonymous");
  assert.equal(sentInBy(null), "Sent in by Anonymous");
  assert.equal(sentInBy("Sent in with Submit your own"), "Sent in by Anonymous");
  assert.equal(sentInBy("<img src=x onerror=alert(1)>"), "Sent in by <img src=x onerror=alert(1)>");
});
