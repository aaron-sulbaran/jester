// npm run coach                       investigate the whole round log and write a report for Alex
// npm run coach -- "<question>"       investigate one question instead
//
// The referee coach: a LangChain deep agent. Claude Opus 5.5 plans (write_todos), sends case investigators and a
// what-if tester (Muse Spark 1.3 subagents) after each failing or odd case, tests ideas with the real scorer
// (replay_with), writes findings and a report to agent/workspace, checks that every number in the report came from
// a tool, and may propose a constant change for Alex, which a person must approve first. It never scores a round and
// never edits the engine. Traces go to LangSmith.

import { createInterface } from "node:readline/promises";
import { mkdirSync } from "node:fs";
import { createDeepAgent, FilesystemBackend } from "deepagents";
import { todoListMiddleware, type HITLRequest } from "langchain";
import { Command, MemorySaver } from "@langchain/langgraph";
import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import { costUsd, missingKeys, orchestratorModel, subagentModel, usage } from "./models.ts";
import {
  WORKSPACE, checkNumbersTool, engineConstantsTool, evalSummaryTool, getRoundTool, overlaySummaryTool, proposeConstantsChangeTool, replayWithTool, toolCalls, unsupportedNumbers,
} from "./tools.ts";

const missing = missingKeys();
if (missing.length) {
  console.error(`Fill these in agent/.env.local first: ${missing.join(", ")}.`);
  process.exit(1);
}
mkdirSync(WORKSPACE, { recursive: true });

const stamp = new Date().toLocaleString("sv-SE", { timeZone: "America/New_York" }).replace(" ", "_").replace(/:/g, "").slice(0, 15);
const reportPath = `/reports/coach-${stamp}.md`;

const SYSTEM = `You are the referee coach for Jester, a party game built at HackPrinceton. Players copy a person or a thing in a short video on their webcam, and a deterministic scorer (the engine, owned by Alex; she/her) gives each attempt 0 to 100. Every round played on the team's dev servers and the live site is recorded as pose data. The eval suite replays those rounds through the engine and checks expectations:
- Tagged rounds (nailed, stood-still, seated, late-half-second, wrong-moves, left-right-swapped, walked-out-of-frame) each promise something about the score.
- Derived cases are transformed copies of good rounds with known answers: late (lag moves by 500 ms), frozen (10 or less), seated (capped when the clip uses the legs), walked-out (no score or capped), jittered (within 5 of the source), mirrored (report only). "holds: null" means report only or not applicable.

Your job has two parts. You advise; you change nothing.
A. Scoring: find where the scorer's behaviour and these expectations disagree, explain why with evidence, and say what, if anything, should change. This part is for Alex.
B. The overlay: during a round the game shows the subject's outline on the mirrored camera view, and an outline fit (0 to 100, shown to players, not scored) with hints to step closer or back and move left or right. Use overlay_summary to find, per clip, whether camera players can line up with it, and whether a hint most players share points at the overlay's size or place for that clip, or at how laptop cameras frame people, rather than at the players. Simulated rounds always line up perfectly and say nothing here. This part is for the team that owns the game screens.

Hard rules:
1. You never score anything and never invent a number. Every number you write must come from a tool result in this run. If no tool answers a question, write "not measured".
2. Engine limits come from engine_constants, never from memory or inference.
3. A claim about a fix needs a replay_with result: what it fixes, what it breaks, what moves by 5 or more.
4. You never edit engine files. The only way to suggest a change is propose_constants_change, and only for a change replay_with showed fixes something and breaks nothing. A person approves it first.
5. Before you finish, run check_numbers on the full report text and fix every number it lists.
6. Plain words, short sentences, no em dashes.

How to work:
1. Plan with write_todos first, and keep the list current.
2. Call eval_summary.
3. Group what does not hold, and the report-only oddities worth Alex's attention (for example a mirrored copy far below or above its source), by clip and cause. Hand each group to a case-investigator with the exact ids; run several at once when they are independent.
4. For each cause that a constant might fix, hand one hypothesis at a time to the what-if-tester, or call replay_with yourself.
5. Call overlay_summary and, for any clip where most camera players share a hint or the fit is low, compare where and how big the subject and the players are in frame. A case-investigator can dig into single rounds with get_round.
6. Write the report to ${reportPath} with write_file, in this order: Summary (three lines); Scoring findings (each: what, the evidence numbers, the likely cause, how sure); What-if results; Recommendation for Alex; Overlay findings (per clip that matters: fit, shared hints, subject versus players in frame, and what the game could change, for example where or how big the outline is drawn, or the framing advice before a round); Next five rounds to play (concrete: which clip, which tag, why each would add evidence).
7. Run check_numbers on the report, fix it, then finish with the report's Summary.`;

const investigator = subagentModel();
const tester = subagentModel();

