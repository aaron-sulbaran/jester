// npm run eval                      re-score every frozen case and every local round with the engine code on disk
// npm run eval -- --save            also save the headline numbers to eval/baseline.json
// npm run eval -- --set ROUND.ceiling=0.9   what-if: change engine constants for this run only (never saved)
// npm run eval -- --cases-only      leave out the local rounds in eval/data
//
// Every nailed round, and every untagged round scoring 60 or more, also gets six derived cases (src/derive.ts).
//
// Exits with an error only when a frozen case's expectation, or one of its derived cases, held in the baseline and
// no longer holds.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { SCORER_VERSION, constants, type TrajectoryRoundResult } from "../../engine/src/index.ts";
import { EXPECT } from "../expectations.ts";
import { clipName, judge, median, rawPoseValue, rescore, setConstant, type Rescored, type Verdict } from "./judge.ts";
import { BASELINE_FILE, REPORT_FILE, currentEngineHash, isFrozen, loadCases, loadDataRounds } from "./store.ts";
import { deriveAll, type DerivedCase } from "./derive.ts";

interface Baseline {
  savedAt: string;
  scorerVersion: string;
  engineHash: string;
  headline: Headline;
  cases: Record<string, { tag: string | null; score: number | null; holds: boolean | null }>;
}

interface Headline {
  cases: number; tagged: number; holding: number; notHolding: number; drifted: number; localRounds: number;
  /** Derived cases from frozen cases (baselines saved before derived cases existed lack these). */
  derived?: number; derivedHolding?: number; derivedNotHolding?: number;
}

// ---- Arguments ----

const args = process.argv.slice(2);
const save = args.includes("--save");
const casesOnly = args.includes("--cases-only");
const sets: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--set" && args[i + 1]) sets.push(args[++i]!);
  else if (a.startsWith("--set=")) sets.push(a.slice(6));
}
const whatIf: string[] = [];
for (const s of sets) {
  const [path, raw] = s.split("=");
  const value = Number(raw);
  if (!path || raw === undefined || !Number.isFinite(value)) { console.error(`--set needs GROUP.name=number, got "${s}"`); process.exit(2); }
  const done = setConstant(path, value);
  if (done.error !== null) { console.error(done.error); process.exit(2); }
  whatIf.push(`${path} ${done.data} -> ${value}`);
}
if (save && whatIf.length) { console.error("--save and --set do not mix: a what-if run is never the baseline."); process.exit(2); }

// ---- Re-score ----

const cases = loadCases();
const local = casesOnly ? { rounds: [], skipped: [] } : loadDataRounds();
const localRounds = local.rounds.filter((r) => !isFrozen(r.id));
const toItem = (record: Rescored["record"]): Rescored => ({ record, now: rescore(record), was: record.result.score });
const caseItems = cases.rounds.map(toItem);
const localItems = localRounds.map(toItem);
const everything = [...caseItems, ...localItems];
const verdicts = new Map<Rescored, Verdict | null>(everything.map((it) => [it, judge(it, everything)]));
const engineHash = currentEngineHash();
const caseDerived = deriveAll(caseItems);
const localDerived = deriveAll(localItems);

