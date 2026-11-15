// The shared copy of the round log in Supabase, over its REST API with plain fetch.
// Settings: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY from the environment, else from app/.env.local.
// Their values are never printed.
//
// Table `rounds`: id text primary key, created_at timestamptz, scorer_version text, mode text, tag text,
// clip_key text, score int, record jsonb (the whole RoundRecord).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { looksLikeRecord, type RoundRecord } from "./record.ts";
import { REPO_DIR } from "./store.ts";

type Result<T> = { data: T; error: null } | { data: null; error: string };

interface Settings { url: string; key: string }

/** The live page publishes the same two public values (app/vite.config.ts reads them the same way). */
const LIVE_SETTINGS = "https://jester-pi.vercel.app/public-config.json";

export async function settings(): Promise<Result<Settings>> {
  let url = process.env.VITE_SUPABASE_URL;
  let key = process.env.VITE_SUPABASE_ANON_KEY;
  const file = join(REPO_DIR, "app", ".env.local");
  if ((!url || !key) && existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*(VITE_SUPABASE_URL|VITE_SUPABASE_ANON_KEY)\s*=\s*"?([^"\s]+)"?\s*$/.exec(line);
      if (m?.[1] === "VITE_SUPABASE_URL") url ??= m[2];
      if (m?.[1] === "VITE_SUPABASE_ANON_KEY") key ??= m[2];
    }
  }
  if (!url || !key) {
    try {
      const response = await fetch(LIVE_SETTINGS, { signal: AbortSignal.timeout(4000) });
      const found = (await response.json()) as { supabaseUrl?: string; supabasePublishableKey?: string };
      if (response.ok) { url ??= found.supabaseUrl; key ??= found.supabasePublishableKey; }
    } catch {
      // Offline: fall through to the message below.
    }
  }
  if (!url || !key) return { data: null, error: "No Supabase settings: no app/.env.local here and the live site did not answer. Check the connection." };
  return { data: { url: url.replace(/\/+$/, ""), key }, error: null };
}

const headers = (s: Settings) => ({ apikey: s.key, Authorization: `Bearer ${s.key}`, "Content-Type": "application/json" });

async function problem(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (response.status === 404 || /PGRST205|42P01|does not exist/.test(text)) return "The rounds table is not in Supabase yet.";
  if (/^\s*</.test(text)) return `Supabase's edge answered ${response.status} with a web page instead of data (usually the network). Try again.`;
  return `Supabase answered ${response.status}${text ? ": " + text.slice(0, 200) : ""}`;
}

/** Once seen: a duplicate upload got an HTML page from the edge, and the same request a minute later got 201. So try twice more. */
async function fetchPatiently(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, init);
    const flaky = response.status === 429 || response.status >= 500 || (response.headers.get("content-type") ?? "").includes("text/html");
    if (!flaky || attempt === 2) return response;
    await response.arrayBuffer().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
}

/** Every round in the shared table, oldest first. */
export async function fetchRounds(s: Settings): Promise<Result<RoundRecord[]>> {
  const out: RoundRecord[] = [];
  const page = 200;
  for (let offset = 0; ; offset += page) {
    let response: Response;
    try {
      response = await fetchPatiently(`${s.url}/rest/v1/rounds?select=record&order=created_at.asc&limit=${page}&offset=${offset}`, { headers: headers(s) });
    } catch {
      return { data: null, error: "Supabase did not answer. Check the connection." };
    }
    if (!response.ok) return { data: null, error: await problem(response) };
    const rows = (await response.json()) as { record: unknown }[];
    for (const row of rows) if (looksLikeRecord(row.record)) out.push(row.record);
    if (rows.length < page) return { data: out, error: null };
  }
}

/** Adds rounds to the shared table; ones already there are left as they are. */
export async function insertRounds(s: Settings, rounds: readonly RoundRecord[]): Promise<Result<number>> {
  let sent = 0;
  for (const r of rounds) {
    const row = { id: r.id, created_at: r.createdAt, scorer_version: r.scorerVersion, mode: r.mode, tag: r.tag, clip_key: r.clip.key, score: r.result.score, record: r };
    let response: Response;
    try {
      response = await fetchPatiently(`${s.url}/rest/v1/rounds?on_conflict=id`, {
        method: "POST",
        headers: { ...headers(s), Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify(row),
      });
    } catch {
      return { data: null, error: `Supabase did not answer after ${sent} rounds. Check the connection.` };
    }
    if (!response.ok) return { data: null, error: await problem(response) };
    sent++;
  }
  return { data: sent, error: null };
}
