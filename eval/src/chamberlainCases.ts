// The Chamberlain's eval cases and how a replayed decision is scored against them. Pure: no model, no files.
//
// Two kinds of case:
// - synthetic: written in ../chamberlain-cases.ts with plain generated frames, committed, each with the verdict
//   it should get;
// - desk: saved by the dev server when the desk judges a real clip (app/review-cases.ts), outside the repo,
//   with the final outcome a person or the Chamberlain reached. A person's outcome is the truth.
//
// The types mirror app/review-agent.ts and app/review-cases.ts. They are copied, not imported, so the eval's
// typecheck never needs the app's agent packages (the desk's src/review.ts copies them the same way).

export type Verdict = "approve" | "reject" | "ask_a_person";
export type NameCheck = "fits" | "does_not_fit" | "inappropriate" | "missing";

export interface ClipFacts {
  error: string | null;
  durationMs: number;
  subjects: { label: string; kind: "person" | "thing"; seenShare: number; pace: string }[];
  skipped: { label?: string; reason: string }[];
  warnings: string[];
}

export interface ReviewInput {
  title: string | null;
  credit: string | null;
  facts: ClipFacts;
  frames: string[];
  /** The precedents the Chamberlain read with this review (app/review-precedents.ts), replayed as captured. */
  precedents?: unknown[];
}

export interface Decision {
  verdict: Verdict;
  reason: string;
  nameCheck: NameCheck;
  nameNote: string;
  framesCheck: string;
  findings: { from: string; text: string }[];
  steps: string[];
  /** From the one-call Chamberlain (PR 128): passed through and shown in the report when present. */
  contentCheck?: "clean" | "borderline" | "breaks_rules";
  steering?: boolean;
  playability?: "plays well" | "does not play" | "unsure";
  precedent?: string;
}

/** A desk case file, as app/review-cases.ts writes it. */
export interface CaseFile {
  schema: 1;
  id: string;
  source: "desk";
  capturedAt: string;
  videoPath: string | null;
  model: string;
  prompt: string;
  input: ReviewInput;
  decision: Decision | null;
  error?: string;
  outcome: { status: "approved" | "rejected"; by: "agent" | "aaron" | "check"; title: string | null; reason: string; bankId?: string; at: string } | null;
  label?: { want: Verdict; alsoOk?: Verdict[]; note?: string };
}

/** What a case should get: `want`, or one of `alsoOk`; and, when given, one of these name checks. */
export interface Truth { want: Verdict; alsoOk: Verdict[]; nameCheck?: NameCheck[] }

export interface EvalCase {
  id: string;
  source: "synthetic" | "desk";
  /** One line for the report: what the case tests, or where the clip came from. */
  about: string;
  input: ReviewInput;
  truth: Truth | null;
  /** Where the truth came from ("written with the case", "renamed by Aaron", ...) or why there is none. */
  truthFrom: string;
  /** The decision the Chamberlain made when the case was captured (desk cases only). */
  before: Decision | null;
  /** The prompt version that made `before`. */
  beforePrompt?: string;
}

