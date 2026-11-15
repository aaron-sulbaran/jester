// npm run watch                  every 3 minutes: pull new live rounds, score them, and start the referee coach on cases that newly fail
// npm run watch -- --once        one check, then exit
// npm run watch -- --no-coach    checks only, no model calls (free)
// npm run watch -- --baseline    counts the cases failing now as already looked at, so only new failures start the coach
// Options: --every <minutes> (3), --gap <minutes> between coach runs (15), --budget <USD> for coach runs this session (5)
//
// The referee coach on autopilot. Every round played on the live site lands in Supabase by itself. Each check pulls
// the new ones, scores them and their derived cases with the real engine (no model, no cost), and shows up in
// LangSmith as one "watch check" run. Only when cases fail that no coach run has looked at does it start the coach,
// which shows up as its own trace, tagged "watch". It runs on a laptop with agent/.env.local, never on the site.

// Imported first: it decides what LangSmith may keep before any client exists.
import { shapeOnlyClient, TRACING } from "./tracing.ts";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCurrentRunTree, traceable } from "langsmith/traceable";
import { SCORER_VERSION } from "../../engine/src/index.ts";
import { judge, rescore, type Rescored } from "../../eval/src/judge.ts";
import { deriveAll } from "../../eval/src/derive.ts";
import { currentEngineHash, isFrozen, loadCases, loadDataRounds, localRoundIds, saveDataRound } from "../../eval/src/store.ts";
import { fetchRecords, listRoundIds, settings } from "../../eval/src/supabase.ts";
import type { RoundRecord } from "../../eval/src/record.ts";
import { missingKeys } from "./models.ts";
import { isRealPlayer, mayRead, MODE_LINE } from "./real-rounds.ts";

// ---- Options ----

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: number) => {
  const at = args.indexOf(`--${name}`);
  const value = at >= 0 ? Number(args[at + 1]) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const once = flag("once");
const noCoach = flag("no-coach");
const baseline = flag("baseline");
const everyMinutes = option("every", 3);
const gapMinutes = option("gap", 15);
const budgetUsd = option("budget", 5);

const missing = noCoach ? ["LANGSMITH_API_KEY"].filter((k) => !process.env[k]?.trim()) : missingKeys();
if (missing.length) {
  console.error(`Fill these in agent/.env.local first: ${missing.join(", ")}.`);
  process.exit(1);
}
if (!TRACING) console.log("LangSmith tracing is off (LANGSMITH_TRACING), so the checks will not show up there.");

// ---- What the watch remembers between sessions (agent/workspace is not in git) ----

const AGENT_DIR = join(import.meta.dirname, "..");
const WORKSPACE = join(AGENT_DIR, "workspace");
const STATE_FILE = join(WORKSPACE, "watch-state.json");
interface CoachRun { at: string; cases: number; costUsd: number | null; exitCode: number | null; report: string | null }
interface State { looked: string[]; coachRuns: CoachRun[] }
mkdirSync(WORKSPACE, { recursive: true });
/** The saved state, or a fresh one when the file is missing or damaged (a damaged file is kept beside it as .bad). */
function loadState(): State {
  if (!existsSync(STATE_FILE)) return { looked: [], coachRuns: [] };
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<State>;
    if (Array.isArray(s.looked) && s.looked.every((id) => typeof id === "string") && Array.isArray(s.coachRuns)) return { looked: s.looked, coachRuns: s.coachRuns };
  } catch {
    // falls through to a fresh state
  }
  renameSync(STATE_FILE, STATE_FILE + ".bad");
  console.log(`The saved watch state was damaged; kept it as ${STATE_FILE}.bad and started fresh.`);
  return { looked: [], coachRuns: [] };
}
const state = loadState();
/** Failing case ids that a coach run has already been given (or that --baseline set aside). */
const looked = new Set(state.looked);
/** Writes the state to a temporary file first, so an interrupted write never leaves a damaged file. */
const save = () => {
  writeFileSync(STATE_FILE + ".tmp", JSON.stringify({ looked: [...looked].sort(), coachRuns: state.coachRuns }, null, 2));
  renameSync(STATE_FILE + ".tmp", STATE_FILE);
};

// ---- Scoring, kept in memory so each check only scores what is new ----

const clock = () => new Date().toLocaleTimeString("en-US", { hour12: false, timeZone: "America/New_York" });
const toItem = (record: RoundRecord): Rescored => ({ record, now: rescore(record), was: record.result.score });

