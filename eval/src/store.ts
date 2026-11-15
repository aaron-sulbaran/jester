// Where rounds live on disk.
//   eval/data/rounds/<id>.json   every round the dev server saved or `npm run pull` fetched (git-ignored)
//   eval/cases/<id>.json.gz      frozen test cases (committed), the reference moved out to refs/
//   eval/cases/refs/<key>.json.gz one copy of each reference, shared by every case that played it

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { looksLikeRecord, type AnyPackedBoxes, type AnyPackedPose, type RoundRecord } from "./record.ts";

export const EVAL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_DIR = join(EVAL_DIR, "..");
export const DATA_DIR = join(EVAL_DIR, "data", "rounds");
export const CASES_DIR = join(EVAL_DIR, "cases");
export const REFS_DIR = join(CASES_DIR, "refs");
export const BASELINE_FILE = join(EVAL_DIR, "baseline.json");
export const REPORT_FILE = join(EVAL_DIR, "report.md");

type Result<T> = { data: T; error: null } | { data: null; error: string };

const readJson = (file: string): unknown => {
  const raw = readFileSync(file);
  return JSON.parse((file.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8"));
};

const byId = (a: RoundRecord, b: RoundRecord) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Every round in eval/data/rounds. Files that are not round records are skipped and named. */
export function loadDataRounds({ withSelftest = false } = {}): { rounds: RoundRecord[]; skipped: string[] } {
  if (!existsSync(DATA_DIR)) return { rounds: [], skipped: [] };
  const rounds: RoundRecord[] = [];
  const skipped: string[] = [];
  for (const name of readdirSync(DATA_DIR).filter((n) => n.endsWith(".json")).sort()) {
    try {
      const r = readJson(join(DATA_DIR, name));
      // "selftest" rounds are synthetic ones made to check the plumbing (one sits in the shared table); never judged.
      if (looksLikeRecord(r)) { if (withSelftest || r.mode !== "selftest") rounds.push(r); } else skipped.push(name);
    } catch {
      skipped.push(name);
    }
  }
  return { rounds: rounds.sort(byId), skipped };
}

/** Every frozen case, with its reference put back. */
export function loadCases(): { rounds: RoundRecord[]; skipped: string[] } {
  if (!existsSync(CASES_DIR)) return { rounds: [], skipped: [] };
  const rounds: RoundRecord[] = [];
  const skipped: string[] = [];
  for (const name of readdirSync(CASES_DIR).filter((n) => n.endsWith(".json.gz")).sort()) {
    try {
      const stored = readJson(join(CASES_DIR, name)) as Omit<RoundRecord, "reference"> & { reference: { ref: string } };
      const reference = readJson(join(REFS_DIR, stored.reference.ref + ".json.gz")) as AnyPackedPose | AnyPackedBoxes;
      const r = { ...stored, reference };
      if (looksLikeRecord(r)) rounds.push(r); else skipped.push(name);
    } catch {
      skipped.push(name);
    }
  }
  return { rounds: rounds.sort(byId), skipped };
}

/** Ids of the rounds already in eval/data/rounds, from the file names. */
export function localRoundIds(): Set<string> {
  if (!existsSync(DATA_DIR)) return new Set();
  return new Set(readdirSync(DATA_DIR).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -".json".length)));
}

export function isFrozen(id: string): boolean {
  return existsSync(join(CASES_DIR, id + ".json.gz"));
}

/** Copies one round into eval/cases. Pose data only ever reaches this point. */
export function freezeRound(r: RoundRecord): Result<{ file: string }> {
  if (isFrozen(r.id)) return { data: null, error: `${r.id} is already a case` };
  mkdirSync(REFS_DIR, { recursive: true });
  const refFile = join(REFS_DIR, r.clip.key + ".json.gz");
  if (!existsSync(refFile)) writeFileSync(refFile, gzipSync(JSON.stringify(r.reference)));
  const file = join(CASES_DIR, r.id + ".json.gz");
  writeFileSync(file, gzipSync(JSON.stringify({ ...r, reference: { ref: r.clip.key } })));
  return { data: { file }, error: null };
}

export function saveDataRound(r: RoundRecord): boolean {
  mkdirSync(DATA_DIR, { recursive: true });
  const file = join(DATA_DIR, r.id + ".json");
  if (existsSync(file)) return false;
  writeFileSync(file, JSON.stringify(r));
  return true;
}

/** The same hash the dev server stamps on each round, so the eval can tell whether the engine code changed since. */
export function currentEngineHash(): string {
  const dir = join(REPO_DIR, "engine", "src");
  const hash = createHash("sha1");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts")).sort()) hash.update(f).update(readFileSync(join(dir, f)));
  return hash.digest("hex").slice(0, 12);
}
