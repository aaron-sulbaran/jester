import { test } from "node:test";
import assert from "node:assert/strict";
import { Room, MemoryBus, RESULT_GRACE_MS, makeRoomCode, normalizeCode } from "./rooms.mjs";

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

// ---- results deadline, rooms made from a match ----

test("results close at the round's length plus 15 s; whoever sent a result is ranked, even after dropping", async () => {
  const bus = new MemoryBus();
  const clock = { t: 1000 };
  const a = clockRoom(bus, "ana", clock, 1), b = clockRoom(bus, "ben", clock, 2), c = clockRoom(bus, "cy", clock, 3);
  a.join(); b.join(); c.join(); await tick();
  const round = a.start("clip", 3000, {}, 20_000);       // starts at 4000, runs 20 s
  await tick();
  assert.equal(round.closeAt, 4000 + 20_000 + RESULT_GRACE_MS);
  assert.equal(b.round.closeAt, round.closeAt);
  b.submitResult({ score: 70 }); await tick();
  b.transport.close();                                    // Ben sent his score, then his tab closed
  let updates = 0;
  a.on("update", () => updates++);
  clock.t = round.closeAt - 1;
  c.tick(); await tick(); a.tick();
  assert.equal(a.allDone, false);                         // Cy has not sent one yet, and it is not closed
  assert.deepEqual(a.roster().map((p) => p.id), ["ana", "cy"]); // Ben dropped: silent for more than 10 s
  clock.t = round.closeAt;
  a.tick();
  assert.equal(a.closed, true);
  assert.equal(a.allDone, true);                          // closed: the round ends without Ana's or Cy's result
  assert.ok(updates >= 1, "closing tells the screen");
  const ranked = a.standings().filter((r) => r.score !== null);
  assert.deepEqual(ranked.map((r) => [r.id, r.score, r.gone]), [["ben", 70, true]]);
});

test("a round without a length waits for everyone, as before", async () => {
  const bus = new MemoryBus();
  const clock = { t: 0 };
  const a = clockRoom(bus, "ana", clock, 1), b = clockRoom(bus, "ben", clock, 2);
  a.join(); b.join(); await tick();
  a.start("clip"); await tick();
  clock.t = 10 * 60_000;
  assert.equal(a.closed, false);
  assert.equal(a.round.closeAt, null);
});

test("a room made from a match ignores outsiders and drops a member who never shows up", async () => {
  const bus = new MemoryBus();
  const clock = { t: 5000 };
  const members = [{ id: "mm", name: "Matchmaker" }, { id: "ana", name: "Ana" }, { id: "nobody", name: "No Show" }];
  const mk = (id) => new Room({ transport: bus.transport(), code: "MTCH", playerId: id, name: id, now: () => clock.t, heartbeatMs: 0, members });
  const mm = mk("mm"), ana = mk("ana");
  const stranger = new Room({ transport: bus.transport(), code: "MTCH", playerId: "zed", name: "Zed", now: () => clock.t, heartbeatMs: 0 });
  mm.join(); ana.join(); stranger.join(); await tick();
  assert.deepEqual(ana.roster().map((p) => p.id), ["mm", "ana", "nobody"]); // known up front, in match order
  assert.equal(mm.isHost, true);                                           // the first member hosts
  assert.equal(ana.hostId, "mm");
  clock.t += 11_000;
  mm.tick(); await tick(); ana.tick();
  assert.deepEqual(ana.roster().map((p) => p.id), ["mm", "ana"]);         // No Show never said a word
  assert.equal(mm.roster().some((p) => p.id === "zed"), false);
});

test("adoptRound starts from the match's time and moves it once the host's clock is measured", async () => {
  const bus = new MemoryBus();
  const ch = { t: 100_000 }, ca = { t: 160_000 };          // Ana's clock is 60 s ahead of the host's
  const members = [{ id: "host", name: "Host" }, { id: "ana", name: "Ana" }];
  const host = new Room({ transport: bus.transport(), code: "ADPT", playerId: "host", now: () => ch.t, heartbeatMs: 0, members });
  const ana = new Room({ transport: bus.transport(), code: "ADPT", playerId: "ana", now: () => ca.t, heartbeatMs: 0, members });
  const starts = [];
  ana.on("start", (r) => starts.push(r.clipId));
  const plan = { clipId: "starter", lengthMs: 20_000, from: "host", startAt: 110_000 };  // 10 s from now on the host's clock
  host.adoptRound(plan);
  ana.adoptRound({ ...plan, estimate: 170_300 });         // a guess from the lobby message, 300 ms late
  assert.equal(host.round.startAt, 110_000);
  assert.equal(ana.round.startAt, 170_300);
  assert.deepEqual(starts, ["starter"]);
  host.join(); ana.join(); await tick(); await tick();    // Ana asks for the host's clock as she joins
  assert.equal(ana.offset, -60_000);
  assert.equal(ana.round.startAt, 170_000);               // corrected to the host's moment
  assert.equal(ana.round.closeAt, 170_000 + 20_000 + RESULT_GRACE_MS);
});

test("the clock is measured again when the host changes", async () => {
  const bus = new MemoryBus();
  const c1 = { t: 1000 }, c2 = { t: 5000 }, c3 = { t: 9000 };
  const a = clockRoom(bus, "ana", c1, 1), b = clockRoom(bus, "ben", c2, 2), c = clockRoom(bus, "cy", c3, 3);
  a.join(); b.join(); c.join(); await tick();
  c.tick(); await tick(); await tick();
  assert.equal(c.offsetFrom, "ana");
  assert.equal(c.offset, 1000 - 9000);
  a.leave(); await tick();                                // Ben hosts now
  c.tick(); await tick(); await tick();
  assert.equal(c.offsetFrom, "ben");
  assert.equal(c.offset, 5000 - 9000);
});