/** The ids that do not hold among these rounds and the cases derived from them. Tagged rounds are judged against all rounds. */
function failuresOf(fresh: readonly Rescored[], all: readonly Rescored[]) {
  const derived = deriveAll(fresh);
  return {
    derived: derived.length,
    failing: [
      ...fresh.filter((it) => judge(it, all)?.holds === false).map((it) => it.record.id),
      ...derived.filter((d) => d.verdict.holds === false).map((d) => d.id),
    ],
  };
}

/** Tagged rounds are judged against other rounds (a "nailed" round sets the bar for its clip), so a new round can change an old verdict. */
function rejudgeTagged(all: readonly Rescored[], failing: Set<string>) {
  for (const it of all) {
    if (it.record.tag === null) continue;
    if (judge(it, all)?.holds === false) failing.add(it.record.id);
    else failing.delete(it.record.id);
  }
}

const engineHash = currentEngineHash();
console.log(`${clock()}  Scoring every round on ${SCORER_VERSION} once (about a minute)...`);
console.log(MODE_LINE);
const everyRound = [...loadCases().rounds, ...loadDataRounds().rounds.filter((r) => !isFrozen(r.id))];
const items: Rescored[] = everyRound.filter(mayRead).map(toItem);
const keptLocal = everyRound.length - items.length;
if (keptLocal) console.log(`${clock()}  ${keptLocal} real players' rounds stay on this laptop, unread by the agent.`);
const first = failuresOf(items, items);
let derivedCount = first.derived;
const failing = new Set(first.failing);
if (baseline) for (const id of failing) looked.add(id);
save();
console.log(`${clock()}  ${items.length} rounds, ${derivedCount} derived cases, ${failing.size} do not hold, ${[...failing].filter((id) => !looked.has(id)).length} not looked at yet.`);

// ---- One check ----

/** What was downloaded and saved, even when a later batch failed, plus the error if any. */
type Pulled = { data: RoundRecord[]; error: string | null };

/** Downloads the rounds in Supabase that this laptop does not have yet into eval/data/rounds. */
async function pull(): Promise<Pulled> {
  const s = await settings();
  if (s.error !== null) return { data: [], error: s.error };
  const ids = await listRoundIds(s.data);
  if (ids.error !== null) return { data: [], error: ids.error };
  const have = localRoundIds();
  const fresh: RoundRecord[] = [];
  const got = await fetchRecords(s.data, ids.data.filter((id) => !have.has(id)), (r) => {
    if (saveDataRound(r)) fresh.push(r);
  });
  // Rounds saved before a failed batch are kept and scored now; the next pull would skip them otherwise.
  return { data: fresh.filter((r) => r.mode !== "selftest"), error: got.error };
}

/** A run that ends without printing its cost counts as this much against the budget, so a crash never spends for free. */
const UNKNOWN_RUN_COST_USD = 2;
/** A coach run that takes longer than this is stopped. */
const COACH_TIMEOUT_MS = 30 * 60_000;
const REPO_DIR = join(AGENT_DIR, "..");

/** Runs `npm run coach` with a question about these cases, streams its output, and reads its cost and report path. */
function runCoach(cases: string[], newRounds: string[], watchRunId: string | undefined): Promise<CoachRun> {
  const listed = cases.slice(0, 60).join(", ") + (cases.length > 60 ? `, and ${cases.length - 60} more that eval_summary lists` : "");
  const question = [
    `The watch (npm run watch) found ${cases.length} cases that do not hold and that no coach run has looked at yet, on ${SCORER_VERSION}`,
    newRounds.length ? `, after ${newRounds.length} new rounds came in from the live site.` : ".",
    ` Their ids: ${listed}.`,
    " Investigate only these, as described: group them by clip and cause, hand the groups to case investigators, test any constant idea with replay_with, and write the report.",
    " Skip the overlay part unless these cases point at it, and say so in one line.",
  ].join("");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/coach.ts", question], {
      cwd: AGENT_DIR,
      env: { ...process.env, JESTER_COACH_TRIGGER: "watch", JESTER_WATCH_RUN_ID: watchRunId ?? "" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // The last match: the totals line is printed once, at the very end.
      const cost = [...out.matchAll(/Total about \$([\d.]+)/g)].at(-1);
      const report = [...out.matchAll(/Report: (agent\/workspace\/reports\/\S+?\.md)/g)].at(-1)?.[1] ?? null;
      // The coach prints the report path before it starts, so only a file that exists after the run counts.
      const written = report !== null && existsSync(join(REPO_DIR, report));
      resolve({ at: new Date().toISOString(), cases: cases.length, costUsd: cost ? Number(cost[1]) : null, exitCode: code, report: written ? report : null });
    };
    const timer = setTimeout(() => { console.log(`${clock()}  The coach ran past ${COACH_TIMEOUT_MS / 60_000} minutes; stopping it.`); child.kill("SIGTERM"); }, COACH_TIMEOUT_MS);
    child.on("error", (e) => { console.log(`${clock()}  The coach could not start: ${e.message}`); finish(null); });
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      out += text;
      process.stdout.write(text.replace(/^(?=.)/gm, "    coach | "));
    });
    child.on("close", (code) => finish(code));
  });
}

