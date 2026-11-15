// The open lobby for "Play with anyone": no server, one shared Realtime channel (`jester-lobby`).
// Each waiting client publishes its id, a name and the time it arrived (Presence). The client that has waited
// longest is the matchmaker: when four are waiting, or once it has waited 8 seconds, it broadcasts ONE match
// message (a room code, the members, a clip, a start time) and everyone named moves to that room, which is an
// ordinary Room (spikes/pose-match/rooms.mjs) that ignores anyone not in the match. A client accepts only the
// first match message that names it. Alone after 8 seconds: a match of one, against ghosts.
// Pure and DOM free: the transport is passed in (lobbyTransport.ts has Supabase and a one-browser stand-in).

export const LOBBY_CHANNEL = "jester-lobby";
/** Players in one match, ghosts included. */
export const MATCH_SIZE = 4;
/** The matchmaker matches whoever is there once it has waited this long. */
export const MATCH_WAIT_MS = 8000;
/** Each waiting client publishes itself again this often, so a frozen tab can be told from a waiting one. */
export const REFRESH_MS = 3000;
/** A waiting client not refreshed for this long is left out of matches (a closed or frozen tab). */
export const STALE_MS = 3 * REFRESH_MS;

export interface Waiter { id: string; name: string; since: number }
/** What each waiting client publishes: who it is, when it arrived, and a counter it bumps every refresh. */
export interface LobbyPresence extends Waiter { beat: number }

/** Longest waiting first; equal times by id, so every client sorts the same way. */
export const byWait = (a: Waiter, b: Waiter) => a.since - b.since || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The matchmaker: whoever has waited longest. */
export function matchmaker(waiting: readonly Waiter[]): Waiter | null {
  return [...waiting].sort(byWait)[0] ?? null;
}

export type Decision = { kind: "wait" } | { kind: "match"; members: Waiter[] };

/**
 * What `me` should do now. Only the matchmaker acts: with `size` waiting it matches the `size` who waited
 * longest at once; after waiting `waitMs` itself it matches whoever is there, which may be only itself.
 */
export function decide(waiting: readonly Waiter[], me: string, now: number, { size = MATCH_SIZE, waitMs = MATCH_WAIT_MS } = {}): Decision {
  const byId = new Map(waiting.map((w) => [w.id, w]));
  const sorted = [...byId.values()].sort(byWait);
  const mine = byId.get(me);
  if (!mine || sorted[0]!.id !== me) return { kind: "wait" };
  if (sorted.length >= size) return { kind: "match", members: sorted.slice(0, size) };
  if (now - mine.since >= waitMs) return { kind: "match", members: sorted };
  return { kind: "wait" };
}

/** The one message a matchmaker broadcasts. `startAt` is on the matchmaker's clock. */
export interface MatchMessage {
  type: "match";
  id: string;
  /** The room everyone named moves to. */
  code: string;
  /** In host order: the matchmaker first, then by how long they waited. */
  members: { id: string; name: string }[];
  clipId: string;
  look: "blind" | "watch";
  startAt: number;
  /** How long the round runs from its start (results close this plus the room's grace period after it). */
  lengthMs: number;
  /** Saved round ids to replay as ghosts, the same on every device. */
  ghosts: string[];
  from: string;
  sentAt: number;
}

export const namesMe = (m: MatchMessage, me: string) => m.members.some((p) => p.id === me);

export function isMatchMessage(x: unknown): x is MatchMessage {
  const m = x as Partial<MatchMessage> | null;
  return !!m && m.type === "match" && typeof m.id === "string" && typeof m.code === "string" && Array.isArray(m.members)
    && m.members.every((p) => typeof p?.id === "string") && typeof m.clipId === "string" && typeof m.startAt === "number"
    && typeof m.lengthMs === "number" && Array.isArray(m.ghosts) && typeof m.from === "string" && typeof m.sentAt === "number";
}

/** What the matchmaker's screen decides for a match: the clip, the look, the ghosts and how soon it starts. */
export interface MatchPlan {
  code: string;
  clipId: string;
  look: "blind" | "watch";
  lengthMs: number;
  ghosts: string[];
  /** From the match message to the start, on the matchmaker's clock. */
  startInMs: number;
}

export interface LobbyTransport {
  /** Publish (or update) my presence. */
  track(p: LobbyPresence): void;
  /** Everyone present now, me included, each time it changes. */
  onPresence(fn: (list: LobbyPresence[]) => void): () => void;
  /** Broadcast to everyone else in the lobby. */
  send(msg: unknown): void;
  onMessage(fn: (msg: unknown) => void): () => void;
  close(): void;
}

/** A match this client accepted, with its start time worked out on this client's clock. */
export interface Accepted { match: MatchMessage; estimate: number }

