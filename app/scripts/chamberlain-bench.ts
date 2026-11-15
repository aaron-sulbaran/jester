// Times the Chamberlain on clips it already reviewed, on Aaron's laptop only (the same reviewSubmission call the
// dev server's /__review/judge route makes, never the live site). It reports each review's wall time, its
// verdict, and the model calls and tokens per stage, read from LangChain callbacks:
//   planner   the Chamberlain's calls that only plan or hand work out (write_todos, task)
//   subagent  the playability-checker's own calls
//   frames    the Chamberlain's call that looks at the frames and records the decision
//   wrap-up   any call after the decision (a closing message)
//
// node scripts/chamberlain-bench.ts <cases.json> <review-agent module> <label> [reps] [precedents.json]
//
// cases.json: { cases: [{ id, title, credit, facts }] } with frames at frames/<id>-0.jpg .. -3.jpg beside it.
// Keys: ANTHROPIC_API_KEY from the file JESTER_REVIEW_ENV points at. Run it with tracing off for real clips:
// with LANGSMITH_TRACING=true in the environment, reviewSubmission refuses every case not marked
// `"synthetic": true`, since real submissions' frames, titles and credits must not go to LangSmith.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";

type Stage = "planner" | "subagent" | "frames" | "wrap-up";
interface StageTotals { calls: number; ms: number; input: number; output: number; cacheRead: number; cacheWrite: number }
interface Case { id: string; title: string | null; credit: string | null; facts: unknown; synthetic?: boolean }

const [casesPath, agentPath, label, repsArg, precedentsPath] = process.argv.slice(2);
if (!casesPath || !agentPath || !label) {
  console.log("node scripts/chamberlain-bench.ts <cases.json> <review-agent module> <label> [reps] [precedents.json]");
  process.exit(1);
}
const reps = Number(repsArg ?? "1");