// Checks are traced through the same shape-only client as the coach; their outputs are counts under `watchCounts`.
const client = shapeOnlyClient;
let spentUsd = 0;
let lastCoachAt = 0;

const check = traceable(
  async (input: { roundsBefore: number; scorerVersion: string }) => {
    const pulled = await pull();
    // A failed pull still scores what arrived, and the local cases still get their coach run.
    if (pulled.error !== null) console.log(`${clock()}  Pulling rounds failed (${pulled.error}); going on with ${pulled.data.length} that arrived.`);
    const fresh = pulled.data.filter(mayRead).map(toItem);
    const freshReal = pulled.data.filter(isRealPlayer).length;
    items.push(...fresh);
    const found = failuresOf(fresh, items);
    derivedCount += found.derived;
    for (const id of found.failing) failing.add(id);
    if (fresh.some((f) => f.record.tag !== null)) rejudgeTagged(items, failing);
    const notLooked = [...failing].filter((id) => !looked.has(id)).sort();
    const engineChanged = currentEngineHash() !== engineHash;

    let coach: string | CoachRun = "not needed";
    if (notLooked.length) {
      const waitMinutes = (lastCoachAt + gapMinutes * 60_000 - Date.now()) / 60_000;
      if (noCoach) coach = "off (--no-coach)";
      else if (spentUsd >= budgetUsd) coach = `budget of ${budgetUsd} USD used up`;
      else if (waitMinutes > 0) coach = `waits ${Math.ceil(waitMinutes)} more minutes (gap between coach runs)`;
      else {
        console.log(`${clock()}  ${notLooked.length} failing cases no coach run has seen: starting the referee coach.`);
        const run = await runCoach(notLooked, fresh.map((f) => f.record.id), getCurrentRunTree(true)?.id);
        // The gap runs from the end of a coach run, so a long run does not use up its own cooldown.
        lastCoachAt = Date.now();
        spentUsd += run.costUsd ?? UNKNOWN_RUN_COST_USD;
        // Cases count as looked at only when the report file exists; otherwise the next run gets them (gap and budget still apply).
        if (run.report) for (const id of notLooked) looked.add(id);
        state.coachRuns.push(run);
        save();
        coach = run;
      }
    }

    const summary = {
      newRounds: fresh.length,
      rounds: items.length,
      derivedCases: derivedCount,
      notHolding: failing.size,
      newlyFailing: found.failing.length,
      notLookedAt: [...failing].filter((id) => !looked.has(id)).length,
      coach,
      coachSpendUsd: Math.round(spentUsd * 100) / 100,
      engineChanged,
    };
    const coachText = typeof coach === "string" ? coach : `ran, about ${coach.costUsd ?? "?"} USD, report ${coach.report ?? "missing"}`;
    if (freshReal && fresh.length < pulled.data.length) console.log(`${clock()}  ${freshReal} new real players' rounds stay on this laptop, unread by the agent.`);
    console.log(`${clock()}  ${fresh.length} new rounds (${items.length} in all), ${found.failing.length} newly failing, ${summary.notLookedAt} not looked at. Coach: ${coachText}.`);
    if (engineChanged) console.log(`${clock()}  The engine files changed on disk. Restart npm run watch to score every round with them.`);
    // Numbers only reach LangSmith: the shape-only client keeps `watchCounts` and drops every string.
    return { watchCounts: { pullFailed: pulled.error === null ? 0 : 1, newRounds: summary.newRounds, rounds: summary.rounds, derivedCases: summary.derivedCases, notHolding: summary.notHolding, newlyFailing: summary.newlyFailing, notLookedAt: summary.notLookedAt, coachRuns: state.coachRuns.length, coachSpendUsd: summary.coachSpendUsd } };
  },
  { name: "watch check", run_type: "chain", client, tags: ["watch"], metadata: { scorerVersion: SCORER_VERSION, engineHash } },
);

for (;;) {
  await check({ roundsBefore: items.length, scorerVersion: SCORER_VERSION });
  await client.awaitPendingTraceBatches();
  if (once) break;
  await new Promise((wake) => setTimeout(wake, everyMinutes * 60_000));
}
