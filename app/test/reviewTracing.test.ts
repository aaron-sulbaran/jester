// Run from app/: npm test. A tracing variable left in the shell must never trace a review on its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { INHERITED_TRACING, stopInheritedTracing } from "../review-agent.ts";

test("LangChain traces on its own when a tracing variable is set, and not after stopInheritedTracing", async () => {
  const saved = Object.fromEntries([...INHERITED_TRACING, "LANGSMITH_API_KEY"].map((k) => [k, process.env[k]]));
  try {
    process.env.LANGSMITH_TRACING = "true";
    process.env.LANGCHAIN_TRACING_V2 = "true";
    process.env.LANGSMITH_API_KEY = "placeholder-not-a-key";
    const { CallbackManager } = await import("@langchain/core/callbacks/manager");
    const tracers = async () => ((await CallbackManager.configure(undefined))?.handlers ?? []).map((h) => h.name).filter((n) => /tracer/i.test(n));
    assert.ok((await tracers()).length > 0, "the inherited variable installs LangChain's tracer");
    assert.deepEqual(stopInheritedTracing().sort(), ["LANGCHAIN_TRACING_V2", "LANGSMITH_TRACING"]);
    assert.deepEqual(await tracers(), []);
    assert.deepEqual(stopInheritedTracing(), []);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
