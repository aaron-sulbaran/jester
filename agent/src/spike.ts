// npm run spike: the smallest deep agent that proves the plumbing before the referee coach is built.
// Claude Opus 5.5 plans (write_todos), calls one tool (eval_summary), and hands one question to a subagent on Muse
// Spark 1.3 (task). Prints which tools ran, tokens and cost per model, and where the LangSmith trace is.
//   JESTER_SUBAGENT=haiku npm run spike   runs the subagent on Claude Haiku 5.5 instead of Muse.

// Imported first: it decides what LangSmith may keep before any client exists.
import { flushTraces, tracers } from "./tracing.ts";
import { createDeepAgent } from "deepagents";
import { todoListMiddleware } from "langchain";
import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import { costUsd, missingKeys, orchestratorModel, subagentModel, usage } from "./models.ts";
import { evalSummaryTool } from "./tools.ts";

const missing = missingKeys();
if (missing.length) {
  console.error(`Fill these in agent/.env.local first: ${missing.join(", ")}.`);
  process.exit(1);
}

const sub = subagentModel();
const agent = createDeepAgent({
  model: orchestratorModel(),
  tools: [evalSummaryTool],
  middleware: [todoListMiddleware()],
  systemPrompt: [
    "You check Jester's scorer. Jester is a game where players copy a person or a thing in a short video on their webcam,",
    "and a deterministic scorer gives 0 to 100. You never score anything yourself and never invent a number:",
    "every number you write must come from a tool result. You change nothing; you report.",
  ].join(" "),
  subagents: [
    {
      name: "round-analyst",
      description: "Answers one narrow question about specific rounds or derived cases, using eval_summary. Give it the exact ids.",
      systemPrompt:
        "You answer one question about Jester's round log. Call eval_summary, find the ids named in the task, and reply in at most 6 lines, quoting the exact numbers and expectation text from the tool. Never invent a number.",
      model: sub.model,
      tools: [evalSummaryTool],
    },
  ],
});

const task = [
  "Plan with write_todos first.",
  "Then call eval_summary.",
  "Then hand exactly one task to the round-analyst subagent: ask it to explain the derived cases that do not hold, naming their ids.",
  "Finish in at most 8 lines: what does not hold, the evidence numbers, and one question you would put to Alex, who owns the scorer.",
].join(" ");

const started = Date.now();
const result = await agent.invoke({ messages: [{ role: "user", content: task }] }, { recursionLimit: 40, callbacks: tracers() });

// What the orchestrator did, in order.
const steps: string[] = [];
for (const m of result.messages as { tool_calls?: { name: string; args?: Record<string, unknown> }[] }[]) {
  for (const call of m.tool_calls ?? []) steps.push(call.name === "task" ? `task -> ${String(call.args?.subagent_type ?? call.args?.subagentType ?? "?")}` : call.name);
}
const last = result.messages[result.messages.length - 1] as { content: unknown };
const answer = Array.isArray(last.content)
  ? (last.content as { type: string; text?: string }[]).filter((b) => b.type === "text").map((b) => b.text).join("\n")
  : String(last.content);

console.log("\n=== Answer ===\n" + answer);
console.log("\n=== Orchestrator tool calls, in order ===\n" + (steps.join("\n") || "(none)"));
console.log(`\n=== Models (subagent: ${sub.name}) ===`);
let total = 0;
for (const [model, u] of usage) {
  const cost = costUsd(model, u);
  total += cost;
  console.log(`${model}: ${u.calls} calls, ${u.input} in (${u.cacheRead} from cache), ${u.output} out, about $${cost.toFixed(3)}${model.startsWith("muse") ? " (Model API credit)" : ""}`);
}
console.log(`Total about $${total.toFixed(3)} in ${((Date.now() - started) / 1000).toFixed(0)} s.`);
const checks = {
  planned: steps.includes("write_todos"),
  calledTool: steps.includes("eval_summary"),
  delegated: steps.some((s) => s.startsWith("task")),
  subagentAnswered: (usage.get(sub.name)?.calls ?? 0) > 0,
};
console.log("Checks:", JSON.stringify(checks));
console.log(process.env.LANGSMITH_TRACING === "true" ? `Trace: smith.langchain.com, project "${process.env.LANGSMITH_PROJECT ?? "default"}".` : "LangSmith tracing is off (LANGSMITH_TRACING).");
// Send the last trace data before the process ends (otherwise the final calls stay "pending" in LangSmith).
await awaitAllCallbacks();
await flushTraces();
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