interface LobbyOptions {
  transport: LobbyTransport;
  me: string;
  name: string;
  /** Called by the matchmaker once it decides to match; may be slow (it picks a clip and ghosts). */
  plan: (members: Waiter[]) => Promise<MatchPlan>;
  now?: () => number;
  size?: number;
  waitMs?: number;
  /** How often to look again; 0 for tests, which call tick() themselves. */
  tickMs?: number;
}

export class Lobby {
  readonly me: string;
  readonly name: string;
  readonly since: number;
  private readonly transport: LobbyTransport;
  private readonly plan: LobbyOptions["plan"];
  private readonly now: () => number;
  private readonly size: number;
  private readonly waitMs: number;
  private readonly tickMs: number;
  private present: LobbyPresence[] = [];
  private seen = new Map<string, { beat: number; at: number }>();
  private beat = 0;
  private lastRefresh = 0;
  private busy = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private offs: (() => void)[] = [];
  private waitingFns: ((list: Waiter[]) => void)[] = [];
  private matchFns: ((a: Accepted) => void)[] = [];
  /** The match this client took, or null while it is still waiting. */
  accepted: Accepted | null = null;
  closed = false;

  constructor(o: LobbyOptions) {
    this.transport = o.transport; this.me = o.me; this.name = o.name; this.plan = o.plan;
    this.now = o.now ?? (() => Date.now());
    this.size = o.size ?? MATCH_SIZE; this.waitMs = o.waitMs ?? MATCH_WAIT_MS; this.tickMs = o.tickMs ?? 500;
    this.since = this.now();
  }

  onWaiting(fn: (list: Waiter[]) => void) { this.waitingFns.push(fn); }
  onMatch(fn: (a: Accepted) => void) { this.matchFns.push(fn); }

  start() {
    this.offs.push(this.transport.onPresence((list) => this.#presence(list)));
    this.offs.push(this.transport.onMessage((m) => this.#message(m)));
    this.#publish();
    if (this.tickMs > 0) {
      this.timer = setInterval(() => this.tick(), this.tickMs);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /** Everyone waiting who is still refreshing their presence, longest waiting first. I am always in it. */
  waiting(): Waiter[] {
    const t = this.now();
    const fresh = this.present.filter((p) => p.id !== this.me && t - (this.seen.get(p.id)?.at ?? t) <= STALE_MS);
    return [{ id: this.me, name: this.name, since: this.since }, ...fresh.map(({ id, name, since }) => ({ id, name, since }))].sort(byWait);
  }

  /** Look again: refresh my presence when due, and act if I am the matchmaker and it is time. */
  tick() {
    if (this.closed || this.accepted) return;
    if (this.now() - this.lastRefresh >= REFRESH_MS) this.#publish();
    if (this.busy) return;
    const d = decide(this.waiting(), this.me, this.now(), { size: this.size, waitMs: this.waitMs });
    if (d.kind === "match") void this.#makeMatch(d.members);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const off of this.offs.splice(0)) off();
    this.transport.close();
  }

  #publish() {
    this.lastRefresh = this.now();
    this.transport.track({ id: this.me, name: this.name, since: this.since, beat: ++this.beat });
  }

  #presence(list: LobbyPresence[]) {
    const t = this.now();
    for (const p of list) {
      const was = this.seen.get(p.id);
      if (!was || was.beat !== p.beat) this.seen.set(p.id, { beat: p.beat, at: t });
    }
    this.present = list;
    const waiting = this.waiting();
    for (const fn of this.waitingFns) fn(waiting);
    this.tick();
  }

  #message(m: unknown) {
    if (this.closed || this.accepted || !isMatchMessage(m) || !namesMe(m, this.me)) return;
    // My guess for the start on my clock until the room measures the matchmaker's: late by one network trip.
    this.#accept({ match: m, estimate: m.startAt + (this.now() - m.sentAt) });
  }

  async #makeMatch(members: Waiter[]) {
    this.busy = true;
    let plan: MatchPlan;
    try { plan = await this.plan(members); }
    catch { this.busy = false; return; }
    this.busy = false;
    if (this.closed || this.accepted) return; // another match named me while I was choosing
    const now = this.now();
    const match: MatchMessage = {
      type: "match", id: `${this.me}-${now.toString(36)}`, code: plan.code,
      members: members.map(({ id, name }) => ({ id, name })), clipId: plan.clipId, look: plan.look,
      startAt: now + plan.startInMs, lengthMs: plan.lengthMs, ghosts: plan.ghosts, from: this.me, sentAt: now,
    };
    if (members.length > 1) this.transport.send(match);
    this.#accept({ match, estimate: match.startAt });
  }

  #accept(a: Accepted) {
    this.accepted = a;
    for (const fn of this.matchFns) fn(a);
    this.close();
  }
}