export const normName = (t: string | null | undefined) => (t ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * The truth of a desk case. A hand label wins. Otherwise only a person's outcome counts: approved under the
 * name it was sent with means approve; approved under a new name (or a first name) means the Chamberlain should
 * have asked a person, since it never names a clip; rejected means reject. An outcome the Chamberlain reached on
 * its own confirms nothing, so such a case only shows whether the Chamberlain still decides the same way.
 */
export function truthOfDesk(c: CaseFile): { truth: Truth | null; from: string } {
  if (c.label) return { truth: { want: c.label.want, alsoOk: c.label.alsoOk ?? [] }, from: `hand label${c.label.note ? `: ${c.label.note}` : ""}` };
  const o = c.outcome;
  if (!o) return { truth: null, from: "still pending" };
  if (o.by !== "aaron") return { truth: null, from: `${o.status} by the ${o.by === "agent" ? "Chamberlain" : "game's check"} alone, not confirmed by a person` };
  if (o.status === "rejected") return { truth: { want: "reject", alsoOk: [] }, from: "rejected by Aaron" };
  if (c.input.title === null) return { truth: { want: "ask_a_person", alsoOk: [] }, from: `sent with no name; Aaron named it "${o.title ?? ""}" and let it in` };
  if (normName(o.title) !== normName(c.input.title)) return { truth: { want: "ask_a_person", alsoOk: [] }, from: `renamed by Aaron to "${o.title ?? ""}"` };
  return { truth: { want: "approve", alsoOk: [] }, from: "let in by Aaron under the name it was sent with" };
}

/** One entry of jester-review-log.json, the desk's own record of every decision (app/review-dev-server.ts). */
export interface LogEntry { id: string; title: string | null; verdict: string; by: string; reason: string; bankId?: string; at: string }

/**
 * A case's final outcome from the review log, for a case whose file has none: the decide route logs every
 * decision even when the case file missed it (decided while the Chamberlain was still judging, or a failed write).
 */
export function outcomeFromLog(log: LogEntry[], id: string): CaseFile["outcome"] {
  const e = [...log].reverse().find((x) => x.id === id && (x.verdict === "approved" || x.verdict === "rejected"));
  if (!e) return null;
  const by = e.by === "aaron" || e.by === "check" ? e.by : "agent";
  return { status: e.verdict as "approved" | "rejected", by, title: e.title, reason: e.reason, ...(e.bankId ? { bankId: e.bankId } : {}), at: e.at };
}

/**
 * Whether a case may be sent to LangSmith. Only synthetic cases, which the runner builds in code from
 * ../chamberlain-cases.ts with stick-figure frames. Every case read from the cases folder is a desk case
 * (deskCase sets that, whatever the file says), so a real submission's frames, title or credit are never traced.
 */
export const mayTrace = (c: Pick<EvalCase, "source">): boolean => c.source === "synthetic";

export function deskCase(file: CaseFile, log: LogEntry[] = []): EvalCase {
  const c: CaseFile = file.outcome ? file : { ...file, outcome: outcomeFromLog(log, file.id) };
  const { truth, from } = truthOfDesk(c);
  const when = c.capturedAt.slice(0, 16).replace("T", " ");
  return {
    id: c.id, source: "desk", about: `desk, ${when}${c.input.title ? `, sent as "${c.input.title}"` : ", sent with no name"}`,
    input: c.input, truth, truthFrom: from, before: c.decision, beforePrompt: c.prompt,
  };
}

// ---- Scoring one replay ----

/**
 * agree: a verdict the truth allows. false_approval: approved what a person turned away or renamed (the costly
 * mistake). false_rejection: turned away what should be let in or asked about. escalated: asked a person when the
 * answer was clear (safe, but costs Aaron a look). unconfirmed: no truth to score against. failed: no decision.
 */
export type Outcome = "agree" | "false_approval" | "false_rejection" | "escalated" | "unconfirmed" | "failed";

export function classify(truth: Truth | null, decision: Decision | null): Outcome {
  if (!decision) return "failed";
  if (!truth) return "unconfirmed";
  if (truth.want === decision.verdict || truth.alsoOk.includes(decision.verdict)) return "agree";
  if (decision.verdict === "approve") return "false_approval";
  if (decision.verdict === "reject") return "false_rejection";
  return "escalated";
}

/** False when the case names the name checks it allows and this decision's is not one of them. */
export const nameCheckHolds = (truth: Truth | null, decision: Decision | null) =>
  !truth?.nameCheck || !decision || truth.nameCheck.includes(decision.nameCheck);

/** Tokens across a review's model calls. `input` includes the cached ones, as LangChain reports it. */
export interface Usage { calls: number; input: number; output: number; cacheRead?: number; cacheWrite?: number }

export interface CaseResult {
  id: string;
  source: EvalCase["source"];
  about: string;
  truth: Truth | null;
  truthFrom: string;
  before: Verdict | null;
  decision: Decision | null;
  error: string | null;
  outcome: Outcome;
  nameHolds: boolean;
  ms: number;
  usage: Usage;
  traceUrl?: string | null;
}

export interface Summary {
  cases: number;
  judged: number;
  failed: number;
  withTruth: number;
  agree: number;
  falseApprovals: number;
  falseRejections: number;
  escalatedWhenClear: number;
  nameMisses: number;
  /** Share of judged cases that came back ask_a_person. */
  escalationRate: number | null;
  /** agree / withTruth. */
  agreement: number | null;
  /** Desk cases whose verdict differs from the one captured with them. */
  changedSinceCapture: number;
}

export function summarize(results: CaseResult[]): Summary {
  const judged = results.filter((r) => r.decision);
  const scored = results.filter((r) => r.outcome !== "unconfirmed" && r.outcome !== "failed");
  const count = (o: Outcome) => results.filter((r) => r.outcome === o).length;
  return {
    cases: results.length,
    judged: judged.length,
    failed: count("failed"),
    withTruth: scored.length,
    agree: count("agree"),
    falseApprovals: count("false_approval"),
    falseRejections: count("false_rejection"),
    escalatedWhenClear: count("escalated"),
    nameMisses: results.filter((r) => !r.nameHolds).length,
    escalationRate: judged.length ? judged.filter((r) => r.decision!.verdict === "ask_a_person").length / judged.length : null,
    agreement: scored.length ? count("agree") / scored.length : null,
    changedSinceCapture: results.filter((r) => r.before && r.decision && r.before !== r.decision.verdict).length,
  };
}

// ---- Cost ----

/**
 * List prices per million tokens, checked 2026-11-15: input, output, cache reads, and cache writes at 1.25 times
 * input (the 5 minute cache). Unknown models show no cost.
 */
export const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

export function costUsd(model: string, u: Usage): number | null {
  const p = PRICES[model];
  if (!p) return null;
  const read = u.cacheRead ?? 0, write = u.cacheWrite ?? 0;
  return (Math.max(0, u.input - read - write) * p.input + read * p.cacheRead + write * p.cacheWrite + u.output * p.output) / 1e6;
}

export const addUsage = (a: Usage, b: Usage): Usage => ({
  calls: a.calls + b.calls, input: a.input + b.input, output: a.output + b.output,
  cacheRead: (a.cacheRead ?? 0) + (b.cacheRead ?? 0), cacheWrite: (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0),
});

// ---- The report ----

export interface Run {
  at: string;
  model: string;
  prompt: string;
  results: CaseResult[];
}

const pct = (x: number | null) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);
const cell = (s: string) => s.replace(/\|/g, "/").replace(/\s+/g, " ").trim();
const VERDICT: Record<Verdict, string> = { approve: "approve", reject: "reject", ask_a_person: "ask" };
const OUTCOME: Record<Outcome, string> = {
  agree: "agree", false_approval: "FALSE APPROVAL", false_rejection: "false rejection", escalated: "escalated", unconfirmed: "unconfirmed", failed: "FAILED",
};
const truthText = (t: Truth | null) => (t ? [t.want, ...t.alsoOk].map((v) => VERDICT[v]).join(" or ") : "?");

