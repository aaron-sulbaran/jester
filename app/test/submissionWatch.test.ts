import assert from "node:assert/strict";
import { test } from "node:test";
import { candidates, stillWaiting } from "../src/submissionWatch.ts";
import { bankIdFor } from "../src/bankIndex.ts";

const fp = "9c23e4027445aee3" + "1".repeat(48);
const other = "130d37a83bb6e30b" + "2".repeat(48);

test("candidates: finds the clip whose id carries the fingerprint, under any title", () => {
  const ids = [bankIdFor("The Dougie", fp, []), bankIdFor("vibin", other, []), "neon-wall-groove"];
  assert.deepEqual(candidates(ids.map((id) => ({ id })), fp), ["the-dougie-9c23e4"]);
  assert.deepEqual(candidates(ids.map((id) => ({ id })), other), ["vibin-130d37"]);
});

test("candidates: still finds it when the same clip was sent again and got a longer or counted id", () => {
  const taken: string[] = [];
  for (let i = 0; i < 6; i++) taken.push(bankIdFor("a long dance name that fills the whole slug", fp, taken));
  assert.equal(candidates(taken.map((id) => ({ id })), fp).length, taken.length);
});

test("stillWaiting: drops malformed entries and ones older than the watch lasts", () => {
  const now = 10_000_000_000;
  const sent = [
    { fingerprint: fp, title: "The Dougie", at: now - 60_000 },
    { fingerprint: other, title: "old", at: now - 61 * 60 * 1000 },
    { fingerprint: "not-a-hash", title: "bad", at: now },
  ];
  assert.deepEqual(stillWaiting(sent, now).map((s) => s.title), ["The Dougie"]);
});
