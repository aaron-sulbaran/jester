// The models the referee coach runs on, and a meter that counts every call's tokens by model.
// Orchestrator: Claude Opus 5.5. Subagents: Muse Spark 1.3 on the Meta Model API (JESTER_SUBAGENT=haiku switches
// them to Claude Haiku 5.5). Keys come from agent/.env.local; nothing here runs in a browser.

import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import type { LLMResult } from "@langchain/core/outputs";
import type { AIMessage } from "@langchain/core/messages";

/**
 * List prices per million tokens. Cached input is read at `cacheRead` and written at `cacheWrite`; deepagents
 * caches the long system prompt, so most input after the first call is a cache read (about 99 percent in our runs,
 * from LangSmith's token details). Muse is billed to Aaron's Model API credit.
 */
export const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "muse-spark-1.3": { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 1.25 },
};

/** `input` counts every input token; `cacheRead` and `cacheWrite` are the parts of it that were cached. */
export interface Usage { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number }
export const usage = new Map<string, Usage>();

/** Counts tokens per model after every call (LangSmith has the full trace; this is the bill on screen). */
function meter(model: string) {
  return {
    handleLLMEnd(output: LLMResult) {
      const message = (output.generations[0]?.[0] as { message?: AIMessage } | undefined)?.message;
      const u = usage.get(model) ?? { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const meta = message?.usage_metadata;
      u.calls++;
      u.input += meta?.input_tokens ?? 0;
      u.output += meta?.output_tokens ?? 0;
      u.cacheRead += meta?.input_token_details?.cache_read ?? 0;
      u.cacheWrite += meta?.input_token_details?.cache_creation ?? 0;
      usage.set(model, u);
    },
  };
}

export function costUsd(model: string, u: Usage): number {
  const p = PRICES[model];
  if (!p) return 0;
  const plain = Math.max(0, u.input - u.cacheRead - u.cacheWrite);
  return (plain * p.input + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite + u.output * p.output) / 1e6;
}

/**
 * Claude Opus 5.5 at medium effort. Thinking is left to the model (Opus 5.5 cannot turn it off), and no sampling
 * settings are sent (Opus 5.5 rejects them). Server-side fallbacks are on: if a safety classifier declines a
 * request, the API retries it on a fallback model instead of returning a refusal.
 */
export function orchestratorModel() {
  const model = "claude-opus-5-5";
  return new ChatAnthropic({
    model,
    maxTokens: 16000,
    outputConfig: { effort: "medium" },
    betas: ["server-side-fallback-2026-07-01" as never],
    invocationKwargs: { fallbacks: "default" },
    callbacks: [meter(model)],
  });
}

/** Muse Spark 1.3 through the Meta Model API's OpenAI-compatible endpoint, or Claude Haiku 5.5 as the fallback. */
export function subagentModel() {
  if (process.env.JESTER_SUBAGENT === "haiku") {
    const model = "claude-haiku-5-5";
    return { name: model, model: new ChatAnthropic({ model, maxTokens: 8000, outputConfig: { effort: "low" }, callbacks: [meter(model)] }) };
  }
  const model = "muse-spark-1.3";
  return {
    name: model,
    model: new ChatOpenAI({
      model,
      apiKey: process.env.MODEL_API_KEY,
      configuration: { baseURL: "https://api.meta.ai/v1" },
      maxTokens: 8000,
      callbacks: [meter(model)],
    }),
  };
}

/** The names of the settings each run needs; their values are never printed. */
export function missingKeys(): string[] {
  const need = ["ANTHROPIC_API_KEY", "LANGSMITH_API_KEY", ...(process.env.JESTER_SUBAGENT === "haiku" ? [] : ["MODEL_API_KEY"])];
  return need.filter((k) => !process.env[k]?.trim());
}