function summaryRows(results: CaseResult[]): string[] {
  const groups: [string, CaseResult[]][] = [["all", results], ["synthetic", results.filter((r) => r.source === "synthetic")], ["desk", results.filter((r) => r.source === "desk")]];
  const s = groups.map(([, rs]) => summarize(rs));
  const row = (name: string, f: (x: Summary) => string) => `| ${name} | ${s.map(f).join(" | ")} |`;
  return [
    `| | ${groups.map(([g]) => g).join(" | ")} |`,
    "|---|---|---|---|",
    row("cases", (x) => String(x.cases)),
    row("agreement with the truth", (x) => `${pct(x.agreement)} (${x.agree} of ${x.withTruth} scored)`),
    row("false approvals", (x) => String(x.falseApprovals)),
    row("false rejections", (x) => String(x.falseRejections)),
    row("asked a person when it was clear", (x) => String(x.escalatedWhenClear)),
    row("escalation rate (ask a person)", (x) => pct(x.escalationRate)),
    row("name check off", (x) => String(x.nameMisses)),
    row("verdict changed since captured", (x) => String(x.changedSinceCapture)),
    row("failed to run (not scored; the run fails)", (x) => String(x.failed)),
  ];
}

/** Markdown report of one run, compared with the previous run's verdicts when there is one. */
export function renderReport(run: Run, previous: Run | null): string {
  const total = run.results.reduce<Usage>((u, r) => addUsage(u, r.usage), { calls: 0, input: 0, output: 0 });
  const cost = costUsd(run.model, total);
  const prev = new Map((previous?.results ?? []).map((r) => [r.id, r.decision?.verdict ?? null]));
  const changed = previous ? run.results.filter((r) => prev.has(r.id) && prev.get(r.id) !== (r.decision?.verdict ?? null)) : [];
  const secs = Math.round(run.results.reduce((t, r) => t + r.ms, 0) / 1000);
  const lines = [
    `# Chamberlain eval, ${run.at.slice(0, 16).replace("T", " ")}`,
    "",
    `Model ${run.model}, prompt ${run.prompt}. ${run.results.length} reviews (one per case), ${total.calls} model calls, ${total.input} input tokens (${total.cacheRead ?? 0} read from the cache, ${total.cacheWrite ?? 0} written to it) and ${total.output} output tokens${cost === null ? "" : `, about $${cost.toFixed(2)}`}, ${secs} s of review time.`,
    "",
    ...summaryRows(run.results),
    "",
  ];
  if (previous) {
    lines.push(`Compared with the run of ${previous.at.slice(0, 16).replace("T", " ")} (prompt ${previous.prompt}): ${changed.length ? `${changed.length} verdict${changed.length === 1 ? "" : "s"} changed: ${changed.map((r) => `${r.id} (${prev.get(r.id) ?? "failed"} to ${r.decision?.verdict ?? "failed"})`).join(", ")}.` : "no verdict changed."}`, "");
  }
  lines.push("## Cases", "", "| case | should get | was | now | name check | result |", "|---|---|---|---|---|---|");
  for (const r of run.results) {
    lines.push(`| ${r.id} | ${truthText(r.truth)} | ${r.before ? VERDICT[r.before] : ""} | ${r.decision ? VERDICT[r.decision.verdict] : "failed"} | ${r.decision ? `${r.decision.nameCheck}${r.nameHolds ? "" : " (off)"}` : ""} | ${OUTCOME[r.outcome]} |`);
  }
  const notable = run.results.filter((r) => r.outcome !== "agree" || !r.nameHolds || (r.before && r.decision && r.before !== r.decision.verdict));
  lines.push("", "## Differences", "");
  if (!notable.length) lines.push("Every case got a verdict its truth allows.");
  for (const r of notable) {
    lines.push(`### ${r.id}: ${OUTCOME[r.outcome]}`, "", `- ${cell(r.about)}`, `- Should get: ${truthText(r.truth)} (${cell(r.truthFrom)})${r.truth?.nameCheck ? `, name check ${r.truth.nameCheck.join(" or ")}` : ""}`);
    if (r.before && r.decision && r.before !== r.decision.verdict) lines.push(`- Changed since captured: ${r.before} then, ${r.decision.verdict} now`);
    if (r.error) lines.push(`- Error: ${cell(r.error)}`);
    if (r.decision) {
      const d = r.decision;
      lines.push(`- Now: ${d.verdict}. ${cell(d.reason)}`, `- Name: ${d.nameCheck}. ${cell(d.nameNote)}`, `- Frames: ${cell(d.framesCheck)}`);
      const checks = [d.contentCheck && `content ${d.contentCheck}`, d.steering !== undefined && `steering ${d.steering ? "yes" : "no"}`, d.playability && `playability ${d.playability}`].filter(Boolean);
      if (checks.length) lines.push(`- Checks: ${checks.join(", ")}`);
      if (d.precedent) lines.push(`- Precedent: ${cell(d.precedent)}`);
      for (const f of d.findings) lines.push(`- ${f.from}: ${cell(f.text)}`);
    }
    if (r.traceUrl) lines.push(`- Trace: ${r.traceUrl}`);
    lines.push("");
  }
  return lines.join("\n") + "\n";
}
