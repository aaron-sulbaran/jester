// Dev server only: one case file per clip the Chamberlain judges, for its eval (eval/src/chamberlain.ts).
// The judge route saves the exact input it passed to reviewSubmission and the decision that came back; the
// decide route later adds the final outcome (approved or rejected, and by whom). Replaying the input through a
// changed prompt or model then shows whether the Chamberlain still agrees with what people decided.
//
// The files hold real frames and real titles, so they live OUTSIDE every repo: in `chamberlain-cases/` beside
// the env file JESTER_REVIEW_ENV points at (jester-deploy/), readable by this user only. Never commit them.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

function readCase(path: string): ChamberlainCase | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ChamberlainCase;
  } catch {
    return null;
  }
}

/** Writes through a temporary file, so a crash never leaves half a case. Owner read and write only. */
function writeCase(dir: string, c: ChamberlainCase) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = pathOf(dir, c.id);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Saves one judged clip. Judging the same submission again replaces its input and decision and keeps any
 * outcome or hand label already there.
 */
export function saveJudged(dir: string | undefined, j: {
  id: string | null; videoPath: string | null; model: string; prompt: string; input: ReviewInput; decision: Decision | null; error?: string;
}): Result<string> {
  if (!dir) return { data: null, error: "No cases folder: the dev server was started without JESTER_REVIEW_ENV." };
  const id = j.id ?? inputId(j.input);
  if (!SAFE_ID.test(id)) return { data: null, error: "That is not a submission id." };
  try {
    const before = readCase(pathOf(dir, id));
    writeCase(dir, {
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
export function saveOutcome(dir: string | undefined, id: string, outcome: Omit<CaseOutcome, "at">): Result<boolean> {
  if (!dir || !SAFE_ID.test(id)) return { data: false, error: null };
  const path = pathOf(dir, id);
  if (!existsSync(path)) return { data: false, error: null };
  const c = readCase(path);
  if (!c) return { data: null, error: "The case file is not readable JSON, so its outcome was not saved." };
  try {
    writeCase(dir, { ...c, outcome: { ...outcome, at: new Date().toISOString() } });
    return { data: true, error: null };
  } catch (err) {
    return { data: null, error: `The outcome did not save: ${(err as Error).message}` };
  }
}
