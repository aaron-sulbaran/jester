import assert from "node:assert/strict";
import { test } from "node:test";
import { Lobby, STALE_MS, decide, matchmaker, type Accepted, type LobbyPresence, type LobbyTransport, type MatchPlan, type Waiter } from "../src/lobby.ts";

const flush = () => new Promise((r) => setTimeout(r, 0));
const w = (id: string, since: number): Waiter => ({ id, name: id.toUpperCase(), since });

/** A lobby channel in memory: presence goes to everyone (sender included), messages to everyone else. */
function memoryLobby() {
  const members = new Map<string, { p: LobbyPresence | null; presence: ((l: LobbyPresence[]) => void)[]; msg: ((m: unknown) => void)[] }>();
  const sent: unknown[] = [];
  const syncAll = () => {
    const list = [...members.values()].map((m) => m.p).filter((p): p is LobbyPresence => !!p);
    for (const m of members.values()) for (const fn of m.presence) fn(list.map((p) => ({ ...p })));
  };
  const transport = (id: string): LobbyTransport => {
    const m = { p: null as LobbyPresence | null, presence: [] as ((l: LobbyPresence[]) => void)[], msg: [] as ((x: unknown) => void)[] };
    members.set(id, m);
    return {
      track(p) { m.p = p; queueMicrotask(syncAll); },
      onPresence(fn) { m.presence.push(fn); return () => {}; },
      send(msg) { sent.push(msg); for (const [other, o] of members) if (other !== id) for (const fn of o.msg) queueMicrotask(() => fn(JSON.parse(JSON.stringify(msg)))); },
      onMessage(fn) { m.msg.push(fn); return () => {}; },
      close() { members.delete(id); queueMicrotask(syncAll); },
    };
  };
  return { transport, sent };
}

const plan = async (members: Waiter[]): Promise<MatchPlan> => ({ code: "ROOM", clipId: "starter", look: "blind", lengthMs: 20_000, ghosts: [], startInMs: 10_000 + members.length });

function client(bus: ReturnType<typeof memoryLobby>, id: string, clock: { t: number }) {
  const lobby = new Lobby({ transport: bus.transport(id), me: id, name: id.toUpperCase(), plan, now: () => clock.t, tickMs: 0 });
  const got: Accepted[] = [];
  lobby.onMatch((a) => got.push(a));
  return { lobby, got };
}

test("the matchmaker is whoever waited longest, ties broken by id", () => {
  assert.equal(matchmaker([w("b", 2000), w("a", 3000), w("c", 1000)])?.id, "c");
  assert.equal(matchmaker([w("b", 1000), w("a", 1000)])?.id, "a");
  assert.equal(matchmaker([]), null);
});

test("only the matchmaker matches: four at once, otherwise whoever is there after 8 s, alone included", () => {
  const four = [w("a", 1000), w("b", 2000), w("c", 3000), w("d", 4000), w("e", 5000)];
  assert.deepEqual(decide(four, "b", 5000), { kind: "wait" });                    // not the matchmaker
  const d = decide(four, "a", 5000);
  assert.equal(d.kind, "match");
  assert.deepEqual(d.kind === "match" && d.members.map((m) => m.id), ["a", "b", "c", "d"]); // the four longest waiting
  const two = [w("a", 1000), w("b", 2000)];
  assert.deepEqual(decide(two, "a", 8999), { kind: "wait" });                     // 7.999 s: keep waiting
  const late = decide(two, "a", 9000);
  assert.deepEqual(late.kind === "match" && late.members.map((m) => m.id), ["a", "b"]);
  const alone = decide([w("a", 1000)], "a", 9000);
  assert.deepEqual(alone.kind === "match" && alone.members.map((m) => m.id), ["a"]);
  assert.deepEqual(decide([w("b", 2000)], "a", 99_000), { kind: "wait" });        // not published yet: wait
});

