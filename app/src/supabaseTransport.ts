// A room transport over Supabase Realtime "broadcast": different laptops in the same room code hear each other.
// Same three calls as the BroadcastChannel transport in rooms.mjs (send, onMessage, close).
// Needs the project URL and the PUBLISHABLE key (safe in a browser). Never use the secret key here.

import { createClient } from "@supabase/supabase-js";

export function supabaseTransport(url: string, publishableKey: string, code: string) {
  const client = createClient(url, publishableKey, { realtime: { params: { eventsPerSecond: 20 } } });
  const channel = client.channel("jester-room-" + code.toUpperCase(), { config: { broadcast: { self: false } } });
  const handlers: ((msg: unknown) => void)[] = [];
  const queue: unknown[] = [];
  let ready = false;

  const sendNow = (msg: unknown) => { void channel.send({ type: "broadcast", event: "msg", payload: msg }); };
  channel.on("broadcast", { event: "msg" }, ({ payload }) => { for (const h of handlers) h(payload); });
  channel.subscribe((status) => {
    if (status === "SUBSCRIBED") { ready = true; for (const m of queue.splice(0)) sendNow(m); }
  });

  return {
    // Messages sent before the connection is up wait in a queue, so join() can be called straight away.
    send(msg: unknown) { if (ready) sendNow(msg); else queue.push(msg); },
    onMessage(fn: (msg: unknown) => void) { handlers.push(fn); return () => { handlers.splice(handlers.indexOf(fn), 1); }; },
    close() { void client.removeChannel(channel); },
  };
}

/** The hosted transport if the project keys are set in app/.env.local, otherwise null (two tabs only). */
export function hostedTransportFromEnv(code: string) {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  return url && key ? supabaseTransport(url, key, code) : null;
}
