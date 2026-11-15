import assert from "node:assert/strict";
import { test } from "node:test";
import { packPose } from "../../eval/src/record.ts";
import { deserializeTimeline } from "../../spikes/pose-match/serialize.mjs";
import {
  GHOST_NOTE, GHOST_TAG, ghostCandidates, ghostName, ghostNames, ghostScoreAt, ghostStanding, isGhost, makeGhost, pickClip, pickGhosts, withGhosts,
  type GhostRecord, type GhostRow,
} from "../src/ghosts.ts";

const row = (id: string, score: number | null, extra: Partial<GhostRow> = {}): GhostRow => ({ id, score, tag: null, bankId: "dance", channel: "pose", ...extra });

test("ghosts come only from untagged rounds with a score on the same bank clip", () => {
  const rows = [
    row("ok", 70),
    row("tagged", 80, { tag: "nailed" }),
    row("no-score", null),
    row("no-bank", 60, { bankId: null }),
    row("other-clip", 50, { bankId: "juggle" }),
    row("thing", 40, { channel: "trajectory" }),
    row("ok", 70),                                      // the same round twice (local and shared copies)
    row("old", 30, { channel: undefined }),
  ];
  assert.deepEqual(ghostCandidates(rows, "dance").map((r) => r.id), ["ok", "old"]);
  assert.deepEqual(ghostCandidates(rows, "nothing-here"), []);
});

test("pickGhosts takes everyone when there are few, else one from each band of scores, best first", () => {
  assert.deepEqual(pickGhosts([row("a", 50), row("b", 90)], "dance", 3), ["b", "a"]);
  const nine = [10, 20, 30, 40, 50, 60, 70, 80, 90].map((s) => row("r" + s, s));
  assert.deepEqual(pickGhosts(nine, "dance", 3, () => 0), ["r90", "r60", "r30"]);
  assert.deepEqual(pickGhosts(nine, "dance", 3, () => 0.999), ["r70", "r40", "r10"]);
  assert.deepEqual(pickGhosts(nine, "dance", 0), []);
  assert.deepEqual(pickGhosts(nine, "juggle", 3), []);
});

test("ghost names are made up, the same for the same round, all different in one match, and shown as they are", () => {
  assert.equal(ghostName("r-abc"), ghostName("r-abc"));
  const names = ghostNames(["r-1", "r-2", "r-3", "r-1"]);
  assert.equal(new Set(names).size, 4);
  const g = makeGhost(record("r-1", 60, [1, 1]), names[0]!);
  const standing = ghostStanding(g, 0, 1000);
  assert.equal(standing.name, names[0]);
  assert.ok(isGhost(standing.id));
  assert.equal(GHOST_NOTE, "a ghost from an earlier round");
  assert.equal(GHOST_TAG, "ghost");
});

function record(id: string, score: number, credits: (number | null)[]): GhostRecord {
  const frames = credits.map((_, i) => ({ tMs: i * 100, landmarks: Array.from({ length: 33 }, (_, k) => [0.5, k / 40, 0.9] as [number, number, number]) }));
  return { id, score, player: packPose({ schema: "pose-timeline/1", source: { width: 640, height: 480, mirrored: false }, frames }), result: { score, lagMs: 120, frameCredits: credits, worstLimb: { label: "left forearm" } } };
}

test("a ghost's live score fills to its final score, only while it was copying well", () => {
  const g = makeGhost(record("r-x", 80, [1, 1, null, 0, 0, 1, 1, 1]), "Noodle");   // grid frames 33.3 ms apart
  const at = (k: number) => ghostScoreAt(g, k * (1000 / 30) + 1);
  assert.equal(ghostScoreAt(g, -50), 0);
  assert.equal(at(0), 16);                // 1 of 5 credits
  assert.equal(at(1), 32);
  assert.equal(at(4), 32);                // nothing gained while it was off
  assert.equal(at(6), 64);
  assert.equal(at(7), 80);                // the last frame: the final score
  assert.equal(ghostScoreAt(g, 60_000), 80);
  const flat = makeGhost(record("r-y", 50, [0, 0, 0, 0]), "Biscuit");              // no credit anywhere: fills evenly
  assert.equal(ghostScoreAt(flat, 1000 / 30 + 1), 25);
});

test("a ghost replays its poses in the reveal's format", () => {
  const g = makeGhost(record("r-x", 80, [1, 1, 1]), "Noodle");
  const t = deserializeTimeline(g.timeline) as { frames: { t: number; landmarks: { x: number; y: number }[] }[]; aspect: number };
  assert.equal(t.frames.length, 3);
  assert.equal(t.frames[1]!.t, 100);
  assert.equal(t.frames[0]!.landmarks.length, 33);
  assert.ok(Math.abs(t.frames[0]!.landmarks[20]!.y - 0.5) < 0.002);
  assert.ok(Math.abs(t.aspect - 4 / 3) < 1e-9);
});

test("ghosts are ranked in with the players", () => {
  const table = { ranked: [{ id: "p1", name: "Ana", place: 1, score: 70, lagMs: 0, worst: null, credits: [], bucketMs: 200, timeline: null, error: null }], waiting: [], out: [] };
  const strong = ghostStanding(makeGhost(record("r-a", 90, [1]), "Noodle"), 0, 1000);
  const weak = ghostStanding(makeGhost(record("r-b", 40, [1]), "Biscuit"), 0, 1000);
  const merged = withGhosts(table, [weak, strong]);
  assert.deepEqual(merged.ranked.map((r) => [r.name, r.place]), [["Noodle", 1], ["Ana", 2], ["Biscuit", 3]]);
});

test("the clip: a bank clip over the starter, and one with ghosts for someone alone", () => {
  const info = (id: string) => ({ id, title: id, credit: "", durationMs: 20_000, poster: null });
  const clips = [info("starter"), info("dance"), info("juggle")];
  const rows = [row("g1", 70, { bankId: "juggle" })];
  assert.equal(pickClip(clips, rows, { alone: true, starterId: "starter", rand: () => 0 })?.id, "juggle");
  assert.equal(pickClip(clips, rows, { alone: false, starterId: "starter", rand: () => 0 })?.id, "dance");
  assert.equal(pickClip([info("starter")], [], { alone: true, starterId: "starter" })?.id, "starter");
  assert.equal(pickClip([info("starter")], [row("s", 50, { bankId: "starter" })], { alone: true, starterId: "starter" })?.id, "starter");
});
