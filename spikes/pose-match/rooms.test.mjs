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

// ---- sturdier rooms: presence, host handoff, late joiners, clock sync ----
function clockRoom(bus, id, clock, joinedAt) {
  const r = new Room({ transport: bus.transport(), code: "STRD", playerId: id, name: id, now: () => clock.t, heartbeatMs: 0 });
  r.joinedAt = joinedAt; r.players.get(id).joinedAt = joinedAt;
  return r;
}

test("someone silent for 10 s is dropped, the round stops waiting for them, and the host role passes on", async () => {
  const bus = new MemoryBus();
  const ca = { t: 1000 }, cb = { t: 1000 }, cc = { t: 1000 };
  const a = clockRoom(bus, "ana", ca, 1), b = clockRoom(bus, "ben", cb, 2), c = clockRoom(bus, "cy", cc, 3);
  a.join(); b.join(); c.join(); await tick();
  assert.equal(b.isHost, false);
  a.start("clip"); await tick();
  b.submitResult({ score: 70 }); c.submitResult({ score: 60 }); await tick();
  assert.equal(b.allDone, false);                         // Ana has not finished
  // Ana's tab closes without saying goodbye (no leave message, she just stops hearing and talking): only Cy keeps pinging
  a.transport.close();
  cb.t += 11000; cc.t += 11000;
  c.tick(); await tick();                                 // Cy's ping reaches Ben, so Ben knows Cy is alive
  b.tick();                                               // Ben prunes: Ana has been silent for 11 s
  assert.deepEqual(b.roster().map((p) => p.id), ["ben", "cy"]);
  assert.equal(b.isHost, true);                           // the next player present is host now
  assert.equal(b.allDone, true);                          // the round no longer waits for Ana
});

test("a player who joins during a round sits it out and does not hold it up", async () => {
  const bus = new MemoryBus();
  const clock = { t: 1000 };
  const a = clockRoom(bus, "ana", clock, 1), b = clockRoom(bus, "ben", clock, 2);
  a.join(); b.join(); await tick();
  a.start("clip"); await tick();
  const c = clockRoom(bus, "cy", clock, 3);
  c.join(); await tick();
  assert.equal(a.standings().find((r) => r.id === "cy").sittingOut, true);
  assert.equal(a.standings().find((r) => r.id === "ana").sittingOut, false);
  a.submitResult({ score: 80 }); b.submitResult({ score: 90 }); await tick();
  assert.equal(a.allDone, true);
  assert.equal(b.allDone, true);
});

test("start in step: a client 40 s ahead of the host still starts at the host's moment", async () => {
  const bus = new MemoryBus();
  const ch = { t: 10_000 }, cg = { t: 50_000 };
  const host = clockRoom(bus, "host", ch, 1), guest = clockRoom(bus, "guest", cg, 2);
  host.join(); guest.join(); await tick();
  guest.tick(); await tick(); await tick();               // ping out, reply back
  assert.ok(Math.abs(guest.offset - (10_000 - 50_000)) < 1, "offset " + guest.offset);
  const round = host.start("clip", 3000);                 // 13_000 on the host's clock
  await tick();
  assert.equal(round.startAt, 13_000);
  assert.equal(guest.round.startAt, 53_000);              // 3 s from now on the guest's clock too
});

test("leaving stops the heartbeat", () => {
  const bus = new MemoryBus();
  const r = new Room({ transport: bus.transport(), code: "STOP", playerId: "x", now: () => 1, heartbeatMs: 50 });
  r.join();
  assert.ok(r.timer);
  r.leave();
  assert.equal(r.timer, null);
});

// ---- media (pictures sent in chunks) ----

const rawMedia = (room, from, over) => ({ room: "ABCD", from, sentAt: 0, type: "media", kind: "face", mid: "m1", i: 0, n: 1, data: "x", ...over });

test("a 100 KB string sent in chunks is fully reassembled on the other room", async () => {
  const [a, b] = makeRooms(["ana", "ben"]);
  a.join(); b.join(); await tick();
  const text = "abc".repeat(35000);
  await a.sendMedia("face", text, { delayMs: 0 });
  await tick();
  assert.equal(b.media.get("ana").face, text);
  assert.equal(a.media.get("ana").face, text);
  assert.equal(b.standings().find((r) => r.id === "ana").media.face, text);
  assert.deepEqual(b.standings().find((r) => r.id === "ben").media, {});
});

