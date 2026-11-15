import { test } from "node:test";
import assert from "node:assert/strict";
import { Room, MemoryBus, makeRoomCode, normalizeCode } from "./rooms.mjs";

const tick = () => new Promise((r) => setTimeout(r, 0));
function makeRooms(names, clocks = {}) {
  const bus = new MemoryBus();
  return names.map((n, i) => new Room({ transport: bus.transport(), code: "abcd", playerId: n, name: n.toUpperCase(), now: clocks[n] ?? (() => 1000 + i) }));
}

test("room codes are 4 safe letters and are normalized", () => {
  assert.match(makeRoomCode(), /^[A-HJKMNP-Z]{4}$/);
  assert.equal(normalizeCode(" abcd "), "ABCD");
});

test("everyone sees everyone after joining, including late joiners", async () => {
  const [a, b, c] = makeRooms(["ana", "ben", "cy"]);
  a.join(); await tick();
  b.join(); await tick();
  c.join(); await tick();
  for (const r of [a, b, c]) assert.deepEqual(r.roster().map((p) => p.id), ["ana", "ben", "cy"]);
});

test("the first to join is host; only the host can start", async () => {
  const [a, b] = makeRooms(["ana", "ben"]);
  a.join(); b.join(); await tick();
  assert.equal(a.isHost, true);
  assert.equal(b.isHost, false);
  assert.throws(() => b.start("clip1"), /host/);
});

test("start reaches everyone with the same round and a start time on their own clock", async () => {
  let ta = 10_000, tb = 50_000; // clocks 40 s apart
  const bus = new MemoryBus();
  const a = new Room({ transport: bus.transport(), code: "ROOM", playerId: "ana", name: "Ana", now: () => ta });
  const b = new Room({ transport: bus.transport(), code: "ROOM", playerId: "ben", name: "Ben", now: () => tb });
  a.join(); await tick(); b.join(); await tick();
  const started = [];
  b.on("start", (r) => started.push(r));
  const round = a.start("clipX", 3000);
  await tick();
  assert.equal(round.startAt, 13_000);
  assert.equal(started.length, 1);
  assert.equal(b.round.clipId, "clipX");
  assert.equal(b.round.roundNo, 1);
  assert.equal(b.round.startAt, 13_000 + (tb - ta)); // 3000 ms after "now" on Ben's clock too
});

test("results are collected, ranked best first, and allDone flips when everyone sent one", async () => {
  const [a, b, c] = makeRooms(["ana", "ben", "cy"]);
  a.join(); b.join(); c.join(); await tick();
  a.start("clip"); await tick();
  a.submitResult({ score: 70 }); b.submitResult({ score: 91, timeline: { v: 1, f: [] } }); await tick();
  assert.equal(a.allDone, false);
  assert.deepEqual(a.standings().map((r) => [r.id, r.score]), [["ben", 91], ["ana", 70], ["cy", null]]);
  c.submitResult({ score: 40 }); await tick();
  assert.equal(a.allDone, true);
  assert.equal(b.standings()[0].id, "ben");
  assert.deepEqual(c.standings().find((r) => r.id === "ben").timeline, { v: 1, f: [] });
});

test("a new round clears old results and ignores late results from the last round", async () => {
  const [a, b] = makeRooms(["ana", "ben"]);
  a.join(); b.join(); await tick();
  a.start("c1"); await tick();
  b.submitResult({ score: 50 }); await tick();
  a.start("c2"); await tick();
  assert.equal(a.round.roundNo, 2);
  assert.equal(a.standings().every((r) => r.score === null), true);
  b.round = { ...b.round, roundNo: 1 }; // Ben is still on round 1 and sends late
  b.submitResult({ score: 99 }); await tick();
  assert.equal(a.standings().find((r) => r.id === "ben").score, null);
});

test("messages for other rooms are ignored and leaving removes the player", async () => {
  const bus = new MemoryBus();
  const a = new Room({ transport: bus.transport(), code: "AAAA", playerId: "ana" });
  const x = new Room({ transport: bus.transport(), code: "BBBB", playerId: "xx" });
  const b = new Room({ transport: bus.transport(), code: "AAAA", playerId: "ben" });
  a.join(); x.join(); b.join(); await tick();
  assert.deepEqual(a.roster().map((p) => p.id).sort(), ["ana", "ben"]);
  b.leave(); await tick();
  assert.deepEqual(a.roster().map((p) => p.id), ["ana"]);
});

test("start can carry extra data (role assignments) and results can carry extra (role name)", async () => {
  const [a, b] = makeRooms(["ana", "ben"]);
  a.join(); b.join(); await tick();
  a.start("scene1", 1000, { assign: { ana: 0, ben: 1 } }); await tick();
  assert.deepEqual(b.round.extra, { assign: { ana: 0, ben: 1 } });
  b.submitResult({ score: 80, extra: { role: "the ball", guideIndex: 1 } }); await tick();
  assert.deepEqual(a.standings().find((r) => r.id === "ben").extra, { role: "the ball", guideIndex: 1 });
  assert.equal(a.standings().find((r) => r.id === "ana").extra, null);
});

test("ready flags travel, late joiners see them, and allReady needs everyone", async () => {
  const bus = new MemoryBus();
  const mk = (id, now) => new Room({ transport: bus.transport(), code: "RDY1", playerId: id, name: id, now: () => now });
  const a = mk("ana", 1000), b = mk("ben", 1001);
  a.join(); b.join(); await tick();
  assert.equal(a.allReady, false);
  a.setReady(true); b.setReady(true); await tick();
  assert.equal(a.allReady, true);
  assert.equal(b.allReady, true);
  const c = mk("cy", 1002);                       // joins late
  c.join(); await tick();
  assert.equal(a.allReady, false);                 // the newcomer is not ready yet
  assert.equal(c.roster().find((p) => p.id === "ana").ready, true); // but sees that Ana is
  c.setReady(true); await tick();
  assert.equal(a.allReady, true);
  b.setReady(false); await tick();
  assert.equal(c.allReady, false);
});
