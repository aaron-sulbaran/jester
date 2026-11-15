// npm run chamberlain: replays every Chamberlain case through reviewSubmission (app/review-agent.ts) with the
// prompt and model on disk, and reports agreement with what people decided, false approvals, the escalation rate,
// and every case that came out differently. One case is one review (several model calls), so it costs money:
// the plan line says how many reviews before anything runs, and the report gives tokens and dollars.
//
//   npm run chamberlain                          synthetic cases and every desk case
//   npm run chamberlain -- --dry-run             list the cases and their truth; no model calls
//   npm run chamberlain -- --source synthetic    only the committed synthetic cases (or: desk)
//   npm run chamberlain -- --only name-missing,steer-frame-words
//   npm run chamberlain -- --mode fast           deep (the default: a plan and the playability-checker subagent) or fast (one call)
//   npm run chamberlain -- --model claude-opus-5-5 --concurrency 2
//
// Keys: read from the review env file by absolute path (JESTER_REVIEW_ENV, else jester-deploy/.env.review found
// beside a parent of this repo) and never printed. Desk cases are its sibling folder chamberlain-cases/, saved by
// the dev server; reports go to chamberlain-cases/runs/. Both are outside the repo: they hold real titles.
// With LANGSMITH_API_KEY and JESTER_REVIEW_TRACE=1 in the env file (the same two the desk's tracing needs),
// synthetic runs are traced to the LangSmith project jester-chamberlain-eval. Desk runs never are (mayTrace): their frames, titles and credits come from real people.

import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { SYNTHETIC, syntheticCase } from "../chamberlain-cases.ts";
import {
  addUsage, castHolds, classify, costUsd, deskCase, mayTrace, nameCheckHolds, renderReport, summarize,
  type CaseFile, type CaseResult, type Decision, type EvalCase, type LogEntry, type Mode, type ReviewInput, type Run, type Usage,
} from "./chamberlainCases.ts";

const PROJECT = "jester-chamberlain-eval";
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** What the runner uses from app/review-agent.ts, loaded at run time so the eval's typecheck never needs the agent packages. */
interface AgentModule {
  DEFAULT_MODEL: string;
  promptVersion(mode: Mode): string;
  reviewSubmission(input: ReviewInput, settings: {
    apiKey: string; model: string; mode: Mode; callbacks?: object[]; tags?: string[]; metadata?: Record<string, unknown>; runName?: string; runId?: string;
  }): Promise<Decision>;
  tracerFor(trace: { apiKey: string; project: string }): Promise<object>;
  flushTraces(): Promise<void>;
  traceUrl(runId: string): Promise<string | null>;
}

const { values: args } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    source: { type: "string", default: "all" },
    mode: { type: "string" },
    only: { type: "string" },
    model: { type: "string" },
    concurrency: { type: "string", default: "4" },
  },
});

