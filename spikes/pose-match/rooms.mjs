// Online rooms: join by code, start together, send results. Transport-agnostic: the room only
// needs something that can broadcast a message to the others in the same room code.
//
// Transport interface (see MemoryBus and BroadcastChannelTransport below):
//   { send(msg), onMessage(fn), close() }      send() reaches everyone else, never the sender.
// A hosted service (Firebase, Supabase, PartyKit) only has to implement those three calls.
//
// What crosses the network: join info, a start time, and each player's score plus compact
// timeline (pose data only, see serialize.mjs). Never video.

const CODE_LETTERS = "ABCDEFGHJKMNPQRSTUVWXYZ"; // no I or L or O, hard to misread
export function makeRoomCode(rand = Math.random) {
  let code = "";
  for (let i = 0; i < 4; i++) code += CODE_LETTERS[Math.floor(rand() * CODE_LETTERS.length)];
  return code;
}
export const normalizeCode = (code) => String(code || "").trim().toUpperCase();

export class Room {
  constructor({ transport, code, playerId, name, now = () => Date.now() }) {
    this.transport = transport; this.code = normalizeCode(code); this.me = playerId; this.name = name || playerId; this.now = now;
    this.players = new Map();   // playerId -> { id, name, joinedAt }
    this.results = new Map();   // playerId -> { score, timeline, at }
    this.round = null;          // { clipId, startAt (local clock), roundNo }
    this.listeners = { update: [], start: [] };
    this.skew = 0;              // estimated (my clock - sender clock), updated from each message
    this.joinedAt = this.now();
    this.players.set(this.me, { id: this.me, name: this.name, joinedAt: this.joinedAt });
    this.unsubscribe = transport.onMessage((m) => this.#receive(m));
  }

  on(event, fn) { this.listeners[event].push(fn); return () => { this.listeners[event] = this.listeners[event].filter((f) => f !== fn); }; }
  #emit(event, arg) { for (const fn of this.listeners[event]) fn(arg ?? this); }
  #send(msg) { this.transport.send({ ...msg, room: this.code, from: this.me, sentAt: this.now() }); }

  join() { this.#send({ type: "join", name: this.name, joinedAt: this.joinedAt }); }
  leave() { this.#send({ type: "leave" }); this.unsubscribe?.(); this.transport.close?.(); }

  // The host is the player who joined first (ties broken by id), so everyone agrees without a server.
  get hostId() { return [...this.players.values()].sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1))[0].id; }
  get isHost() { return this.hostId === this.me; }
  roster() { return [...this.players.values()].sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1)); }

  // Host only. Everyone starts at the same moment: delayMs from now on the host's clock.
  start(clipId, delayMs = 3000) {
    if (!this.isHost) throw new Error("Only the host can start the round");
    const roundNo = (this.round?.roundNo ?? 0) + 1;
    const startAt = this.now() + delayMs;
    this.results = new Map();
    this.round = { clipId, startAt, roundNo };
    this.#send({ type: "start", clipId, startAt, roundNo });
    this.#emit("start", this.round);
    this.#emit("update");
    return this.round;
  }

  // Send my score and compact timeline once my round is over.
  submitResult({ score, timeline }) {
    const entry = { score, timeline: timeline ?? null, at: this.now() };
    this.results.set(this.me, entry);
    this.#send({ type: "result", roundNo: this.round?.roundNo ?? 0, score, timeline: timeline ?? null });
    this.#emit("update");
  }

  // Players with a result, best first; players still playing are listed after, with score null.
  standings() {
    const rows = this.roster().map((p) => ({ id: p.id, name: p.name, score: this.results.get(p.id)?.score ?? null, timeline: this.results.get(p.id)?.timeline ?? null }));
    return rows.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
  }
  get allDone() { return this.roster().every((p) => this.results.has(p.id)); }

  #receive(m) {
    if (!m || m.room !== this.code || m.from === this.me) return;
    this.skew = this.now() - m.sentAt;
    switch (m.type) {
      case "join": {
        const isNew = !this.players.has(m.from);
        this.players.set(m.from, { id: m.from, name: m.name || m.from, joinedAt: m.joinedAt ?? this.now() });
        if (isNew) this.#send({ type: "join", name: this.name, joinedAt: this.joinedAt }); // so the newcomer sees me
        break;
      }
      case "leave": this.players.delete(m.from); this.results.delete(m.from); break;
      case "start": {
        // translate the host's start time into my clock (skew includes network delay, fine for a party game)
        this.round = { clipId: m.clipId, startAt: m.startAt + this.skew, roundNo: m.roundNo };
        this.results = new Map();
        this.#emit("start", this.round);
        break;
      }
      case "result":
        if (m.roundNo === (this.round?.roundNo ?? 0)) this.results.set(m.from, { score: m.score, timeline: m.timeline ?? null, at: this.now() });
        break;
    }
    this.#emit("update");
  }
}

// ---- Transports ----

// In-process bus for tests and for two rooms in one page.
export class MemoryBus {
  constructor() { this.members = new Set(); }
  transport() {
    const bus = this, handlers = [];
    const member = { handlers };
    bus.members.add(member);
    return {
      send(msg) { for (const other of bus.members) if (other !== member) for (const h of other.handlers) queueMicrotask(() => h(JSON.parse(JSON.stringify(msg)))); },
      onMessage(fn) { handlers.push(fn); return () => handlers.splice(handlers.indexOf(fn), 1); },
      close() { bus.members.delete(member); },
    };
  }
}

// Two tabs of the same browser on one machine (no account, no server). Good for trying rooms today.
export function broadcastChannelTransport(code) {
  const channel = new BroadcastChannel("jester-room-" + normalizeCode(code));
  return {
    send(msg) { channel.postMessage(msg); },
    onMessage(fn) { channel.onmessage = (e) => fn(e.data); return () => { channel.onmessage = null; }; },
    close() { channel.close(); },
  };
}
