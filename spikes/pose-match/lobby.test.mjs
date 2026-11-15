import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryBus } from "./rooms.mjs";
import { OpenLobby } from "./lobby.mjs";

const tick = () => new Promise((r) => setTimeout(r, 0));
function setup() {
  const bus = new MemoryBus();
  const clock = { t: 1000 };
  const make = () => new OpenLobby({ transport: bus.transport(), now: () => clock.t, heartbeat: false });
  return { bus, clock, host: make(), guest: make() };
}
const room = (over = {}) => ({ code: "ABCD", hostName: "Ana", sceneId: "disco", players: 1, max: 4, ...over });

test("a listener sees an announced room", async () => {
  const { host, guest } = setup();
  let updates = 0; guest.on("update", () => updates++);
  host.announce(room()); await tick();
  const [r] = guest.list();
  assert.deepEqual([r.code, r.hostName, r.sceneId, r.players, r.max], ["ABCD", "Ana", "disco", 1, 4]);
  assert.equal(updates, 1);
});

test("a room not re-announced for 8 s disappears; re-announcing keeps it", async () => {
  const { host, guest, clock } = setup();
  host.announce(room()); await tick();
  clock.t += 5000; host.tick(); await tick();
  clock.t += 5000;
  assert.equal(guest.list().length, 1, "10 s since first, 5 s since refresh");
  clock.t += 3001;
  assert.equal(guest.list().length, 0);
  assert.equal(guest.prune(), true);
  assert.equal(guest.rooms.size, 0);
});

test("a full room is hidden, and shows again when a seat opens", async () => {
  const { host, guest } = setup();
  host.announce(room({ players: 4, max: 4 })); await tick();
  assert.equal(guest.list().length, 0);
  host.announce(room({ players: 3, max: 4 })); await tick();
  assert.equal(guest.list().length, 1);
});

test("withdraw removes the room and stops re-announcing it", async () => {
  const { host, guest } = setup();
  host.announce(room()); await tick();
  assert.equal(host.withdraw("ABCD"), true);
  await tick();
  assert.equal(guest.list().length, 0);
  host.tick(); await tick();
  assert.equal(guest.list().length, 0);
  assert.equal(host.withdraw("ABCD"), false);
});

test("malformed input is ignored and long text is trimmed", async () => {
  const { bus, guest } = setup();
  const raw = bus.transport();
  const bad = [
    { type: "room", code: "abcd", hostName: "x", sceneId: "s", players: 1, max: 4 },
    { type: "room", code: "ABCDE", hostName: "x", sceneId: "s", players: 1, max: 4 },
    { type: "room", code: "AB1D", hostName: "x", sceneId: "s", players: 1, max: 4 },
    { type: "room", code: "ABCD", hostName: 5, sceneId: "s", players: 1, max: 4 },
    { type: "room", code: "ABCD", hostName: "x", sceneId: null, players: 1, max: 4 },
    { type: "room", code: "ABCD", hostName: "x", sceneId: "s", players: 1.5, max: 4 },
    { type: "room", code: "ABCD", hostName: "x", sceneId: "s", players: -1, max: 4 },
    { type: "room", code: "ABCD", hostName: "x", sceneId: "s", players: 1, max: 17 },
    { type: "room", code: "ABCD", hostName: "x", sceneId: "s", players: "1", max: 4 },
    { type: "room", code: "__proto__", hostName: "x", sceneId: "s", players: 1, max: 4 },
    { type: "closed", code: "nope" }, { type: "weird" }, null, "str", 7,
  ];
  for (const m of bad) raw.send(m);
  await tick();
  assert.equal(guest.rooms.size, 0);
  raw.send({ type: "room", code: "WXYZ", hostName: "<script>alert(1)</script>".padEnd(50, "!"), sceneId: "s".repeat(99), players: 0, max: 16 });
  await tick();
  const [r] = guest.list();
  assert.equal(r.hostName.length, 20);
  assert.equal(r.hostName, "<script>alert(1)</sc");
  assert.equal(r.sceneId.length, 20);
});

test("tick re-broadcasts every announced room", async () => {
  const { host, guest, clock } = setup();
  host.announce(room()); host.announce(room({ code: "WXYZ", hostName: "Bo" })); await tick();
  clock.t += 6000;
  host.tick(); await tick();
  assert.equal(guest.list().length, 2);
  assert.ok(guest.list().every((r) => r.seenAt === 7000));
});

test("list is newest first", async () => {
  const { host, guest, clock } = setup();
  host.announce(room()); await tick();
  clock.t += 1000;
  host.announce(room({ code: "WXYZ" })); await tick();
  assert.deepEqual(guest.list().map((r) => r.code), ["WXYZ", "ABCD"]);
});

test("heartbeat timer re-announces and close() stops it", async () => {
  const bus = new MemoryBus();
  const host = new OpenLobby({ transport: bus.transport(), announceMs: 5 });
  const guest = new OpenLobby({ transport: bus.transport(), heartbeat: false });
  host.announce(room()); await tick();
  const first = guest.list()[0].seenAt;
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(guest.list()[0].seenAt >= first);
  host.close();
  assert.equal(host.timer, null);
});