function readEnvFile(path: string | undefined): Record<string, string> {
  if (!path || !existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[2]) out[m[1]!] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
const apiKey = readEnvFile(process.env.JESTER_REVIEW_ENV).ANTHROPIC_API_KEY;
if (!apiKey) { console.log("No ANTHROPIC_API_KEY in the file JESTER_REVIEW_ENV points at."); process.exit(1); }

const { cases } = JSON.parse(readFileSync(casesPath, "utf8")) as { cases: Case[] };
const framesDir = join(dirname(resolve(casesPath)), "frames");
const frameUrls = (id: string) => [0, 1, 2, 3].map((i) => `data:image/jpeg;base64,${readFileSync(join(framesDir, `${id}-${i}.jpg`)).toString("base64")}`);
const agent = (await import(pathToFileURL(resolve(agentPath)).href)) as {
  reviewSubmission: (input: unknown, settings: Record<string, unknown>) => Promise<{ verdict: string; reason: string; nameCheck: string }>;
};
const precedents = precedentsPath ? JSON.parse(readFileSync(precedentsPath, "utf8")) as unknown[] : undefined;

const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((b) => (typeof b?.text === "string" ? b.text : "")).join("") : "";

/** Counts model calls by stage. The subagent is told apart by its own system prompt. */
class StageMeter extends BaseCallbackHandler {
  name = "stage-meter";
  totals: Record<Stage, StageTotals> = {
    planner: { calls: 0, ms: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    subagent: { calls: 0, ms: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    frames: { calls: 0, ms: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    "wrap-up": { calls: 0, ms: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  private open = new Map<string, { at: number; subagent: boolean }>();
  private decided = false;
  override async handleChatModelStart(_llm: unknown, messages: { content: unknown; getType?: () => string; _getType?: () => string }[][], runId: string) {
    const system = messages[0]?.find((m) => (m.getType?.() ?? m._getType?.()) === "system");
    this.open.set(runId, { at: Date.now(), subagent: textOf(system?.content).includes("You check, for the Chamberlain") });
  }
  override async handleLLMEnd(output: LLMResult, runId: string) {
    const started = this.open.get(runId);
    if (!started) return;
    this.open.delete(runId);
    type Usage = { input_tokens?: number; output_tokens?: number; input_token_details?: { cache_read?: number; cache_creation?: number } };
    const message = (output.generations[0]?.[0] as { message?: { tool_calls?: { name: string }[]; usage_metadata?: Usage } } | undefined)?.message;
    const calls = (message?.tool_calls ?? []).map((c) => c.name);
    let stage: Stage;
    if (started.subagent) stage = "subagent";
    else if (calls.includes("record_decision")) { stage = "frames"; this.decided = true; }
    else if (this.decided || calls.length === 0) stage = "wrap-up";
    else stage = "planner";
    const usage = message?.usage_metadata;
    const t = this.totals[stage];
    t.calls += 1;
    t.ms += Date.now() - started.at;
    t.input += usage?.input_tokens ?? 0;
    t.output += usage?.output_tokens ?? 0;
    t.cacheRead += usage?.input_token_details?.cache_read ?? 0;
    t.cacheWrite += usage?.input_token_details?.cache_creation ?? 0;
  }
}

const results: { case: string; rep: number; ms: number; verdict: string; nameCheck: string; reason: string; stages: Record<Stage, StageTotals>; decision?: unknown; error?: string }[] = [];
for (let rep = 1; rep <= reps; rep++) {
  for (const c of cases) {
    const meter = new StageMeter();
    const started = Date.now();
    try {
      const d = await agent.reviewSubmission(
        { title: c.title, credit: c.credit, facts: c.facts, frames: frameUrls(c.id), synthetic: c.synthetic === true, ...(precedents ? { precedents } : {}) },
        { apiKey, model: "claude-sonnet-5-5", callbacks: [meter] },
      );
      results.push({ case: c.id, rep, ms: Date.now() - started, verdict: d.verdict, nameCheck: d.nameCheck, reason: d.reason, stages: meter.totals, decision: d });
      console.log(`${label} ${c.id} #${rep}: ${d.verdict} in ${((Date.now() - started) / 1000).toFixed(1)} s (${Object.entries(meter.totals).map(([s, t]) => `${s} ${t.calls}`).join(", ")})`);
    } catch (err) {
      results.push({ case: c.id, rep, ms: Date.now() - started, verdict: "error", nameCheck: "", reason: "", stages: meter.totals, error: (err as Error).message.slice(0, 300) });
      console.log(`${label} ${c.id} #${rep}: error ${(err as Error).message.slice(0, 200)}`);
    }
  }
}

const out = join(dirname(resolve(casesPath)), `results-${label}.json`);
writeFileSync(out, JSON.stringify(results, null, 2) + "\n");
const times = results.filter((r) => r.verdict !== "error").map((r) => r.ms).sort((a, b) => a - b);
const median = times.length ? (times.length % 2 ? times[(times.length - 1) / 2]! : (times[times.length / 2 - 1]! + times[times.length / 2]!) / 2) : 0;
const sum = (stage: Stage, key: keyof StageTotals) => results.reduce((n, r) => n + r.stages[stage][key], 0) / Math.max(1, results.length);
console.log(`\n${label}: ${results.length} reviews, median ${(median / 1000).toFixed(1)} s, worst ${((times.at(-1) ?? 0) / 1000).toFixed(1)} s`);
for (const stage of ["planner", "subagent", "frames", "wrap-up"] as Stage[]) {
  console.log(`  ${stage.padEnd(8)} per review: ${sum(stage, "calls").toFixed(1)} calls, ${(sum(stage, "ms") / 1000).toFixed(1)} s, input ${Math.round(sum(stage, "input"))} (cache read ${Math.round(sum(stage, "cacheRead"))}, cache write ${Math.round(sum(stage, "cacheWrite"))}), output ${Math.round(sum(stage, "output"))}`);
}
console.log(`  written to ${out}`);
