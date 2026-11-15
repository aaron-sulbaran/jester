import assert from "node:assert/strict";
import { test } from "node:test";
import { meanCentreX, nameByPosition, positionNames } from "../src/index.ts";
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

test("positionNames: one dancer, a pair, three and four in a row", () => {
  assert.deepEqual(positionNames(0), []);
  assert.deepEqual(positionNames(1), ["the dancer"]);
  assert.deepEqual(positionNames(2), ["the dancer on the left", "the dancer on the right"]);
  assert.deepEqual(positionNames(3), ["the dancer on the left", "the dancer in the middle", "the dancer on the right"]);
  assert.deepEqual(positionNames(4), [
    "the dancer on the left", "the dancer second from the left", "the dancer second from the right", "the dancer on the right",
  ]);
  assert.equal(positionNames(5)[2], "the dancer in the middle");
});

test("meanCentreX: averages only the frames the subject is seen in", () => {
  assert.equal(meanCentreX(guideAt("person", "Person 1", [0.2, null, 0.4])), 0.30000000000000004);
  assert.equal(meanCentreX(guideAt("person", "Person 1", [null, null])), null);
});

test("nameByPosition: the best ranked person standing on the right is named on the right; order is kept", () => {
  const guides = [guideAt("person", "Person 1", [0.7, 0.75]), guideAt("person", "Person 2", [0.3, 0.2])];
  assert.deepEqual(labels(nameByPosition(guides)), ["the dancer on the right", "the dancer on the left"]);
});

test("nameByPosition: one person is just the dancer, and things keep their labels", () => {
  const guides = [guideAt("person", "Person 1", [0.5]), guideAt("thing", "Ball 1", [0.1])];
  assert.deepEqual(labels(nameByPosition(guides)), ["the dancer", "Ball 1"]);
});

test("nameByPosition: three people, a tie keeps the given order, and someone never seen goes last", () => {
  const three = [guideAt("person", "a", [0.5]), guideAt("person", "b", [0.9]), guideAt("person", "c", [0.1])];
  assert.deepEqual(labels(nameByPosition(three)), ["the dancer in the middle", "the dancer on the right", "the dancer on the left"]);
  const tied = [guideAt("person", "a", [0.5]), guideAt("person", "b", [0.5])];
  assert.deepEqual(labels(nameByPosition(tied)), ["the dancer on the left", "the dancer on the right"]);
  const unseen = [guideAt("person", "a", [null]), guideAt("person", "b", [0.8])];
  assert.deepEqual(labels(nameByPosition(unseen)), ["the dancer on the right", "the dancer on the left"]);
});

test("nameByPosition: does not change the guides it is given", () => {
  const guides = [guideAt("person", "Person 1", [0.7]), guideAt("person", "Person 2", [0.3])];
  nameByPosition(guides);
  assert.deepEqual(labels(guides), ["Person 1", "Person 2"]);
});