const agent = createDeepAgent({
  model: orchestratorModel(),
  systemPrompt: SYSTEM,
  tools: [evalSummaryTool, getRoundTool, engineConstantsTool, replayWithTool, overlaySummaryTool, checkNumbersTool, proposeConstantsChangeTool],
  middleware: [todoListMiddleware()],
  backend: new FilesystemBackend({ rootDir: WORKSPACE, virtualMode: true }),
  checkpointer: new MemorySaver(),
  interruptOn: { propose_constants_change: true },
  subagents: [
    {
      name: "case-investigator",
      description: "Investigates one failing or odd round or derived case (or a small group sharing a cause) with get_round, eval_summary and engine_constants, writes a finding to /findings/, and returns the cause with evidence. Give it the exact ids and what looks wrong.",
      systemPrompt:
        "You investigate scoring cases in Jester's eval suite. Use get_round on each id (derived ids look like r-abc~frozen), compare with its source round and with engine_constants. Find the mechanism: which limbs, seconds, motion or lag numbers explain the score. Write a short finding to /findings/<short-name>.md, then reply in at most 8 lines: the cause, the evidence numbers, and how sure you are. Every number must come from a tool result; write \"not measured\" otherwise. Never invent a limit; read it with engine_constants. No em dashes.",
      model: investigator.model,
      tools: [getRoundTool, evalSummaryTool, engineConstantsTool, overlaySummaryTool],
    },
    {
      name: "what-if-tester",
      description: "Tests one hypothesis about an engine constant with replay_with (at most four values), and reports which value fixes the target cases without breaking anything that holds. Give it the constant, the target ids, and why.",
      systemPrompt:
        "You test one hypothesis about Jester's engine constants. Read the current value with engine_constants, then call replay_with with at most four candidate values, one per call. Reply in at most 8 lines: for each value, how many cases it fixes and breaks and which scores move by 5 or more, and the best value if one fixes the targets and breaks nothing. Every number must come from a tool result. You change nothing. No em dashes.",
      model: tester.model,
      tools: [replayWithTool, engineConstantsTool, getRoundTool],
    },
  ],
});

const question = process.argv.slice(2).join(" ").trim();
const task = question
  ? `${question}\n\nWrite your report to ${reportPath}.`
  : "Investigate the whole round log as described, and write the report.";

// Live progress: every tool call, including the subagents' own.
const progress = {
  handleToolStart(_tool: unknown, input: string, _runId: string, _parentRunId?: string, _tags?: string[], _metadata?: Record<string, unknown>, runName?: string) {
    const name = runName ?? "tool";
    let detail = "";
    try {
      const args = JSON.parse(input) as Record<string, unknown>;
      detail = String(args.id ?? args.subagent_type ?? args.file_path ?? (args.changes ? JSON.stringify(args.changes) : "") ?? "");
    } catch {
      detail = "";
    }
    console.log(`  ${new Date().toLocaleTimeString("en-US", { hour12: false })}  ${name}${detail ? "  " + detail.slice(0, 90) : ""}`);
  },
};

const config = { configurable: { thread_id: `coach-${stamp}` }, recursionLimit: 150, callbacks: [progress] };
const started = Date.now();
console.log(`Referee coach: Opus 5.5 orchestrator, ${investigator.name} subagents. Report: agent/workspace${reportPath}`);

let result = await agent.invoke({ messages: [{ role: "user", content: task }] }, config);

// The approval gate: a person decides on every proposed constant change.
type Interrupted = { __interrupt__?: { value: HITLRequest }[] };
while ((result as Interrupted).__interrupt__?.length) {
  const request = (result as Interrupted).__interrupt__![0]!.value;
  const decisions = [];
  for (const action of request.actionRequests) {
    console.log(`\nThe coach wants to run ${action.name}:\n${JSON.stringify(action.args, null, 2)}`);
    let approve = false;
    if (process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      approve = /^y(es)?$/i.test((await rl.question("Approve writing this proposal for Alex? [y/N] ")).trim());
      rl.close();
    } else {
      console.log("No one at the terminal to approve, so it is declined; the report still describes it.");
    }
    decisions.push(approve ? { type: "approve" as const } : { type: "reject" as const, message: "Not approved by a person. Describe the proposal in the report instead." });
  }
  result = await agent.invoke(new Command({ resume: { decisions } }), config);
}

// What it did.
const messages = result.messages as { content: unknown; tool_calls?: { name: string }[] }[];
const steps = messages.flatMap((m) => m.tool_calls?.map((c) => c.name) ?? []);
const last = messages[messages.length - 1]!;
const text = Array.isArray(last.content)
  ? (last.content as { type: string; text?: string }[]).filter((b) => b.type === "text").map((b) => b.text).join("\n")
  : String(last.content);
console.log("\n=== Summary ===\n" + text);

console.log(`\nOrchestrator tool calls: ${steps.length} (${[...new Set(steps)].join(", ")})`);
let total = 0;
for (const [model, u] of usage) {
  const cost = costUsd(model, u);
  total += cost;
  console.log(`${model}: ${u.calls} calls, ${u.input} in, ${u.output} out, about $${cost.toFixed(3)}${model.startsWith("muse") ? " (Model API credit)" : ""}`);
}
console.log(`Total about $${total.toFixed(2)} in ${((Date.now() - started) / 1000 / 60).toFixed(1)} min.`);

// Our own check, after the agent's: every number in the report must have come from a tool.
const { readFileSync, existsSync } = await import("node:fs");
const reportFile = `${WORKSPACE}${reportPath}`;
const checks = {
  planned: steps.includes("write_todos"),
  delegated: steps.includes("task"),
  replayed: (toolCalls.get("replay_with") ?? 0) > 0,
  wroteReport: existsSync(reportFile),
  numbersAllFromTools: existsSync(reportFile) ? unsupportedNumbers(readFileSync(reportFile, "utf8")).length === 0 : false,
};
if (existsSync(reportFile)) {
  const loose = unsupportedNumbers(readFileSync(reportFile, "utf8"));
  if (loose.length) console.log(`Numbers in the report no tool returned: ${loose.join(", ")}`);
}
console.log("Tool calls, subagents included:", JSON.stringify(Object.fromEntries(toolCalls)));
console.log("Checks:", JSON.stringify(checks));
console.log(`Report: agent/workspace${reportPath}. Trace: smith.langchain.com, project "${process.env.LANGSMITH_PROJECT ?? "default"}".`);

// Send the last trace data before the process ends (otherwise the final calls stay "pending" in LangSmith).
await awaitAllCallbacks();
