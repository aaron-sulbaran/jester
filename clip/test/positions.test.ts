import assert from "node:assert/strict";
import { test } from "node:test";
import { meanCentreX, medianCentreX, nameByPosition, partName, positionNames } from "../src/index.ts";
import type { Box, Guide } from "../src/index.ts";

/** A guide whose subject's box centre is at each x in turn (null where it is not seen). */
function guideAt(kind: "person" | "thing", label: string, xs: (number | null)[]): Guide {
  const box = (cx: number): Box => ({ cx, cy: 0.5, w: 0.2, h: 0.5 });
  return {
    schema: "guide/1", fingerprint: "f", source: { width: 1280, height: 720, durationMs: 1000, sampleHz: 15 },
    range: { startMs: 0, endMs: 1000 }, subject: { kind, label },
    channel: kind === "person" ? "pose" : "trajectory", timeline: null,
    boxTrack: { schema: "box-track/1", source: { width: 1280, height: 720 }, frames: xs.map((x, i) => ({ tMs: i * 66, box: x === null ? null : box(x) })) },
    outlines: xs.map(() => null), keyMoments: [], pace: "medium", warnings: [], check: null,
  } as Guide;
}

const labels = (guides: Guide[]) => guides.map((g) => g.subject.label);

test("positionNames: one person, a pair, three and four in a row", () => {
  assert.deepEqual(positionNames(0), []);
  assert.deepEqual(positionNames(1), ["the person in the clip"]);
  assert.deepEqual(positionNames(2), ["the person on the left", "the person on the right"]);
  assert.deepEqual(positionNames(3), ["the person on the left", "the person in the middle", "the person on the right"]);
  assert.deepEqual(positionNames(4), [
    "the person on the left", "the person second from the left", "the person second from the right", "the person on the right",
  ]);
  assert.equal(positionNames(5)[2], "the person in the middle");
});

test("meanCentreX: averages only the frames the subject is seen in", () => {
  assert.equal(meanCentreX(guideAt("person", "Person 1", [0.2, null, 0.4])), 0.30000000000000004);
  assert.equal(meanCentreX(guideAt("person", "Person 1", [null, null])), null);
});

test("nameByPosition: the best ranked person standing on the right is named on the right; order is kept", () => {
  const guides = [guideAt("person", "Person 1", [0.7, 0.75]), guideAt("person", "Person 2", [0.3, 0.2])];
  assert.deepEqual(labels(nameByPosition(guides)), ["the person on the right", "the person on the left"]);
});

test("nameByPosition: one person is the person in the clip, and things keep their labels", () => {
  const guides = [guideAt("person", "Person 1", [0.5]), guideAt("thing", "Ball 1", [0.1])];
  assert.deepEqual(labels(nameByPosition(guides)), ["the person in the clip", "Ball 1"]);
});

test("nameByPosition: three people, a tie keeps the given order, and someone never seen goes last", () => {
  const three = [guideAt("person", "a", [0.5]), guideAt("person", "b", [0.9]), guideAt("person", "c", [0.1])];
  assert.deepEqual(labels(nameByPosition(three)), ["the person in the middle", "the person on the right", "the person on the left"]);
  const tied = [guideAt("person", "a", [0.5]), guideAt("person", "b", [0.5])];
  assert.deepEqual(labels(nameByPosition(tied)), ["the person on the left", "the person on the right"]);
  const unseen = [guideAt("person", "a", [null]), guideAt("person", "b", [0.8])];
  assert.deepEqual(labels(nameByPosition(unseen)), ["the person on the right", "the person on the left"]);
});

test("nameByPosition: does not change the guides it is given", () => {
  const guides = [guideAt("person", "Person 1", [0.7]), guideAt("person", "Person 2", [0.3])];
  nameByPosition(guides);
  assert.deepEqual(labels(guides), ["Person 1", "Person 2"]);
});

test("medianCentreX: where the subject stands for most of the frames it is seen in", () => {
  assert.equal(medianCentreX(guideAt("person", "a", [0.2, null, 0.4, 0.9])), 0.4);
  assert.equal(medianCentreX(guideAt("person", "a", [0.2, 0.4])), 0.30000000000000004);
  assert.equal(medianCentreX(guideAt("person", "a", [null])), null);
});

test("nameByPosition: someone who steps across for a moment keeps the side they stand on most of the time", () => {
  // Person a stands left of b for 8 frames in 10, then runs far right; the mean would put a on the right.
  const a = guideAt("person", "a", [0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.95, 0.95]);
  const b = guideAt("person", "b", Array(10).fill(0.5));
  assert.ok(meanCentreX(a)! > meanCentreX(b)!);
  assert.deepEqual(labels(nameByPosition([a, b])), ["the person on the left", "the person on the right"]);
});

test("nameByPosition: two people who swap sides are named by the side each holds for longer", () => {
  // They swap after 7 frames in 10: a is on the left for most of the clip.
  const a = guideAt("person", "a", [0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.7, 0.7, 0.7]);
  const b = guideAt("person", "b", [0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.3, 0.3, 0.3]);
  assert.deepEqual(labels(nameByPosition([b, a])), ["the person on the right", "the person on the left"]);
});

test("partName: the whole body is the name; a body part comes first; a thing is the thing", () => {
  const left = { kind: "person" as const, label: "the person on the left" };
  assert.equal(partName(left), "the person on the left");
  assert.equal(partName(left, "leftHand"), "the left hand of the person on the left");
  assert.equal(partName({ kind: "person", label: "the person in the middle" }, "rightFoot"), "the right foot of the person in the middle");
  assert.equal(partName({ kind: "person", label: "the person in the clip" }, "leftHand"), "the left hand of the person in the clip");
  assert.equal(partName({ kind: "person", label: "the person on the right" }, "head"), "the head of the person on the right");
  assert.equal(partName({ kind: "thing", label: "Ball 1" }), "the ball");
  assert.equal(partName({ kind: "thing", label: "Ball 1" }, "rightHand"), "the ball, with the right hand");
  assert.equal(partName({ kind: "thing", label: "the basketball" }), "the basketball");
});
