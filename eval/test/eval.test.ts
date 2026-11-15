import { test } from "node:test";
import assert from "node:assert/strict";
import { fromWebcamFrames, scorePoseRound, type LandmarkObject } from "../../engine/src/index.ts";
import { timeline, dance, squatDance, STAND, mirrorCopy } from "../../engine/test/synth.ts";
import { fingerprint, newRoundId, packPose, unpackPose, looksLikeRecord, RECORD_SCHEMA, type RoundRecord } from "../src/record.ts";
import { judge, legSwingDeg, rescore, setConstant, type Rescored } from "../src/judge.ts";

function record(tag: RoundRecord["tag"], reference = timeline(dance), player = timeline((t) => mirrorCopy(dance(t)))): RoundRecord {
  const result = scorePoseRound(reference, player);
  return {
    schema: RECORD_SCHEMA, id: newRoundId(), createdAt: new Date().toISOString(), browserId: "b-test", mode: "solo", page: "/", callers: [],
    clip: { key: fingerprint(packPose(reference)), bankId: null, title: null, subject: null },
    tag, note: null, channel: "pose", options: {}, reference: packPose(reference), player: packPose(player), result,
    scorerVersion: result.scorerVersion, device: { userAgent: "test", cores: null, gpu: null, camera: null, playerFps: null }, app: null,
  };
}

test("a packed round replays to the same score", () => {
  const r = record("nailed");
  assert.ok(looksLikeRecord(r));
  const again = rescore(JSON.parse(JSON.stringify(r)) as RoundRecord);
  assert.equal(again.score, r.result.score);
  assert.equal(again.lagMs, r.result.lagMs);
});

test("packing keeps frames where nobody was found", () => {
  const player = fromWebcamFrames([
    { t: 0, landmarks: null, aspect: 4 / 3, clipTimeMs: 0 },
    { t: 33, landmarks: Array.from({ length: 33 }, (): LandmarkObject => ({ x: 0.5, y: 0.5, visibility: 0.9 })), aspect: 4 / 3, clipTimeMs: 33 },
  ]);
  const back = unpackPose(packPose(player));
  assert.equal(back.frames[0]!.landmarks, null);
  assert.deepEqual(back.frames[1]!.landmarks![0], [0.5, 0.5, 0.9]);
});

test("same reference, same key; another reference, another key", () => {
  assert.equal(fingerprint(packPose(timeline(dance))), fingerprint(packPose(timeline(dance))));
  assert.notEqual(fingerprint(packPose(timeline(dance))), fingerprint(packPose(timeline(squatDance))));
});

test("stood-still and nailed expectations read the re-scored round", () => {
  const still = record("stood-still", timeline(dance), timeline(() => STAND));
  const good = record("nailed");
  const items: Rescored[] = [still, good].map((r) => ({ record: r, now: rescore(r), was: r.result.score }));
  assert.equal(judge(items[0]!, items)!.holds, true);
  assert.equal(judge(items[1]!, items)!.holds, true);
  assert.equal(judge({ ...items[1]!, record: { ...good, tag: null } }, items), null);
});

test("seated applies only when the clip swings its legs", () => {
  assert.ok(legSwingDeg(timeline(squatDance)) >= 25);
  assert.ok(legSwingDeg(timeline(() => STAND)) < 5);
});

test("what-if changes a constant and refuses names that are not numbers", () => {
  const old = setConstant("ROUND.ceiling", 0.9);
  assert.equal(old.error, null);
  setConstant("ROUND.ceiling", old.data!);
  assert.notEqual(setConstant("ROUND.nope", 1).error, null);
  assert.notEqual(setConstant("ceiling", 1).error, null);
});