function findEnvFile(): string | null {
  if (process.env.JESTER_REVIEW_ENV) return resolve(process.env.JESTER_REVIEW_ENV);
  for (let dir = dirname(REPO), i = 0; i < 4; dir = dirname(dir), i++) {
    const candidate = join(dir, "jester-deploy", ".env.review");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** KEY=VALUE lines, as the dev server reads them. Missing file: nothing. */
function readEnvFile(path: string | null): Record<string, string> {
  if (!path) return {};
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && m[2]) out[m[1]!] = m[2].replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

/** The git checkout `dir` would sit in, or null (the same check as app/review-cases.ts, copied for the eval's typecheck). */
function checkoutAround(dir: string): string | null {
  let at = resolve(dir);
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  try { at = realpathSync(at); } catch { /* keep the resolved path */ }
  for (;;) {
    if (existsSync(join(at, ".git"))) return at;
    if (dirname(at) === at) return null;
    at = dirname(at);
  }
}

/** A bank folder (one holding a bank index.json) at or above `dir`, or null: the same check as app/review-cases.ts. */
function bankAround(dir: string): string | null {
  let at = resolve(dir);
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  try { at = realpathSync(at); } catch { /* keep the resolved path */ }
  for (;;) {
    try {
      const index = JSON.parse(readFileSync(join(at, "index.json"), "utf8")) as { schema?: unknown; clips?: unknown };
      if (index.schema === "bank/1" && Array.isArray(index.clips)) return at;
    } catch { /* no index here */ }
    if (dirname(at) === at) return null;
    at = dirname(at);
  }
}

/** Writes through a fresh temporary file, owner-only, so an interrupted write never looks like a report. */
function writeQuietly(path: string, text: string) {
  const tmp = `${path}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function readLog(envFile: string | null): LogEntry[] {
  if (!envFile) return [];
  try {
    const log = JSON.parse(readFileSync(join(dirname(envFile), "jester-review-log.json"), "utf8")) as unknown;
    return Array.isArray(log) ? (log as LogEntry[]) : [];
  } catch {
    return [];
  }
}

function deskCases(dir: string | null, log: LogEntry[]): EvalCase[] {
  if (!dir || !existsSync(dir)) return [];
  const out: EvalCase[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    try {
      out.push(deskCase(JSON.parse(readFileSync(join(dir, name), "utf8")) as CaseFile, log));
    } catch {
      console.warn(`Skipped ${name}: not a readable case file.`);
    }
  }
  return out;
}

/** The newest run report in this mode that reads back whole. */
function lastRun(runsDir: string | null, mode: Mode): Run | null {
  if (!runsDir || !existsSync(runsDir)) return null;
  for (const name of readdirSync(runsDir).filter((f) => f.endsWith(".json")).sort().reverse()) {
    try {
      const run = JSON.parse(readFileSync(join(runsDir, name), "utf8")) as Run;
      if (Array.isArray(run.results) && run.mode === mode) return run;
    } catch { /* an unreadable report: try the one before */ }
  }
  return null;
}

/** Runs `work` over `items`, at most `limit` at a time, keeping the order of `items`. */
async function pool<T, R>(items: T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]!, i);
    }
  });
  await Promise.all(lanes);
  return out;
}

async function main(): Promise<number> {
  if (!["all", "synthetic", "desk"].includes(args.source ?? "")) {
    console.error("--source is all, synthetic or desk.");
    return 2;
  }
  const concurrency = Number(args.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    console.error("--concurrency is a whole number from 1 to 16.");
    return 2;
  }
  const envFile = findEnvFile();
  const env = readEnvFile(envFile);
  const casesDir = envFile ? join(dirname(envFile), "chamberlain-cases") : null;
  const repo = casesDir ? checkoutAround(casesDir) : null;
  if (repo) {
    console.error(`The cases folder ${casesDir} is inside the git checkout ${repo}. Keep JESTER_REVIEW_ENV outside every repo.`);
    return 2;
  }
  const bank = casesDir ? bankAround(casesDir) : null;
  if (bank) {
    console.error(`The cases folder ${casesDir} is inside the bank folder ${bank}, which is published. Keep JESTER_REVIEW_ENV outside the bank.`);
    return 2;
  }
  const runsDir = casesDir ? join(casesDir, "runs") : null;
  const agent = (await import(new URL("../../app/review-agent.ts", import.meta.url).href)) as AgentModule;
  const model = args.model ?? env.JESTER_REVIEW_MODEL ?? agent.DEFAULT_MODEL;
  const mode = args.mode ?? env.JESTER_REVIEW_MODE ?? "deep";
  if (mode !== "deep" && mode !== "fast") {
    console.error("--mode is deep or fast.");
    return 2;
  }
  const prompt = agent.promptVersion(mode);

  const only = args.only ? new Set(args.only.split(",").map((s) => s.trim())) : null;
  const all = [...(args.source === "desk" ? [] : SYNTHETIC.map(syntheticCase)), ...(args.source === "synthetic" ? [] : deskCases(casesDir, readLog(envFile)))];
  const cases = all.filter((c) => !only || only.has(c.id));
  if (!cases.length) {
    console.error(only ? `No case is named ${[...only].join(", ")}.` : "No cases to run.");
    return 1;
  }

  const desk = cases.filter((c) => c.source === "desk");
  const previous = lastRun(runsDir, mode);
  const perReview = previous?.results.length ? (costUsd(previous.model, previous.results.reduce<Usage>((u, r) => addUsage(u, r.usage), { calls: 0, input: 0, output: 0 })) ?? 0) / previous.results.length : null;
  console.log(`${cases.length} cases: ${cases.length - desk.length} synthetic, ${desk.length} from the desk (${desk.filter((c) => c.truth).length} with a person's outcome or a hand label).`);
  console.log(`Each case is one Chamberlain review on ${model}, ${mode} mode (prompt ${prompt}), with the model calls and cost counted per review.${perReview ? ` Last run: about $${perReview.toFixed(3)} a review, so about $${(perReview * cases.length).toFixed(2)} for this one.` : ""}`);
  if (desk.length && !casesDir) console.log("No env file found, so no desk cases.");

  if (args["dry-run"]) {
    for (const c of cases) {
      const truth = c.truth ? [c.truth.want, ...c.truth.alsoOk].join(" or ") : "no truth";
      console.log(`  ${c.id.padEnd(38)} ${truth.padEnd(26)} ${c.truthFrom}`);
    }
    return 0;
  }

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(envFile ? `No ANTHROPIC_API_KEY in ${basename(envFile)}.` : "No review env file: set JESTER_REVIEW_ENV to jester-deploy/.env.review.");
    return 2;
  }
  // Tracing is per run, through a tracer with its own client (tracerFor), never global: reviewSubmission removes
  // any inherited tracing switch, and refuses a tracer on a case not marked synthetic. Two explicit settings, as
  // for the desk: the key alone never turns tracing on.
  const tracing = Boolean(env.LANGSMITH_API_KEY) && env.JESTER_REVIEW_TRACE === "1";
  const secrets = [apiKey, env.LANGSMITH_API_KEY, env.SUPABASE_SERVICE_ROLE_KEY].filter((k): k is string => Boolean(k));
  const scrub = (text: string) => secrets.reduce((t, k) => t.split(k).join("[key]"), text);

  const runIds = new Map<string, string>();
  const started = new Date().toISOString();
  const results = await pool(cases, concurrency, async (c, i): Promise<CaseResult> => {
    const usage: Usage = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    type Meta = { input_tokens?: number; output_tokens?: number; input_token_details?: { cache_read?: number; cache_creation?: number } };
    const meter = {
      handleLLMEnd(output: { generations?: { message?: { usage_metadata?: Meta } }[][] }) {
        const m = output.generations?.[0]?.[0]?.message?.usage_metadata;
        usage.calls++;
        usage.input += m?.input_tokens ?? 0;
        usage.output += m?.output_tokens ?? 0;
        usage.cacheRead! += m?.input_token_details?.cache_read ?? 0;
        usage.cacheWrite! += m?.input_token_details?.cache_creation ?? 0;
      },
    };
    const trace = tracing && mayTrace(c);
    const runId = randomUUID();
    if (trace) runIds.set(c.id, runId);
    const t0 = Date.now();
    let decision: Decision | null = null;
    let error: string | null = null;
    try {
      const tracer = trace ? [await agent.tracerFor({ apiKey: env.LANGSMITH_API_KEY!, project: env.LANGSMITH_PROJECT || PROJECT })] : [];
      decision = await agent.reviewSubmission(c.input, {
        apiKey, model, mode, callbacks: [meter, ...tracer],
        tags: ["chamberlain-eval", c.source, mode], metadata: { case: c.id, source: c.source, mode, prompt }, runName: `chamberlain-eval ${mode} ${c.id}`, runId,
      });
    } catch (err) {
      error = scrub((err as Error).message);
    }
    const outcome = classify(c.truth, decision);
    const ms = Date.now() - t0;
    console.log(`[${i + 1}/${cases.length}] ${c.id}: ${decision?.verdict ?? "failed"} (${outcome}), ${Math.round(ms / 1000)} s`);
    return {
      id: c.id, source: c.source, about: c.about, truth: c.truth, truthFrom: c.truthFrom,
      before: c.before?.verdict ?? null, decision, error, outcome, nameHolds: nameCheckHolds(c.truth, decision),
      castHolds: castHolds(c.truth, c.input.facts, decision), ms, usage,
    };
  });

  if (tracing) {
    await agent.flushTraces();
    for (const r of results) {
      const id = runIds.get(r.id);
      if (id) r.traceUrl = await agent.traceUrl(id);
    }
  }

  const run: Run = { at: started, model, mode, prompt, results };
  const report = renderReport(run, previous);
  console.log(`\n${report}`);
  if (runsDir) {
    mkdirSync(runsDir, { recursive: true, mode: 0o700 });
    chmodSync(runsDir, 0o700);
    const stamp = started.replace(/[:.]/g, "-");
    writeQuietly(join(runsDir, `${stamp}.md`), report);
    writeQuietly(join(runsDir, `${stamp}.json`), JSON.stringify(run, null, 2) + "\n");
    console.log(`Saved to ${join(runsDir, `${stamp}.md`)}.`);
  }
  if (tracing) console.log(`Traces: LangSmith project ${env.LANGSMITH_PROJECT || PROJECT}, synthetic cases only; desk cases are never traced.`);
  else console.log("Tracing is off (it needs LANGSMITH_API_KEY and JESTER_REVIEW_TRACE=1 in the env file), so nothing was traced.");

  // A false approval or a review that did not run fails the run. False rejections, escalations and name checks
  // that are off are reported for a person to read; they do not fail it.
  const s = summarize(results);
  if (s.falseApprovals) console.error(`${s.falseApprovals} false approval${s.falseApprovals === 1 ? "" : "s"}: the Chamberlain let in a clip it should not have.`);
  if (s.failed) console.error(`${s.failed} review${s.failed === 1 ? "" : "s"} did not run, so this run proves nothing about ${s.failed === 1 ? "that case" : "those cases"}.`);
  return s.falseApprovals || s.failed ? 1 : 0;
}

process.exitCode = await main();
