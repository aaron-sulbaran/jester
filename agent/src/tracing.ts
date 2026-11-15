// What LangSmith may keep. The coach reads rounds that real people played on the live site, so its traces keep the
// shape of each run (which model, subagent or tool ran, in what order, how long, how many tokens) and none of the
// content: no prompts, no tool arguments or results, no model text, no round numbers. Import this module first.
// LANGSMITH_TRACING=false in agent/.env.local turns tracing off entirely.

import { Client } from "langsmith";
import { LangChainTracer } from "@langchain/core/tracers/tracer_langchain";

// A fallback for any LangSmith client made without ours (by a library, say): it hides all inputs and outputs.
process.env.LANGSMITH_HIDE_INPUTS = "true";
process.env.LANGSMITH_HIDE_OUTPUTS = "true";

// Any of the names LangChain and LangSmith read for "trace this". When one is on, our tracer is attached and
// LangChain adds none of its own. LANGSMITH_TRACING=false (with none of the others set) turns tracing off.
export const TRACING = ["LANGSMITH_TRACING", "LANGSMITH_TRACING_V2", "LANGCHAIN_TRACING", "LANGCHAIN_TRACING_V2"].some((name) => process.env[name] === "true");

// Token and usage numbers, and the watch's own counts (`watchCounts`, numbers only).
const COUNT_KEY = /usage|token|cache|^watchCounts$/i;

/** Keeps only number leaves that sit under a token or usage key. Every string, and every other number, is dropped. */
export function tokenCountsOnly(value: unknown, underCountKey = false): unknown {
  if (typeof value === "number") return underCountKey ? value : undefined;
  if (Array.isArray(value)) {
    const kept = value.map((v) => tokenCountsOnly(v, underCountKey)).filter((v) => v !== undefined);
    return kept.length ? kept : undefined;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      const kept = tokenCountsOnly(v, underCountKey || COUNT_KEY.test(key));
      if (kept !== undefined) out[key] = kept;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return undefined;
}

const METADATA_KEPT = /^(ls_provider|ls_model_name|ls_model_type|ls_run_depth|usage_metadata|langgraph_node|langgraph_step|trigger|watchRunId|scorerVersion|engineHash)$/;

/** The one client every trace goes through (coach, spike, watch): inputs dropped, outputs cut down to counts. */
export const shapeOnlyClient = new Client({
  hideInputs: true,
  hideOutputs: (outputs) => (tokenCountsOnly(outputs) as Record<string, unknown> | undefined) ?? {},
  // Error text can quote a request (a prompt, a round, a header), so every error becomes one fixed line.
  anonymizer: () => ({ error: "error (text hidden by agent/src/tracing.ts)" }),
  // Metadata keeps what LangSmith needs to name the model and price the run, and the coach's and watch's own keys.
  hideMetadata: (metadata) => Object.fromEntries(Object.entries(metadata).filter(([key]) => METADATA_KEPT.test(key))),
});

/** Callbacks to add to an agent's invoke config. LangChain adds no tracer of its own when one is already present. */
export function tracers(): LangChainTracer[] {
  return TRACING ? [new LangChainTracer({ client: shapeOnlyClient, projectName: process.env.LANGSMITH_PROJECT })] : [];
}

/** Sends the last batches before the process ends. */
export async function flushTraces(): Promise<void> {
  await shapeOnlyClient.awaitPendingTraceBatches();
}
