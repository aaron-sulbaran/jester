// Where ghosts come from: the shared Supabase table `rounds` (rounds saved by the live site), read with the page's
// publishable key, and on a dev server also this laptop's own round log (eval/data/rounds, served by
// app/round-log-plugin.ts). Only the columns a ghost needs are fetched, never the clip's own reference poses.
// Every call answers { data, error }; a failed source just means fewer ghosts.

import { ROUND_ID } from "../../eval/src/record.ts";
import { rescore, type GhostRecord, type GhostRow } from "./ghosts.ts";

type Result<T> = { data: T; error: null } | { data: null; error: string };

const DEV = import.meta.env.DEV;
const URL_BASE = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/+$/, "");
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const LOCAL = "/__jester/rounds";
const NEWEST = 300;

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<Result<T>> {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
    if (!response.ok) return { data: null, error: `answered ${response.status}` };
    return { data: (await response.json()) as T, error: null };
  } catch {
    return { data: null, error: "did not answer" };
  }
}

const supabase = <T>(query: string) => (URL_BASE && KEY
  ? getJson<T>(`${URL_BASE}/rest/v1/rounds?${query}`, { apikey: KEY, Authorization: `Bearer ${KEY}` })
  : Promise.resolve<Result<T>>({ data: null, error: "no Supabase settings" }));

/**
 * The newest saved rounds that could be ghosts on any clip, light rows only. Untagged rounds with a score and a
 * bank clip; ghosts.ts makes the final choice per clip.
 */
export async function ghostRows(): Promise<Result<GhostRow[]>> {
  const query = "select=id,score,tag,bankId:record->clip->>bankId,channel:record->>channel"
    + `&tag=is.null&score=not.is.null&record->clip->>bankId=not.is.null&order=id.desc&limit=${NEWEST}`;
  const [shared, local] = await Promise.all([supabase<GhostRow[]>(query), DEV ? getJson<GhostRow[]>(LOCAL) : Promise.resolve(null)]);
  const rows = [...(local?.data ?? []), ...(shared.data ?? [])];
  if (rows.length === 0 && shared.error !== null && !local?.data) return { data: null, error: `Saved rounds did not load (Supabase ${shared.error}).` };
  return { data: rows, error: null };
}

/**
 * The saved rounds behind these ghost ids, each scored again by this build's engine (ghosts.ts rescore; the saved
 * result is kept when that is not possible). Unknown ids are left out.
 */
export async function ghostRecords(ids: readonly string[]): Promise<Result<GhostRecord[]>> {
  // Round ids are only letters, digits and dashes (checked by the table), so they are safe in the address.
  const wanted = ids.filter((id) => ROUND_ID.test(id));
  if (wanted.length === 0) return { data: [], error: null };
  const found = new Map<string, GhostRecord>();
  if (DEV) {
    const local = await getJson<GhostRecord[]>(`${LOCAL}?ids=${wanted.join(",")}`);
    for (const r of local.data ?? []) found.set(r.id, r);
  }
  const missing = wanted.filter((id) => !found.has(id));
  let error: string | null = null;
  if (missing.length) {
    const shared = await supabase<GhostRecord[]>(`select=id,score,player:record->player,result:record->result,reference:record->reference,options:record->options&id=in.(${missing.join(",")})`);
    for (const r of shared.data ?? []) found.set(r.id, r);
    error = shared.error;
  }
  const records = wanted.map((id) => found.get(id)).filter((r): r is GhostRecord => !!r && typeof r.score === "number" && !!r.player?.t).map(rescore);
  if (records.length === 0 && error !== null) return { data: null, error: `The ghosts did not load (Supabase ${error}).` };
  return { data: records, error: null };
}
