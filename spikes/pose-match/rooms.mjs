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

// Sturdier rooms (from the Dance Fantasy research, kb/research-dance-fantasy):
//  - presence: every member sends a ping each heartbeat; someone silent for `silentMs` is dropped, the next player
//    becomes host, and a round no longer waits for them
//  - start in step: non-hosts measure how far the host's clock is from theirs (ping and reply, lowest delay wins),
//    so "start at T" means the same moment on every device
//  - late joiners sit out the round in progress and play the next one
const MAX_MEDIA_CHARS = 3_000_000, MAX_CHUNK_CHARS = 60000, MAX_PIECES = 200;
const validKind = (k) => typeof k === "string" && /^[A-Za-z0-9_]{1,20}$/.test(k);

export class Room {
  constructor({ transport, code, playerId, name, now = () => Date.now(), heartbeatMs = 2000, silentMs = 10000 }) {
    this.transport = transport; this.code = normalizeCode(code); this.me = playerId; this.name = name || playerId; this.now = now;
    this.players = new Map();   // playerId -> { id, name, joinedAt }
    this.results = new Map();   // playerId -> { score, timeline, at }
    this.round = null;          // { clipId, startAt (local clock), roundNo }
    this.media = new Map();     // playerId -> { kind: fullText }, pictures sent in chunks after a round
    this.pendingMedia = new Map(); // "from|kind" -> { mid, n, pieces: Map(i -> data), at }
    this.listeners = { update: [], start: [] };
    this.skew = 0;              // estimated (my clock - sender clock), updated from each message
    this.offset = null;         // host clock minus my clock, measured by ping and reply (null until measured)
    this.bestRtt = Infinity;
    this.lastSeen = new Map();  // playerId -> my clock when I last heard from them
    this.heartbeatMs = heartbeatMs; this.silentMs = silentMs; this.timer = null;
    this.joinedAt = this.now();
    this.ready = false;
    this.players.set(this.me, { id: this.me, name: this.name, joinedAt: this.joinedAt, ready: false });
    this.unsubscribe = transport.onMessage((m) => this.#receive(m));
  }

  on(event, fn) { this.listeners[event].push(fn); return () => { this.listeners[event] = this.listeners[event].filter((f) => f !== fn); }; }
  #emit(event, arg) { for (const fn of this.listeners[event]) fn(arg ?? this); }
  #send(msg) { this.transport.send({ ...msg, room: this.code, from: this.me, sentAt: this.now() }); }

  join() {
    this.#send({ type: "join", name: this.name, joinedAt: this.joinedAt, ready: this.ready });
    if (this.heartbeatMs > 0 && !this.timer) {
      this.timer = setInterval(() => this.tick(), this.heartbeatMs);
      this.timer.unref?.(); // never keep a Node process alive
    }
  }

  // One heartbeat: say I am here, ask the host for its clock, and drop anyone who has gone silent.
  tick() {
    this.#send({ type: "ping" });
    if (!this.isHost) this.#send({ type: "sync", t0: this.now() });
    this.prune();
  }

  /** Removes players not heard from for `silentMs`. The host role passes on by itself (earliest joiner present). */
  prune() {
    const t = this.now();
    let removed = false;
    for (const id of [...this.players.keys()]) {
      if (id === this.me) continue;
      const seen = this.lastSeen.get(id);
      if (seen !== undefined && t - seen > this.silentMs) { this.players.delete(id); this.results.delete(id); this.lastSeen.delete(id); this.#dropMedia(id); removed = true; }
    }
    for (const [key, p] of [...this.pendingMedia]) if (t - p.at > 60000) this.pendingMedia.delete(key);
    if (removed) this.#emit("update");
    return removed;
  }

  #dropMedia(id) {
    this.media.delete(id);
    for (const key of [...this.pendingMedia.keys()]) if (key.startsWith(id + "|")) this.pendingMedia.delete(key);
  }

  // Send a long text (for example an image as a data URL) in chunks small enough for the channel.
  async sendMedia(kind, text, { chunkChars = 40000, delayMs = 60 } = {}) {
    if (!validKind(kind)) throw new Error("Bad media kind");
    if (typeof text !== "string") throw new Error("Media must be a string");
    if (text.length > MAX_MEDIA_CHARS) throw new Error("Media too large");
    const size = Math.max(1, Math.min(MAX_CHUNK_CHARS, Math.floor(chunkChars) || 40000));
    const n = Math.max(1, Math.ceil(text.length / size));
    const mid = Math.random().toString(36).slice(2, 10) + this.now().toString(36);
    const mine = { ...(this.media.get(this.me) ?? {}), [kind]: text };
    this.media.set(this.me, mine);
    for (let i = 0; i < n; i++) {
      this.#send({ type: "media", kind, mid, i, n, data: text.slice(i * size, (i + 1) * size) });
      if (delayMs > 0 && i < n - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
    this.#emit("update");
  }

  // Tell the room whether I am ready to play (for example: my whole body is in view). Sent only on change.
  setReady(ready) {
    if (this.ready === ready) return;
    this.ready = ready;
    this.players.get(this.me).ready = ready;
    this.#send({ type: "ready", ready });
    this.#emit("update");
  }
  get allReady() { return this.roster().every((p) => p.ready); }
  leave() { this.#send({ type: "leave" }); clearInterval(this.timer); this.timer = null; this.unsubscribe?.(); this.transport.close?.(); }

  // The host is the player who joined first (ties broken by id), so everyone agrees without a server.
  get hostId() { return [...this.players.values()].sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1))[0].id; }
  get isHost() { return this.hostId === this.me; }
  roster() { return [...this.players.values()].sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1)); }