test("one match message moves everyone it names; its start time is on each client's clock", async () => {
  const bus = memoryLobby();
  const clock = { t: 1000 };
  const a = client(bus, "a", clock); clock.t = 2000;
  const b = client(bus, "b", clock); clock.t = 3000;
  const c = client(bus, "c", clock);
  a.lobby.start(); b.lobby.start(); c.lobby.start(); await flush();
  assert.deepEqual(b.lobby.waiting().map((x) => x.id), ["a", "b", "c"]);
  clock.t = 8999; a.lobby.tick(); b.lobby.tick(); c.lobby.tick(); await flush();
  assert.equal(bus.sent.length, 0);                                               // a has waited 7.999 s
  clock.t = 9000; b.lobby.tick(); c.lobby.tick(); await flush();
  assert.equal(bus.sent.length, 0);                                               // only the matchmaker acts
  a.lobby.tick(); await flush(); await flush();
  assert.equal(bus.sent.length, 1);
  for (const x of [a, b, c]) assert.equal(x.got.length, 1);
  const match = a.got[0]!.match;
  assert.deepEqual(match.members.map((m) => m.id), ["a", "b", "c"]);
  assert.equal(b.got[0]!.match.id, match.id);
  assert.equal(match.startAt, 9000 + 10_003);
  assert.equal(a.got[0]!.estimate, match.startAt);
  for (const x of [a, b, c]) assert.equal(x.lobby.closed, true);                  // everyone left the lobby
});

test("four waiting match at once and the fifth waits for the next match", async () => {
  const bus = memoryLobby();
  const clock = { t: 1000 };
  const all = ["a", "b", "c", "d", "e"].map((id) => { clock.t += 10; return client(bus, id, clock); });
  for (const x of all) x.lobby.start();
  await flush(); await flush(); await flush();
  assert.deepEqual(all.map((x) => x.got.length), [1, 1, 1, 1, 0]);
  assert.deepEqual(all[0]!.got[0]!.match.members.map((m) => m.id), ["a", "b", "c", "d"]);
  assert.equal(all[4]!.lobby.closed, false);
  assert.deepEqual(all[4]!.lobby.waiting().map((x) => x.id), ["e"]);
});

test("a client takes only the first match message that names it", async () => {
  const bus = memoryLobby();
  const clock = { t: 1000 };
  const b = client(bus, "b", clock);
  b.lobby.start(); await flush();
  const other = bus.transport("x");
  const msg = (id: string, members: string[]) => ({ type: "match", id, code: "ROOM", members: members.map((m) => ({ id: m, name: m })), clipId: "starter", look: "blind", startAt: 20_000, lengthMs: 20_000, ghosts: [], from: "x", sentAt: 1000 });
  other.send(msg("not-mine", ["x", "y"]));
  other.send(msg("first", ["x", "b"]));
  other.send(msg("second", ["z", "b"]));
  await flush();
  assert.deepEqual(b.got.map((g) => g.match.id), ["first"]);
});

test("alone after 8 s is a match of one against ghosts, and nothing is broadcast", async () => {
  const bus = memoryLobby();
  const clock = { t: 1000 };
  const a = client(bus, "a", clock);
  a.lobby.start(); await flush();
  clock.t = 9000; a.lobby.tick(); await flush();
  assert.equal(a.got.length, 1);
  assert.deepEqual(a.got[0]!.match.members.map((m) => m.id), ["a"]);
  assert.equal(bus.sent.length, 0);
});

test("a frozen tab that stops refreshing is not waited on as matchmaker", async () => {
  const bus = memoryLobby();
  const clock = { t: 1000 };
  const frozen = client(bus, "a", clock); clock.t = 2000;
  const b = client(bus, "b", clock); clock.t = 3000;
  const c = client(bus, "c", clock);
  frozen.lobby.start(); b.lobby.start(); c.lobby.start(); await flush();
  frozen.lobby.tick = () => {};                            // a's tab freezes: it runs nothing from now on
  // b and c first saw a at 3000 and keep refreshing their own presence
  for (let t = 6000; t < 3000 + STALE_MS; t += 3000) { clock.t = t; b.lobby.tick(); c.lobby.tick(); await flush(); }
  assert.equal(b.got.length, 0);                           // a still looks alive, and a would be the matchmaker
  clock.t = 3000 + STALE_MS + 1; c.lobby.tick(); b.lobby.tick(); await flush(); await flush();
  assert.equal(b.got.length, 1);
  assert.deepEqual(b.got[0]!.match.members.map((m) => m.id), ["b", "c"]);
  assert.equal(c.got.length, 1);
  assert.equal(frozen.got.length, 0);
});
