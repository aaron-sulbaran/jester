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
import { TRACING } from "./tracing.ts";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "langsmith";
import { getCurrentRunTree, traceable } from "langsmith/traceable";
import { SCORER_VERSION } from "../../engine/src/index.ts";
import { judge, rescore, type Rescored } from "../../eval/src/judge.ts";
import { deriveAll } from "../../eval/src/derive.ts";
import { currentEngineHash, isFrozen, loadCases, loadDataRounds, localRoundIds, saveDataRound } from "../../eval/src/store.ts";
import { fetchRecords, listRoundIds, settings } from "../../eval/src/supabase.ts";
import type { RoundRecord } from "../../eval/src/record.ts";
import { missingKeys } from "./models.ts";

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
const state: State = existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, "utf8")) as State) : { looked: [], coachRuns: [] };
/** Failing case ids that a coach run has already been given (or that --baseline set aside). */
const looked = new Set(state.looked);
const save = () => writeFileSync(STATE_FILE, JSON.stringify({ looked: [...looked].sort(), coachRuns: state.coachRuns }, null, 2));

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

const engineHash = currentEngineHash();
console.log(`${clock()}  Scoring every round on ${SCORER_VERSION} once (about a minute)...`);
const items: Rescored[] = [...loadCases().rounds, ...loadDataRounds().rounds.filter((r) => !isFrozen(r.id))].map(toItem);
const first = failuresOf(items, items);
let derivedCount = first.derived;
const failing = new Set(first.failing);
if (baseline) for (const id of failing) looked.add(id);
save();
console.log(`${clock()}  ${items.length} rounds, ${derivedCount} derived cases, ${failing.size} do not hold, ${[...failing].filter((id) => !looked.has(id)).length} not looked at yet.`);

// ---- One check ----

type Pulled = { data: RoundRecord[]; error: null } | { data: null; error: string };

/** Downloads the rounds in Supabase that this laptop does not have yet into eval/data/rounds. */
async function pull(): Promise<Pulled> {
  const s = await settings();
  if (s.error !== null) return { data: null, error: s.error };
  const ids = await listRoundIds(s.data);
  if (ids.error !== null) return { data: null, error: ids.error };
  const have = localRoundIds();
  const fresh: RoundRecord[] = [];
  const got = await fetchRecords(s.data, ids.data.filter((id) => !have.has(id)), (r) => {
    if (saveDataRound(r)) fresh.push(r);
  });
  if (got.error !== null) return { data: null, error: got.error };
  return { data: fresh.filter((r) => r.mode !== "selftest"), error: null };
}

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
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      out += text;
      process.stdout.write(text.replace(/^(?=.)/gm, "    coach | "));
    });
    child.on("close", (code) => {
      const cost = /Total about \$([\d.]+)/.exec(out);
      const report = /Report: (\S+?\.md)/.exec(out);
      resolve({ at: new Date().toISOString(), cases: cases.length, costUsd: cost ? Number(cost[1]) : null, exitCode: code, report: report?.[1] ?? null });
    });
  });
}

// The checks' own runs hold counts only (no round ids, no scores), so this client shows them as they are.
const client = new Client({ hideInputs: false, hideOutputs: false });
let spentUsd = 0;
let lastCoachAt = 0;

const check = traceable(
  async (input: { roundsBefore: number; scorerVersion: string }) => {
    const pulled = await pull();
    if (pulled.error !== null) {
      console.log(`${clock()}  Could not pull rounds: ${pulled.error}`);
      return { error: "could not pull rounds", ...input };
    }
    const fresh = pulled.data.map(toItem);
    items.push(...fresh);
    const found = failuresOf(fresh, items);
    derivedCount += found.derived;
    for (const id of found.failing) failing.add(id);
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
        lastCoachAt = Date.now();
        const run = await runCoach(notLooked, fresh.map((f) => f.record.id), getCurrentRunTree(true)?.id);
        spentUsd += run.costUsd ?? 0;
        // Cases count as looked at once a report exists; a crashed run leaves them for the next one (the gap and budget still apply).
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
    console.log(`${clock()}  ${fresh.length} new rounds (${items.length} in all), ${found.failing.length} newly failing, ${summary.notLookedAt} not looked at. Coach: ${coachText}.`);
    if (engineChanged) console.log(`${clock()}  The engine files changed on disk. Restart npm run watch to score every round with them.`);
    return summary;
  },
  { name: "watch check", run_type: "chain", client, tags: ["watch"], metadata: { scorerVersion: SCORER_VERSION, engineHash } },
);

for (;;) {
  await check({ roundsBefore: items.length, scorerVersion: SCORER_VERSION });
  await client.awaitPendingTraceBatches();
  if (once) break;
  await new Promise((wake) => setTimeout(wake, everyMinutes * 60_000));
}