  // Host only. Everyone starts at the same moment: delayMs from now on the host's clock.
  start(clipId, delayMs = 3000, extra = {}) {
    if (!this.isHost) throw new Error("Only the host can start the round");
    const roundNo = (this.round?.roundNo ?? 0) + 1;
    const startAt = this.now() + delayMs;
    this.results = new Map();
    this.media = new Map(); this.pendingMedia = new Map();
    const players = this.roster().map((p) => p.id); // who is in this round; later joiners sit it out
    this.round = { clipId, startAt, roundNo, extra, players };
    this.#send({ type: "start", clipId, startAt, roundNo, extra, players });
    this.#emit("start", this.round);
    this.#emit("update");
    return this.round;
  }

  // Send my score and compact timeline once my round is over.
  submitResult({ score, timeline, extra }) {
    const entry = { score, timeline: timeline ?? null, extra: extra ?? null, at: this.now() };
    this.results.set(this.me, entry);
    this.#send({ type: "result", roundNo: this.round?.roundNo ?? 0, score, timeline: timeline ?? null, extra: extra ?? null });
    this.#emit("update");
  }

  // Players with a result, best first; players still playing are listed after, with score null.
  standings() {
    const rows = this.roster().map((p) => ({ id: p.id, name: p.name, sittingOut: !!this.round?.players && !this.round.players.includes(p.id), score: this.results.get(p.id)?.score ?? null, timeline: this.results.get(p.id)?.timeline ?? null, extra: this.results.get(p.id)?.extra ?? null, media: this.media.get(p.id) ?? {} }));
    return rows.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
  }
  // Everyone in this round who is still here has sent a result (players who dropped or joined late do not count).
  get allDone() {
    const ids = (this.round?.players ?? this.roster().map((p) => p.id)).filter((id) => this.players.has(id));
    return ids.length > 0 && ids.every((id) => this.results.has(id));
  }

  #receiveMedia(m) {
    if (!validKind(m.kind) || typeof m.mid !== "string" || m.mid.length === 0 || m.mid.length > 64) return;
    if (!Number.isInteger(m.i) || !Number.isInteger(m.n) || m.n < 1 || m.n > MAX_PIECES || m.i < 0 || m.i >= m.n) return;
    if (typeof m.data !== "string" || m.data.length > MAX_CHUNK_CHARS) return;
    const key = m.from + "|" + m.kind;
    let p = this.pendingMedia.get(key);
    if (!p || p.mid !== m.mid) { p = { mid: m.mid, n: m.n, pieces: new Map(), at: this.now() }; this.pendingMedia.set(key, p); } // newer mid wins
    if (p.n !== m.n) return;
    p.pieces.set(m.i, m.data);
    if (p.pieces.size < p.n) return;
    let text = "";
    for (let i = 0; i < p.n; i++) text += p.pieces.get(i);
    this.pendingMedia.delete(key);
    this.media.set(m.from, { ...(this.media.get(m.from) ?? {}), [m.kind]: text });
  }

  #receive(m) {
    if (!m || m.room !== this.code || m.from === this.me) return;
    this.skew = this.now() - m.sentAt;
    this.lastSeen.set(m.from, this.now());
    switch (m.type) {
      case "join": {
        const isNew = !this.players.has(m.from);
        this.players.set(m.from, { id: m.from, name: m.name || m.from, joinedAt: m.joinedAt ?? this.now(), ready: !!m.ready });
        if (isNew) this.#send({ type: "join", name: this.name, joinedAt: this.joinedAt, ready: this.ready }); // so the newcomer sees me
        break;
      }
      case "ping": break; // only proves they are here (lastSeen is already updated)
      case "sync": if (this.isHost) this.#send({ type: "syncReply", to: m.from, t0: m.t0, th: this.now() }); break;
      case "syncReply": {
        if (m.to !== this.me) break;
        const rtt = this.now() - m.t0;
        if (rtt < this.bestRtt) { this.bestRtt = rtt; this.offset = m.th - (m.t0 + rtt / 2); } // host clock minus mine
        break;
      }
      case "ready": { const p = this.players.get(m.from); if (p) p.ready = !!m.ready; break; }
      case "leave": this.players.delete(m.from); this.results.delete(m.from); this.#dropMedia(m.from); break;
      case "media": this.#receiveMedia(m); break;
      case "start": {
        // translate the host's start time into my clock (skew includes network delay, fine for a party game)
        const startAt = this.offset !== null ? m.startAt - this.offset : m.startAt + this.skew; // measured offset if I have one
        this.round = { clipId: m.clipId, startAt, roundNo: m.roundNo, extra: m.extra ?? {}, players: m.players ?? null };
        this.results = new Map();
        this.media = new Map(); this.pendingMedia = new Map();
        this.#emit("start", this.round);
        break;
      }
      case "result":
        if (m.roundNo === (this.round?.roundNo ?? 0)) this.results.set(m.from, { score: m.score, timeline: m.timeline ?? null, extra: m.extra ?? null, at: this.now() });
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
