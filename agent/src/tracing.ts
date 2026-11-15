// What LangSmith may keep. The coach reads rounds that real people played on the live site, so its traces keep the
// shape of each run (which model, subagent or tool ran, in what order, how long, how many tokens) and none of the
// content: no prompts, no tool arguments or results, no model text, no round numbers. Import this module first.
// LANGSMITH_TRACING=false in agent/.env.local turns tracing off entirely.

import { Client } from "langsmith";
import { LangChainTracer } from "@langchain/core/tracers/tracer_langchain";

// A fallback for any LangSmith client made without ours (by a library, say): it hides all inputs and outputs.
process.env.LANGSMITH_HIDE_INPUTS = "true";
process.env.LANGSMITH_HIDE_OUTPUTS = "true";

export const TRACING = process.env.LANGSMITH_TRACING === "true";

const COUNT_KEY = /usage|token|cache/i;

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

/** The client every coach and spike trace goes through: inputs dropped, outputs cut down to token counts. */
const shapeOnlyClient = new Client({
  hideInputs: true,
  hideOutputs: (outputs) => (tokenCountsOnly(outputs) as Record<string, unknown> | undefined) ?? {},
});

/** Callbacks to add to an agent's invoke config. LangChain adds no tracer of its own when one is already present. */
export function tracers(): LangChainTracer[] {
  return TRACING ? [new LangChainTracer({ client: shapeOnlyClient, projectName: process.env.LANGSMITH_PROJECT })] : [];
}

/** Sends the last batches before the process ends. */
export async function flushTraces(): Promise<void> {
  await shapeOnlyClient.awaitPendingTraceBatches();
}