test("chunks arriving out of order still reassemble", async () => {
  const bus = new MemoryBus();
  const raw = bus.transport();
  const r = new Room({ transport: bus.transport(), code: "abcd", playerId: "ben", now: () => 1000 });
  raw.send(rawMedia(r, "ana", { i: 2, n: 3, data: "C" }));
  raw.send(rawMedia(r, "ana", { i: 0, n: 3, data: "A" }));
  await tick();
  assert.equal(r.media.has("ana"), false);
  raw.send(rawMedia(r, "ana", { i: 1, n: 3, data: "B" }));
  await tick();
  assert.equal(r.media.get("ana").face, "ABC");
});

test("two players sending different kinds do not mix", async () => {
  const [a, b, c] = makeRooms(["ana", "ben", "cy"]);
  a.join(); b.join(); c.join(); await tick();
  await Promise.all([a.sendMedia("face", "F".repeat(90000), { delayMs: 0 }), b.sendMedia("cutouts", "C".repeat(90000), { delayMs: 0 })]);
  await tick();
  assert.deepEqual(Object.keys(c.media.get("ana")), ["face"]);
  assert.deepEqual(Object.keys(c.media.get("ben")), ["cutouts"]);
  assert.equal(c.media.get("ana").face, "F".repeat(90000));
  assert.equal(c.media.get("ben").cutouts, "C".repeat(90000));
});

test("a newer send of the same kind replaces the older one", async () => {
  const [a, b] = makeRooms(["ana", "ben"]);
  a.join(); b.join(); await tick();
  await a.sendMedia("face", "old", { delayMs: 0 }); await tick();
  await a.sendMedia("face", "new", { delayMs: 0 }); await tick();
  assert.equal(b.media.get("ana").face, "new");
});

test("a new round clears media on the host and on guests", async () => {
  const [a, b] = makeRooms(["ana", "ben"]);
  a.join(); b.join(); await tick();
  await a.sendMedia("face", "hello", { delayMs: 0 }); await tick();
  assert.equal(b.media.size, 1);
  a.start("clip"); await tick();
  assert.equal(a.media.size, 0);
  assert.equal(b.media.size, 0);
});

test("hostile media messages are ignored", async () => {
  const bus = new MemoryBus();
  const raw = bus.transport();
  const r = new Room({ transport: bus.transport(), code: "abcd", playerId: "ben", now: () => 1000 });
  const bad = [
    { kind: "bad kind!" }, { kind: "x".repeat(21) }, { kind: 5 }, { kind: "" },
    { mid: 7 }, { i: 1, n: 1 }, { i: -1, n: 2 }, { i: 0, n: 201 }, { i: 0, n: 0 }, { i: 0.5, n: 2 }, { i: "0" },
    { data: 42 }, { data: null }, { data: "x".repeat(60001) },
  ];
  for (const over of bad) raw.send(rawMedia(r, "evil", over));
  await tick();
  assert.equal(r.media.size, 0);
  assert.equal(r.pendingMedia.size, 0);
});

test("text over 3,000,000 chars or a bad kind throws", async () => {
  const [a] = makeRooms(["ana"]);
  await assert.rejects(() => a.sendMedia("face", "x".repeat(3_000_001), { delayMs: 0 }), /large/);
  await assert.rejects(() => a.sendMedia("bad kind", "x", { delayMs: 0 }), /kind/);
  await assert.rejects(() => a.sendMedia("k".repeat(21), "x", { delayMs: 0 }), /kind/);
  await a.sendMedia("face", "x".repeat(3_000_000), { delayMs: 0 }); // exactly the limit is fine
});

test("a player who leaves or goes silent disappears from media", async () => {
  const bus = new MemoryBus();
  const clock = { t: 1000 };
  const a = clockRoom(bus, "ana", clock, 1), b = clockRoom(bus, "ben", clock, 2), c = clockRoom(bus, "cy", clock, 3);
  a.join(); b.join(); c.join(); await tick();
  await b.sendMedia("face", "BEN", { delayMs: 0 });
  await c.sendMedia("face", "CY", { delayMs: 0 });
  await tick();
  assert.equal(a.media.size, 2);
  b.leave(); await tick();
  assert.equal(a.media.has("ben"), false);
  clock.t += 20000; // cy goes silent
  a.prune();
  assert.equal(a.media.has("cy"), false);
});
