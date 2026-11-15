// Open rooms list: players see joinable rooms without typing a code. Runs on ONE shared channel
// (the caller passes a transport made for the channel name "LOBBY"; transports are not created here).
//
// Hosts announce their room; everyone listening keeps a map code -> info with a local seenAt stamp.
// A room that stops being re-announced goes stale and drops out of list(). Messages are untrusted:
// anything malformed is ignored and text fields are data only (trimmed, never evaluated or used as keys).

const CODE_RE = /^[A-Z]{4}$/;
const MAX_TEXT = 20;
const MAX_COUNT = 16;

const isCount = (n) => Number.isInteger(n) && n >= 0 && n <= MAX_COUNT;

/** Returns a clean room record or null if the message is not a valid "room" announcement. */
function cleanRoom(m) {
  if (!m || typeof m !== "object") return null;
  if (typeof m.code !== "string" || !CODE_RE.test(m.code)) return null;
  if (typeof m.hostName !== "string" || typeof m.sceneId !== "string") return null;
  if (!isCount(m.players) || !isCount(m.max)) return null;
  return { code: m.code, hostName: m.hostName.slice(0, MAX_TEXT), sceneId: m.sceneId.slice(0, MAX_TEXT), players: m.players, max: m.max };
}

export class OpenLobby {
  constructor({ transport, now = () => Date.now(), announceMs = 3000, staleMs = 8000, heartbeat = true }) {
    this.transport = transport; this.now = now; this.announceMs = announceMs; this.staleMs = staleMs;
    this.rooms = new Map();      // code -> { code, hostName, sceneId, players, max, seenAt }
    this.announced = new Map();  // code -> record I am announcing
    this.listeners = { update: [] };
    this.timer = null;
    this.unsubscribe = transport.onMessage((m) => this.#receive(m));
    if (heartbeat && announceMs > 0) {
      this.timer = setInterval(() => this.tick(), announceMs);
      this.timer.unref?.(); // never keep a Node process alive
    }
  }

  on(event, fn) { this.listeners[event].push(fn); return () => { this.listeners[event] = this.listeners[event].filter((f) => f !== fn); }; }
  #emit(event) { for (const fn of [...this.listeners[event]]) fn(this); }

  /** Host: start (or update) announcing a room. Invalid input throws, since it is our own bug. */
  announce({ code, hostName, sceneId, players, max }) {
    const room = cleanRoom({ code, hostName, sceneId, players, max });
    if (!room) throw new Error("Invalid room announcement");
    this.announced.set(room.code, room);
    this.#broadcast(room);
    return room;
  }

  /** Host: stop announcing and tell everyone the room is gone. */
  withdraw(code) {
    if (!this.announced.delete(code)) return false;
    this.transport.send({ type: "closed", code });
    return true;
  }

  #broadcast(room) { this.transport.send({ type: "room", ...room }); }

  /** One heartbeat: re-broadcast every room I host, and drop stale rooms I have heard about. */
  tick() {
    for (const room of this.announced.values()) this.#broadcast(room);
    this.prune();
  }

  #fresh(r) { return this.now() - r.seenAt <= this.staleMs; }

  /** Removes rooms not heard from within staleMs. Returns true if any were removed. */
  prune() {
    let removed = false;
    for (const [code, r] of [...this.rooms]) if (!this.#fresh(r)) { this.rooms.delete(code); removed = true; }
    if (removed) this.#emit("update");
    return removed;
  }

  /** Joinable rooms: recently seen and not full, newest first. */
  list() {
    return [...this.rooms.values()]
      .filter((r) => this.#fresh(r) && r.players < r.max)
      .map((r, i) => ({ r, i }))
      .sort((a, b) => b.r.seenAt - a.r.seenAt || b.i - a.i)
      .map(({ r }) => ({ ...r }));
  }

  close() {
    clearInterval(this.timer); this.timer = null;
    this.unsubscribe?.(); this.unsubscribe = null;
    this.transport.close?.();
  }

  #receive(m) {
    if (!m || typeof m !== "object") return;
    if (m.type === "room") {
      const room = cleanRoom(m);
      if (!room) return;
      const old = this.rooms.get(room.code);
      this.rooms.set(room.code, { ...room, seenAt: this.now() });
      const changed = !old || !this.#fresh({ seenAt: old.seenAt }) || old.hostName !== room.hostName || old.sceneId !== room.sceneId || old.players !== room.players || old.max !== room.max;
      if (changed) this.#emit("update");
    } else if (m.type === "closed") {
      if (typeof m.code !== "string" || !CODE_RE.test(m.code)) return;
      if (this.rooms.delete(m.code)) this.#emit("update");
    }
  }
}
