// npm run traces: the latest runs of the referee coach's LangSmith project, read back with the LangSmith SDK, so a
// session without the LangSmith MCP can still check what the agent did. Prints names, status, tokens and errors.
//   npm run traces -- 3      the last 3 top-level runs (default 1), each with its child runs

import { Client } from "langsmith";

const project = process.env.LANGSMITH_PROJECT ?? "jester-referee-coach";
const count = Number(process.argv[2] ?? 1);
const client = new Client();

const roots = [];
for await (const run of client.listRuns({ projectName: project, isRoot: true, limit: count })) roots.push(run);
if (!roots.length) { console.error(`No runs in LangSmith project "${project}".`); process.exit(1); }

for (const root of roots) {
  const seconds = root.end_time && root.start_time ? ((new Date(root.end_time).getTime() - new Date(root.start_time).getTime()) / 1000).toFixed(0) : "?";
  console.log(`\n${root.name}  ${root.status}  ${seconds} s  tokens ${root.total_tokens ?? "?"}  trace ${root.trace_id}${root.error ? "  ERROR " + root.error.slice(0, 200) : ""}`);
  const children = [];
  for await (const run of client.listRuns({ projectName: project, traceId: root.trace_id })) children.push(run);
  children.sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));
  for (const run of children) {
    if (run.id === root.id) continue;
    const model = (run.extra as { metadata?: { ls_model_name?: string } } | undefined)?.metadata?.ls_model_name;
    if (run.run_type !== "llm" && run.run_type !== "tool") continue;
    console.log(`  ${run.run_type.padEnd(4)} ${run.name}${model ? " [" + model + "]" : ""}  ${run.status}${run.total_tokens ? "  " + run.total_tokens + " tokens" : ""}${run.error ? "  ERROR " + run.error.slice(0, 160) : ""}`);
  }
}
