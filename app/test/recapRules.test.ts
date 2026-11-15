import assert from "node:assert/strict";
import { test } from "node:test";
import { CAST_ROW_GAP_MS, castRowShare, dropShrunkCrops, keepFinished, overlap, packTier, sameDancer } from "../src/recapRules.ts";

test("the cast card's first row is there from the first frame, the rest come in one after another", () => {
  assert.equal(castRowShare(0, 0), 1);                       // never a card with only its title
  assert.equal(castRowShare(0, 1), 0);
  assert.equal(castRowShare(CAST_ROW_GAP_MS, 1), 0);
  assert.equal(castRowShare(CAST_ROW_GAP_MS + 175, 1), 0.5);
  assert.equal(castRowShare(10_000, 3), 1);
});

test("packing takes the largest tier that fits and stops trying once one does", () => {
  const tried: number[] = [];
  const sizes = [3_100_000, Infinity, 2_400_000, 1_000_000];
  assert.equal(packTier(sizes.length, 2_500_000, (i) => { tried.push(i); return sizes[i]!; }), 2);
  assert.deepEqual(tried, [0, 1, 2]);                        // tier 3 was never encoded
  assert.equal(packTier(2, 100, () => 1000), -1);
});

test("a player who finished and was then dropped stays in the recap", () => {
  const row = (id: string, timeline: unknown = { f: [] }) => ({ id, timeline, extra: { guideIndex: 0 } });
  const seen = [row("host"), row("friend"), row("never", null)];
  const now = [row("host")];                                 // the room dropped the friend while pictures arrived
  assert.deepEqual(keepFinished(seen, now).map((r) => r.id), ["host", "friend"]);
  assert.deepEqual(keepFinished(seen, [row("host"), row("friend")]).map((r) => r.id), ["host", "friend"]);
});

test("two roles following the same dancer are found from their boxes", () => {
  const left = { cx: 0.3, cy: 0.5, w: 0.2, h: 0.6 }, right = { cx: 0.7, cy: 0.5, w: 0.2, h: 0.6 };
  assert.equal(overlap(left, left), 1);
  assert.equal(overlap(left, right), 0);
  const a = [left, left, right, right, null];
  const b = [right, right, right, right, right];             // b stays right; a slips onto b halfway through
  assert.equal(sameDancer(a, b), 0.5);
  assert.equal(sameDancer([left, null], [null, right]), 0);
});

test("frames whose crop shrank onto the body (the head lost for a moment) are left out of a player's cutouts", () => {
  // Sides from a real two-tab round with a drawn webcam: the headless frames were 0.36 to 0.76 of the usual size.
  const at = (t: number, side: number) => ({ t, anchor: { region: { cx: 0.5, cy: 0.5, side } } });
  const usual = 0.465;
  const frames = [at(0, usual), at(1, usual * 1.06), at(2, usual * 0.36), at(3, usual * 0.9), at(4, usual * 0.73), at(5, usual * 1.24), at(6, usual * 0.76), at(7, usual * 0.98)];
  assert.deepEqual(dropShrunkCrops(frames).map((f) => f.t), [0, 1, 3, 5, 7]);
  assert.deepEqual(dropShrunkCrops(frames.slice(0, 4)).map((f) => f.t), [0, 1, 2, 3]);   // too few to know the usual size
  const noAnchor = [{ t: 9, anchor: null }, ...frames];
  assert.equal(dropShrunkCrops(noAnchor)[0]!.t, 9);                                          // frames with no anchor stay
});