const baseline: Baseline | null = existsSync(BASELINE_FILE) ? (JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as Baseline) : null;
const regressions = caseItems.filter((it) => baseline?.cases[it.record.id]?.holds === true && verdicts.get(it)?.holds === false);
const derivedRegressions = caseDerived.filter((d) => baseline?.cases[d.id]?.holds === true && d.verdict.holds === false);
const moved = (it: Rescored) => (it.was === null) !== (it.now.score === null) || (it.was !== null && it.now.score !== null && Math.abs(it.now.score - it.was) >= EXPECT.driftMin);
const drifted = everything.filter(moved);
// Same engine code as when played (and no uncommitted engine change), no what-if: an exactly stored round must replay
// to the very same result, or the recording lost something. Version 1 rounds were stored rounded, so they are left out.
const sameResult = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => sameResult((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
};
const checkable = whatIf.length ? [] : everything.filter((it) => it.record.player.schema === "packed-pose/2" && it.record.app?.engineHash === engineHash && it.record.app?.dirty !== true);
const recorderMisses = checkable.filter((it) => !sameResult(it.record.result, it.now));

// ---- Report ----

const out: string[] = [];
const cell = (s: string) => s.replace(/\|/g, "/");
const score = (s: number | null) => (s === null ? "none" : String(s));
const holdsText = (v: Verdict | null | undefined) => (!v ? "" : v.holds === null ? "n/a" : v.holds ? "yes" : "**NO**");
const row = (it: Rescored) => {
  const v = verdicts.get(it);
  const r = it.record;
  return `| ${r.id} | ${r.tag ?? ""} | ${cell(clipName(r))} | ${r.mode} | ${score(it.was)} | ${score(it.now.score)} | ${cell(v?.expectation ?? "")} | ${holdsText(v)} | ${cell(v?.detail ?? "")} |`;
};
const table = (items: Rescored[]) => {
  out.push("| round | tag | clip | mode | was | now | expectation | holds | detail |", "|---|---|---|---|---|---|---|---|---|");
  for (const it of items) out.push(row(it));
};

const tagged = caseItems.filter((it) => verdicts.get(it));
const headline: Headline = {
  cases: caseItems.length,
  tagged: tagged.length,
  holding: tagged.filter((it) => verdicts.get(it)?.holds === true).length,
  notHolding: tagged.filter((it) => verdicts.get(it)?.holds === false).length,
  drifted: caseItems.filter(moved).length,
  localRounds: localItems.length,
  derived: caseDerived.length,
  derivedHolding: caseDerived.filter((d) => d.verdict.holds === true).length,
  derivedNotHolding: caseDerived.filter((d) => d.verdict.holds === false).length,
};

out.push(`# Jester eval, ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} Eastern`, "");
out.push(`Engine ${SCORER_VERSION}, code ${engineHash}. ${headline.cases} frozen cases (${headline.tagged} tagged: ${headline.holding} holding, ${headline.notHolding} not), ${headline.localRounds} local rounds not frozen. ${caseDerived.length + localDerived.length} derived cases (${[...caseDerived, ...localDerived].filter((d) => d.verdict.holds === true).length} holding, ${[...caseDerived, ...localDerived].filter((d) => d.verdict.holds === false).length} not).`);
if (whatIf.length) out.push("", `**What-if run, nothing saved:** ${whatIf.join("; ")}.`);
if (cases.skipped.length || local.skipped.length) out.push("", `Skipped unreadable files: ${[...cases.skipped, ...local.skipped].join(", ")}.`);

out.push("", "## Frozen cases", "");
if (caseItems.length) table(caseItems); else out.push("None yet. Play tagged rounds with `?dev=1`, then `npm run freeze -- --tagged`.");

out.push("", "## Expectations by tag", "", "| tag | rounds | holding | not holding | n/a |", "|---|---|---|---|---|");
const tags = [...new Set(everything.map((it) => it.record.tag).filter((t): t is NonNullable<typeof t> => t !== null))].sort();
for (const t of tags) {
  const vs = everything.filter((it) => it.record.tag === t).map((it) => verdicts.get(it));
  out.push(`| ${t} | ${vs.length} | ${vs.filter((v) => v?.holds === true).length} | ${vs.filter((v) => v?.holds === false).length} | ${vs.filter((v) => v?.holds === null).length} |`);
}
if (!tags.length) out.push("| (no tagged rounds yet) | | | | |");

const derivedTable = (title: string, items: DerivedCase[]) => {
  out.push("", title, "", "| case | clip | source | now | expectation | holds | detail |", "|---|---|---|---|---|---|---|");
  for (const d of items) out.push(`| ${d.id} | ${cell(clipName(d.record))} | ${score(d.source.now.score)} | ${score(d.now.score)} | ${cell(d.verdict.expectation)} | ${holdsText(d.verdict)} | ${cell(d.verdict.detail)} |`);
};
if (caseDerived.length) derivedTable("## Derived cases from frozen cases", caseDerived);
if (localDerived.length) derivedTable("## Derived cases from local rounds", localDerived);
if (!caseDerived.length && !localDerived.length) out.push("", "## Derived cases", "", `None yet: they come from nailed rounds and untagged rounds scoring ${EXPECT.derived.minSourceScore} or more.`);

out.push("", `## Scores that moved by ${EXPECT.driftMin} or more since they were played`, "");
if (drifted.length) {
  out.push("| round | tag | clip | played with | was | now |", "|---|---|---|---|---|---|");
  for (const it of drifted) out.push(`| ${it.record.id} | ${it.record.tag ?? ""} | ${cell(clipName(it.record))} | ${it.record.scorerVersion} | ${score(it.was)} | ${score(it.now.score)} |`);
} else out.push("None.");

out.push("", "## Calibration hints (for Alex; nothing is changed)", "");
const nailedRaw = everything.filter((it) => it.record.tag === "nailed").map((it) => rawPoseValue(it.record)).filter((v): v is number => v !== null);
const m = median(nailedRaw);
if (m === null || nailedRaw.length < EXPECT.minNailedForHint) out.push(`- Score ceiling: needs at least ${EXPECT.minNailedForHint} nailed person rounds (have ${nailedRaw.length}).`);
else {
  const ceiling = Math.round((constants.ROUND.floor + (m - constants.ROUND.floor) / (EXPECT.nailedTarget / 100)) * 100) / 100;
  out.push(`- Score ceiling: the median nailed copy's raw value is ${m.toFixed(2)} over ${nailedRaw.length} rounds. ROUND.ceiling ${ceiling} would put it at ${EXPECT.nailedTarget} (now ${constants.ROUND.ceiling}). Try it: \`npm run eval -- --set ROUND.ceiling=${ceiling}\`.`);
}
const corr = everything.filter((it) => it.record.tag === "nailed" && it.record.channel === "trajectory").map((it) => (it.now as TrajectoryRoundResult).correlation).filter((v): v is number => v !== null);
const mc = median(corr);
out.push(mc === null ? "- Thing rounds (good correlation): no nailed thing rounds yet." : `- Thing rounds: median correlation of nailed copies is ${mc.toFixed(2)} over ${corr.length} rounds; TRAJECTORY.goodCorrelation is ${constants.TRAJECTORY.goodCorrelation}.`);

if (localItems.length) {
  out.push("", "## Local rounds not frozen yet", "");
  table(localItems);
}
if (checkable.length && !recorderMisses.length) out.push("", `Recorder check: all ${checkable.length} rounds scored by this same engine code replay to the identical result.`);
if (recorderMisses.length) {
  out.push("", "## Recorder check failed", "", `These rounds were scored by this same engine code but replay to a different result, so the recording lost something: ${recorderMisses.map((it) => `${it.record.id} (score ${score(it.was)} -> ${score(it.now.score)})`).join(", ")}.`);
}

out.push("", "## Verdict", "");
if (whatIf.length) out.push("What-if run: no verdict.");
else if (!baseline) out.push("No baseline yet. Save one with `npm run eval -- --save`.");
else if (regressions.length || derivedRegressions.length) out.push(`**FAIL:** held in the baseline (${baseline.savedAt}) and no longer holds: ${[...regressions.map((it) => `${it.record.id} (${it.record.tag}: ${verdicts.get(it)?.detail})`), ...derivedRegressions.map((d) => `${d.id} (${d.verdict.detail})`)].join("; ")}.`);
else out.push(`OK: every expectation that held in the baseline (${baseline.savedAt}, ${baseline.scorerVersion}) still holds.`);

const report = out.join("\n") + "\n";
process.stdout.write(report);
writeFileSync(REPORT_FILE, report);

if (save) {
  const next: Baseline = {
    savedAt: new Date().toISOString(),
    scorerVersion: SCORER_VERSION,
    engineHash,
    headline,
    cases: Object.fromEntries([
      ...caseItems.map((it) => [it.record.id, { tag: it.record.tag, score: it.now.score, holds: verdicts.get(it)?.holds ?? null }] as const),
      ...caseDerived.map((d) => [d.id, { tag: `derived:${d.transform}`, score: d.now.score, holds: d.verdict.holds }] as const),
    ]),
  };
  writeFileSync(BASELINE_FILE, JSON.stringify(next, null, 2) + "\n");
  console.log(`\nBaseline saved: ${headline.cases} cases (${headline.holding} holding) and ${caseDerived.length} derived cases (${headline.derivedHolding} holding).`);
}

if (!whatIf.length && (regressions.length || derivedRegressions.length)) process.exit(1);
