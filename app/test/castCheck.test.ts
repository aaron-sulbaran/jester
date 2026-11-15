// Run from app/: npm test. The Chamberlain's cast check: the summary it reads, and the drops code allows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCast, castSummary, castText } from "../src/castSummary.ts";
import { allowedDrops, finalize, type ClipFacts } from "../review-agent.ts";

/** A box track at 15 Hz over 30 s, seen from `from` to `to` seconds at one place. */
function track(label: string, kind: "person" | "thing", from: number, to: number, at: { cx: number; cy: number; w: number; h: number }) {
  const frames = Array.from({ length: 450 }, (_, i) => {
    const tMs = Math.round((i * 1000) / 15);
    return { tMs, box: tMs >= from * 1000 && tMs <= to * 1000 ? at : null };
  });
  return { subject: { kind, label }, boxTrack: { frames } };
}

// Brain Rot's pattern: one dancer in front of one parked car, split by the tracker into three pieces, plus a blip.
const car = { cx: 0.81, cy: 0.64, w: 0.37, h: 0.3 };
const brainRot = [
  track("Person 1", "person", 0, 30, { cx: 0.56, cy: 0.64, w: 0.36, h: 0.66 }),
  track("Car 1", "thing", 3.6, 21.6, car),
  track("Car 2", "thing", 18.4, 29.6, car),
  track("Car 3", "thing", 1.2, 3.5, car),
  track("Car 4", "thing", 24.4, 25.6, { cx: 0.14, cy: 0.6, w: 0.28, h: 0.13 }),
];

test("castSummary: when, where and how big each subject is seen", () => {
  const cast = castSummary(brainRot);
  assert.deepEqual(cast.map((c) => c.label), ["Person 1", "Car 1", "Car 2", "Car 3", "Car 4"]);
  const car1 = cast[1]!;
  assert.deepEqual(car1.seen, [[3.6, 21.6]]);
  assert.equal(car1.seenShare, 0.6);
  assert.deepEqual([car1.x, car1.y, car1.w, car1.h, car1.drift], [0.81, 0.64, 0.37, 0.3, 0]);
  assert.equal(cast[0]!.seenShare, 1);
  assert.match(castText(cast), /Car 3 \(thing\): seen 1\.2-3\.5 s/);
  const gappy = castSummary([track("Ball 1", "thing", 0, 30, car)].map((g) => ({ ...g, boxTrack: { frames: g.boxTrack.frames.map((f, i) => (i >= 100 && i < 130 ? { ...f, box: null } : f)) } })));
  assert.equal(gappy[0]!.seen.length, 2);
});

test("applyCast: drops only things, and never empties the cast", () => {
  assert.deepEqual(applyCast(brainRot, ["Car 2", "Car 3", "Car 4"]).map((g) => g.subject.label), ["Person 1", "Car 1"]);
  assert.deepEqual(applyCast(brainRot, ["Person 1"]).map((g) => g.subject.label), ["Person 1", "Car 1", "Car 2", "Car 3", "Car 4"]);
  const onlyThings = brainRot.slice(1, 3);
  assert.equal(applyCast(onlyThings, ["Car 1", "Car 2"]).length, 2);
});

const facts = (cast = castSummary(brainRot)): ClipFacts => ({
  error: null, durationMs: 30000, skipped: [], warnings: [], cast,
  subjects: cast.map((c) => ({ label: c.label, kind: c.kind, seenShare: c.seenShare, pace: "medium" })),
});

test("allowedDrops: known things only, once each, never a person, never every subject", () => {
  const why = "same car";
  assert.deepEqual(allowedDrops(facts(), [{ label: "Car 2", why }, { label: "Car 2", why }, { label: "Person 1", why }, { label: "Car 9", why }]), [{ label: "Car 2", why }]);
  const thingsOnly = facts(castSummary(brainRot.slice(1, 3)));
  assert.deepEqual(allowedDrops(thingsOnly, [{ label: "Car 1", why }, { label: "Car 2", why }]), []);
});

test("finalize: the cast check never changes the verdict, and only allowed drops come out", () => {
  const recorded = {
    verdict: "approve" as const, reason: "Fine.", nameCheck: "fits" as const, nameKind: "meme_or_joke" as const, nameNote: "", framesCheck: "A dancer by a red car.",
    contentCheck: "clean" as const, steering: false, precedent: "", castNote: "One red car, parked.",
    castDrops: [{ label: "Car 2", why: "same car as Car 1" }, { label: "Car 3", why: "same car" }, { label: "Car 4", why: "not in the frames" }, { label: "Person 1", why: "no" }],
  };
  const d = finalize({ title: "brainrot", facts: facts() }, recorded, { findings: [], steps: [] });
  assert.equal(d.verdict, "approve");
  assert.deepEqual(d.castDrops.map((x) => x.label), ["Car 2", "Car 3", "Car 4"]);
  assert.equal(d.castNote, "One red car, parked.");
  assert.deepEqual(finalize({ title: "brainrot", facts: facts() }, null, { findings: [], steps: [] }).castDrops, []);
});
