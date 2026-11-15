// The video bank's index file, `index.json` (schema bank/1): reading it safely, and the small edits the
// bank lab makes to it. Pure and DOM free, so clip/test/bank.test.ts runs it under node.
//
// A bank is static files under one base address:
//   index.json
//   <id>/clip.mp4 (or clip.webm), <id>/poster.jpg, <id>/guides.json
// guides.json is the array `subjectGuides` returns for that clip (people first, then things).

export const BANK_SCHEMA = "bank/1";

/** One clip as written in index.json: the three file addresses are relative to the bank's base. */
export interface BankEntry {
  id: string;
  title: string;
  credit: string;
  /** Length of the stretch a round plays (the guides' shared range), in ms. */
  durationMs: number;
  people: number;
  things: number;
  video: string;
  poster: string;
  guides: string;
}

export interface BankIndex { schema: typeof BANK_SCHEMA; clips: BankEntry[] }

type Result<T> = { data: T; error: null } | { data: null; error: string };

/** A short lowercase slug: letters, digits and single dashes, at most 40 characters. */
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A file inside one clip's folder, never a full address or a step up. */
const FILE_IN_CLIP = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const NOT_A_BANK = "That is not a clip bank index.";

export function emptyBankIndex(): BankIndex {
  return { schema: BANK_SCHEMA, clips: [] };
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isCount = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0;

/** One entry, or null when any field is missing, the wrong type, or points outside its own folder. */
function readEntry(x: unknown): BankEntry | null {
  if (!isRecord(x)) return null;
  const { id, title, credit, durationMs, people, things, video, poster, guides } = x;
  if (typeof id !== "string" || id.length > 40 || !ID.test(id)) return null;
  if (typeof title !== "string" || title.trim() === "" || typeof credit !== "string") return null;
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  if (!isCount(people) || !isCount(things) || people + things === 0) return null;
  for (const path of [video, poster, guides]) {
    if (typeof path !== "string" || !FILE_IN_CLIP.test(path) || !path.startsWith(id + "/")) return null;
  }
  return {
    id, title, credit, durationMs, people, things,
    video: video as string, poster: poster as string, guides: guides as string,
  };
}

/**
 * Reads a parsed index.json. Entries that are malformed are left out rather than failing the whole
 * bank, and a repeated id keeps its first entry. Fails only when the file is not a bank/1 index at all.
 */
export function readBankIndex(json: unknown): Result<BankEntry[]> {
  if (!isRecord(json) || json.schema !== BANK_SCHEMA || !Array.isArray(json.clips)) return { data: null, error: NOT_A_BANK };
  const seen = new Set<string>();
  const clips: BankEntry[] = [];
  for (const raw of json.clips) {
    const entry = readEntry(raw);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    clips.push(entry);
  }
  return { data: clips, error: null };
}

/** A path from index.json as a full address under `base` (itself a full address, with or without a trailing slash). */
export function resolveBankPath(base: string, path: string): string {
  return new URL(path, base.endsWith("/") ? base : base + "/").href;
}

/** A slug for a new clip from its title, made unique against the ids already taken ("dog-fetch", "dog-fetch-2"). */
export function slugFor(title: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "") || "clip";
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!used.has(id)) return id;
  }
}

/** The index with `entry` added, or put in place of the entry with the same id. */
export function withClip(index: BankIndex, entry: BankEntry): BankIndex {
  const at = index.clips.findIndex((c) => c.id === entry.id);
  const clips = at < 0 ? [...index.clips, entry] : index.clips.map((c, i) => (i === at ? entry : c));
  return { schema: BANK_SCHEMA, clips };
}

/** The index without the clip `id`. */
export function withoutClip(index: BankIndex, id: string): BankIndex {
  return { schema: BANK_SCHEMA, clips: index.clips.filter((c) => c.id !== id) };
}

/** The entry for a new clip, with its files at the usual names inside `<id>/`. */
export function bankEntry(info: Omit<BankEntry, "video" | "poster" | "guides">, videoType: "mp4" | "webm"): BankEntry {
  return { ...info, video: `${info.id}/clip.${videoType}`, poster: `${info.id}/poster.jpg`, guides: `${info.id}/guides.json` };
}

/**
 * JSON for guides.json: every number that is not a whole number is kept to 4 decimals (a ten thousandth
 * of the frame), which roughly halves the file and changes nothing a player can see or the engine can score.
 */
export function guidesJson(guides: unknown): string {
  return JSON.stringify(guides, (_key, value) => (typeof value === "number" && !Number.isInteger(value) ? Math.round(value * 1e4) / 1e4 : value));
}
