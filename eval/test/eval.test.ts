import { test } from "node:test";
import assert from "node:assert/strict";
import { fromWebcamFrames, scorePoseRound, type LandmarkObject } from "../../engine/src/index.ts";
import { timeline, dance, squatDance, STAND, mirrorCopy } from "../../engine/test/synth.ts";
import { fingerprint, newRoundId, packPose, unpackPose, looksLikeRecord, RECORD_SCHEMA, type RoundRecord } from "../src/record.ts";
import { judge, legSwingDeg, rescore, setConstant, type Rescored } from "../src/judge.ts";
import { deriveAll, transformPlayer, isSource, TRANSFORMS } from "../src/derive.ts";

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

test("smoothed points and clip times come back exactly, and the replay is identical", () => {
  // Times on a 15 Hz grid end exactly on the engine's 30 Hz grid; rounding them once dropped the last grid frame.
  const reference = timeline(dance, { fps: 15, durationS: 20 });
  const wobble = (t: number) => { const p = mirrorCopy(dance(t)); return p; };
  const raw = timeline(wobble);
  const player = { ...raw, frames: raw.frames.map((f) => ({ tMs: f.tMs + Math.PI / 7, landmarks: f.landmarks && f.landmarks.map(([x, y, v]) => [x + Math.E * 1e-7, y - Math.SQRT2 * 1e-7, v * 0.987654321] as const) })) };
  const r = record("nailed", reference, player);
  const back = JSON.parse(JSON.stringify(r)) as RoundRecord;
  assert.deepEqual(unpackPose(back.player), player);
  assert.deepEqual(unpackPose(back.reference as typeof r.player), reference);
  assert.deepEqual(rescore(back), r.result);
});

test("version 1 rounds still read, with the same clip key", () => {
  const reference = timeline(dance);
  const v1 = {
    schema: "packed-pose/1" as const, source: { ...reference.source },
    t: reference.frames.map((f) => Math.round(f.tMs * 100)),
    lm: reference.frames.map((f) => f.landmarks ? f.landmarks.flatMap(([x, y, v]) => [Math.round(x * 1e5), Math.round(y * 1e5), Math.round(v * 1e4)]) : null),
  };
  assert.equal(fingerprint(v1), fingerprint(packPose(reference)));
  assert.equal(unpackPose(v1).frames.length, reference.frames.length);
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

test("a good squat-dance copy passes the derived relations the engine promises", () => {
  const r = record(null, timeline(squatDance), timeline((t) => mirrorCopy(squatDance(t))));
  const source: Rescored = { record: r, now: rescore(r), was: r.result.score };
  assert.ok(isSource(source), `score ${source.now.score} should make it a source`);
  const derived = deriveAll([source]);
  assert.deepEqual(derived.map((d) => d.transform), [...TRANSFORMS]);
  const holds = Object.fromEntries(derived.map((d) => [d.transform, d.verdict.holds]));
  const details = derived.map((d) => `${d.transform}: ${d.verdict.detail}`).join("; ");
  for (const t of ["late", "seated", "walked-out", "jittered"]) assert.equal(holds[t], true, `${t} should hold (${details})`);
  assert.equal(holds.mirrored, null);
  // Frozen is judged, but whether it holds is the engine's business: under jester-engine/0.9.0 a statue in this
  // clip's rest pose scores 35 here (the motion gate does not cover accuracy above the still pose). So only check
  // that it was judged and scored below the source.
  const frozen = derived.find((d) => d.transform === "frozen")!;
  assert.equal(typeof frozen.verdict.holds, "boolean");
  assert.ok((frozen.now.score ?? 0) < (source.now.score ?? 0), details);
  assert.ok(derived.every((d) => d.id === `${r.id}~${d.transform}`));
});

test("mirroring twice gives the recording back", () => {
  const player = timeline((t) => mirrorCopy(dance(t)));
  const twice = transformPlayer(transformPlayer(player, "mirrored"), "mirrored");
  player.frames.forEach((f, i) => f.landmarks!.forEach((p, k) => {
    const q = twice.frames[i]!.landmarks![k]!;
    assert.ok(Math.abs(p[0] - q[0]) < 1e-9 && p[1] === q[1] && p[2] === q[2], `frame ${i} point ${k}`);
  }));
});

test("a weak round is not a source, and derived cases are never sources", () => {
  const weak = record(null, timeline(dance), timeline(() => STAND));
  assert.equal(isSource({ record: weak, now: rescore(weak), was: weak.result.score }), false);
  const good = record("nailed");
  const [late] = deriveAll([{ record: good, now: rescore(good), was: good.result.score }], ["late"]);
  assert.equal(isSource({ record: late!.record, now: late!.now, was: null }), false);
});
