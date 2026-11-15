// Transports for the open lobby (lobby.ts). Supabase Realtime: Presence for who is waiting and broadcast for the
// match message, on the public channel `jester-lobby` (no table and no policy). Uses the PUBLISHABLE key only.
// Without Supabase settings, a BroadcastChannel stand-in lets tabs of one browser find each other: it repeats
// each tab's presence every second and forgets a tab it has not heard from in three.

import { createClient } from "@supabase/supabase-js";
import { LOBBY_CHANNEL, type LobbyPresence, type LobbyTransport } from "./lobby.ts";

export function supabaseLobbyTransport(url: string, publishableKey: string, me: string): LobbyTransport {
  const client = createClient(url, publishableKey, { realtime: { params: { eventsPerSecond: 20 } } });
  const channel = client.channel(LOBBY_CHANNEL, { config: { broadcast: { self: false }, presence: { key: me } } });
  const presenceFns: ((list: LobbyPresence[]) => void)[] = [];
  const messageFns: ((msg: unknown) => void)[] = [];
  const queue: unknown[] = [];
  let meta: LobbyPresence | null = null;
  let ready = false;

  const list = () => Object.values(channel.presenceState<LobbyPresence>()).flat()
    .filter((p) => typeof p?.id === "string" && typeof p.since === "number")
    .map(({ id, name, since, beat }) => ({ id, name: String(name ?? ""), since, beat: Number(beat) || 0 }));
  channel.on("presence", { event: "sync" }, () => { const now = list(); for (const fn of presenceFns) fn(now); });
  channel.on("broadcast", { event: "msg" }, ({ payload }) => { for (const fn of messageFns) fn(payload); });
  channel.subscribe((status) => {
    if (status !== "SUBSCRIBED") return;
    ready = true;
    if (meta) void channel.track(meta);
    for (const m of queue.splice(0)) void channel.send({ type: "broadcast", event: "msg", payload: m });
  });

  return {
    track(p) { meta = p; if (ready) void channel.track(p); },
    onPresence(fn) { presenceFns.push(fn); return () => { presenceFns.splice(presenceFns.indexOf(fn), 1); }; },
    send(msg) { if (ready) void channel.send({ type: "broadcast", event: "msg", payload: msg }); else queue.push(msg); },
    onMessage(fn) { messageFns.push(fn); return () => { messageFns.splice(messageFns.indexOf(fn), 1); }; },
    close() { void channel.untrack().catch(() => undefined).finally(() => void client.removeChannel(channel)); },
  };
}

/** Tabs of one browser only, for a run with no Supabase settings. */
export function broadcastLobbyTransport(me: string): LobbyTransport {
  const channel = new BroadcastChannel(LOBBY_CHANNEL);
  const others = new Map<string, { p: LobbyPresence; at: number }>();
  const presenceFns: ((list: LobbyPresence[]) => void)[] = [];
  const messageFns: ((msg: unknown) => void)[] = [];
  let meta: LobbyPresence | null = null;
  const tell = () => { const now = [...(meta ? [meta] : []), ...[...others.values()].map((o) => o.p)]; for (const fn of presenceFns) fn(now); };
  channel.onmessage = (e: MessageEvent) => {
    const d = e.data as { kind?: string; p?: LobbyPresence; id?: string; msg?: unknown };
    if (d.kind === "here" && d.p && d.p.id !== me) { others.set(d.p.id, { p: d.p, at: Date.now() }); tell(); }
    else if (d.kind === "gone" && d.id) { others.delete(d.id); tell(); }
    else if (d.kind === "msg") for (const fn of messageFns) fn(d.msg);
  };
  const timer = setInterval(() => {
    if (meta) channel.postMessage({ kind: "here", p: meta });
    const before = others.size;
    for (const [id, o] of others) if (Date.now() - o.at > 3000) others.delete(id);
    if (others.size !== before) tell();
  }, 1000);
  return {
    track(p) { meta = p; channel.postMessage({ kind: "here", p }); tell(); },
    onPresence(fn) { presenceFns.push(fn); return () => { presenceFns.splice(presenceFns.indexOf(fn), 1); }; },
    send(msg) { channel.postMessage({ kind: "msg", msg }); },
    onMessage(fn) { messageFns.push(fn); return () => { messageFns.splice(messageFns.indexOf(fn), 1); }; },
    close() { clearInterval(timer); channel.postMessage({ kind: "gone", id: me }); channel.close(); },
  };
}

/** The hosted lobby when the project's public settings are there, else the one-browser stand-in. */
export function lobbyTransport(me: string): { transport: LobbyTransport; online: boolean } {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  return url && key ? { transport: supabaseLobbyTransport(url, key, me), online: true } : { transport: broadcastLobbyTransport(me), online: false };
}
