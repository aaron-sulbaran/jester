// Dev server only: one case file per clip the Chamberlain judges, for its eval (eval/src/chamberlain.ts).
// The judge route saves the exact input it passed to reviewSubmission and the decision that came back; the
// decide route later adds the final outcome (approved or rejected, and by whom). Replaying the input through a
// changed prompt or model then shows whether the Chamberlain still agrees with what people decided.
//
// The files hold real frames and real titles, so they live OUTSIDE every repo: in `chamberlain-cases/` beside
// the env file JESTER_REVIEW_ENV points at (jester-deploy/), readable by this user only. Nothing is saved when
// that folder is inside a git checkout (an env file placed in a repo, or in app/public/) or inside a bank folder
// (the given one, or any folder holding a bank index.json), so a case can never be committed, published or
// served. Never copy them into a repo. The dev server saves cases only when the env file has
// JESTER_REVIEW_CAPTURE=1.

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import type { Decision, ReviewInput, Verdict } from "./review-agent.ts";

type Result<T> = { data: T; error: null } | { data: null; error: string };

export interface CaseOutcome {
  status: "approved" | "rejected";
  by: "agent" | "aaron" | "check";
  /** The name the clip went into the bank under (approved), or the name it was sent with (rejected). */
  title: string | null;
  reason: string;
  bankId?: string;
  at: string;
}

export interface ChamberlainCase {
  schema: 1;
  /** The submission's row id, or "x-" and a hash of the input when the desk sent none. */
  id: string;
  source: "desk";
  capturedAt: string;
  videoPath: string | null;
  model: string;
  /** promptVersion() of review-agent.ts when the case was judged. */
  prompt: string;
  /** Exactly what reviewSubmission read: the submitter's title and credit, the analysis facts, the frames. */
  input: ReviewInput;
  /** What the Chamberlain decided then, or null when the review failed (see `error`). */
  decision: Decision | null;
  error?: string;
  /** The desk's final decision, added by the decide route. Null while the clip is pending. */
  outcome: CaseOutcome | null;
  /** Optional hand label, written by a person: the verdict this case should get, overriding the outcome. */
  label?: { want: Verdict; alsoOk?: Verdict[]; note?: string };
}

const SAFE_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|x-[0-9a-f]{16})$/;

/** The cases folder for an env file: `chamberlain-cases/` beside it. */
export function casesDirFor(envFile: string | undefined): string | undefined {
  return envFile ? join(dirname(envFile), "chamberlain-cases") : undefined;
}

/** A stable id for an input that came without a submission id. */
export function inputId(input: ReviewInput): string {
  return `x-${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 16)}`;
}

const pathOf = (dir: string, id: string) => join(dir, `${id}.json`);

/** The git checkout `dir` would sit in (after resolving symlinks), or null when it is outside every checkout. */
export function checkoutAround(dir: string): string | null {
  let at = resolve(dir);
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  try { at = realpathSync(at); } catch { /* keep the resolved path */ }
  for (;;) {
    if (existsSync(join(at, ".git"))) return at;
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/** `dir` with symlinks resolved as far as it exists. */
function real(dir: string): string {
  let at = resolve(dir), rest = "";
  while (!existsSync(at) && dirname(at) !== at) { rest = join(at.slice(dirname(at).length + 1), rest); at = dirname(at); }
  try { at = realpathSync(at); } catch { /* keep the resolved path */ }
  return rest ? join(at, rest) : at;
}

const within = (dir: string, folder: string) => {
  const r = relative(real(folder), real(dir));
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};

/** The bank folder `dir` would sit in: one holding a bank index.json at or above it, or null. */
export function bankAround(dir: string): string | null {
  for (let at = real(dir); ; at = dirname(at)) {
    try {
      const index = JSON.parse(readFileSync(join(at, "index.json"), "utf8")) as { schema?: unknown; clips?: unknown };
      if (index.schema === "bank/1" && Array.isArray(index.clips)) return at;
    } catch { /* no index here */ }
    if (dirname(at) === at) return null;
  }
}

/** Why `dir` may not hold cases, or null when it may. `bankDir` is the bank folder the dev server serves, if any. */
function refusal(dir: string, bankDir?: string): string | null {
  const repo = checkoutAround(dir);
  if (repo) return `The cases folder ${dir} is inside the git checkout ${repo}, so no case was saved. Keep JESTER_REVIEW_ENV outside every repo.`;
  const bank = bankDir && within(dir, bankDir) ? bankDir : bankAround(dir);
  return bank ? `The cases folder ${dir} is inside the bank folder ${bank}, which is published, so no case was saved. Keep JESTER_REVIEW_ENV outside the bank.` : null;
}

function readCase(path: string): ChamberlainCase | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ChamberlainCase;
  } catch {
    return null;
  }
}

/**
 * Writes through a fresh temporary file (created exclusively, never an existing file or link), so a crash never
 * leaves half a case and two writers never share one. Owner read and write only.
 */
function writeCase(dir: string, id: string, c: ChamberlainCase) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = pathOf(dir, id);
  const tmp = `${path}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ ...c, id }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Saves one judged clip. Judging the same submission again replaces its input and decision and keeps any
 * outcome or hand label already there.
 */
export function saveJudged(dir: string | undefined, j: {
  id: string | null; videoPath: string | null; model: string; prompt: string; input: ReviewInput; decision: Decision | null; error?: string;
}, bankDir?: string): Result<string> {
  if (!dir) return { data: null, error: "No cases folder: the dev server was started without JESTER_REVIEW_ENV." };
  const id = j.id ?? inputId(j.input);
  if (!SAFE_ID.test(id)) return { data: null, error: "That is not a submission id." };
  const refused = refusal(dir, bankDir);
  if (refused) return { data: null, error: refused };
  try {
    const before = readCase(pathOf(dir, id));
    writeCase(dir, id, {
      schema: 1, id, source: "desk", capturedAt: new Date().toISOString(), videoPath: j.videoPath,
      model: j.model, prompt: j.prompt, input: j.input, decision: j.decision,
      ...(j.error ? { error: j.error } : {}),
      outcome: before?.outcome ?? null,
      ...(before?.label ? { label: before.label } : {}),
    });
    return { data: pathOf(dir, id), error: null };
  } catch (err) {
    return { data: null, error: `The case did not save: ${(err as Error).message}` };
  }
}

/** Adds the final outcome to a judged clip's case. `data` is false when the clip was never judged (no case). */
export function saveOutcome(dir: string | undefined, id: string, outcome: Omit<CaseOutcome, "at">, bankDir?: string): Result<boolean> {
  if (!dir || !SAFE_ID.test(id)) return { data: false, error: null };
  const refused = refusal(dir, bankDir);
  if (refused) return { data: null, error: refused };
  const path = pathOf(dir, id);
  if (!existsSync(path)) return { data: false, error: null };
  const c = readCase(path);
  // The file is trusted for its contents only: it must be a case for this id, and it is written back under this id.
  if (!c || c.schema !== 1 || c.id !== id || typeof c.input !== "object") return { data: null, error: "The case file is not a case for this submission, so its outcome was not saved." };
  try {
    writeCase(dir, id, { ...c, outcome: { ...outcome, at: new Date().toISOString() } });
    return { data: true, error: null };
  } catch (err) {
    return { data: null, error: `The outcome did not save: ${(err as Error).message}` };
  }
}
