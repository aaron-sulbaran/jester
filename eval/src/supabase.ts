// The shared copy of the round log in Supabase, over its REST API with plain fetch.
// Settings: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY from the environment, else from app/.env.local.
// Their values are never printed.
//
// Table `rounds`: id text primary key, created_at timestamptz, scorer_version text, mode text, tag text,
// clip_key text, score int, record jsonb (the whole RoundRecord).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROUND_ID, looksLikeRecord, rowOf, type RoundRecord } from "./record.ts";
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

async function getJson<T>(s: Settings, query: string): Promise<Result<T>> {
  let response: Response;
  try {
    response = await fetchPatiently(`${s.url}/rest/v1/rounds?${query}`, { headers: headers(s) });
  } catch {
    return { data: null, error: "Supabase did not answer. Check the connection." };
  }
  if (!response.ok) return { data: null, error: await problem(response) };
  return { data: (await response.json()) as T, error: null };
}

/** Every round id in the shared table, without the big record column (the page's key has a 3 s statement limit). */
export async function listRoundIds(s: Settings): Promise<Result<string[]>> {
  const ids: string[] = [];
  const page = 1000;
  for (let offset = 0; ; offset += page) {
    const rows = await getJson<{ id: string }[]>(s, `select=id&order=id.asc&limit=${page}&offset=${offset}`);
    if (rows.error !== null) return rows;
    ids.push(...rows.data.map((r) => r.id));
    if (rows.data.length < page) return { data: ids, error: null };
  }
}

/** The records for these ids, ten per request (a record is about 0.5 MB). Calls `onRound` as each arrives. */
export async function fetchRecords(s: Settings, ids: readonly string[], onRound: (r: RoundRecord) => void): Promise<Result<number>> {
  let got = 0;
  for (let i = 0; i < ids.length; i += 10) {
    // Round ids are only letters, digits and dashes (checked by the table), so they are safe in the address.
    const chunk = ids.slice(i, i + 10).filter((id) => ROUND_ID.test(id));
    const rows = await getJson<{ record: unknown }[]>(s, `select=record&id=in.(${chunk.join(",")})&order=id.asc`);
    if (rows.error !== null) return { data: null, error: `${rows.error} (after ${got} rounds)` };
    for (const row of rows.data) if (looksLikeRecord(row.record)) { onRound(row.record); got++; }
  }
  return { data: got, error: null };
}

/** Adds rounds to the shared table; ones already there are left as they are. */
export async function insertRounds(s: Settings, rounds: readonly RoundRecord[]): Promise<Result<number>> {
  let sent = 0;
  for (const r of rounds) {
    let response: Response;
    try {
      response = await fetchPatiently(`${s.url}/rest/v1/rounds?on_conflict=id`, {
        method: "POST",
        headers: { ...headers(s), Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify(rowOf(r)),
      });
    } catch {
      return { data: null, error: `Supabase did not answer after ${sent} rounds. Check the connection.` };
    }
    if (!response.ok) return { data: null, error: await problem(response) };
    sent++;
  }
  return { data: sent, error: null };
}
