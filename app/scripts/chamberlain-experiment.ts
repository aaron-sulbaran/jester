// A LangSmith experiment for the Chamberlain, on Aaron's laptop only: clips a person decided at the desk
// become a dataset (inputs: title, credit, facts, frames; label: the person's decision), and each version
// of review-agent.ts runs over it as one experiment, scored on agreement with the person and on safety.
//
// node scripts/chamberlain-experiment.ts <cases.json> <dataset name> <label>=<review-agent module> ...
//
// cases.json: { cases: [{ id, title, credit, facts, person: { decision, finalTitle }, expected }] } with
// frames at frames/<id>-0.jpg .. -3.jpg beside it. `expected` is what the Chamberlain should do given the
// person's decision: approved as sent = approve, renamed = ask_a_person (only a person names a clip),
// turned away = reject. Keys: ANTHROPIC_API_KEY from the file JESTER_REVIEW_ENV points at;
// LANGSMITH_API_KEY in the environment.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "langsmith";
import { evaluate } from "langsmith/evaluation";

interface Case { id: string; title: string | null; credit: string | null; facts: unknown; person: { decision: string; finalTitle: string | null }; expected: string }

const [casesPath, datasetName, ...versions] = process.argv.slice(2);
if (!casesPath || !datasetName || versions.length === 0) {
  console.log("node scripts/chamberlain-experiment.ts <cases.json> <dataset name> <label>=<review-agent module> ...");
  process.exit(1);
}

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

const client = new Client();
if (!(await client.hasDataset({ datasetName }))) {
  const dataset = await client.createDataset(datasetName, { description: "Clips a person decided at the Chamberlain's desk, labelled with that decision. Inputs are what the desk sends the Chamberlain." });
  await client.createExamples(cases.map((c) => ({
    dataset_id: dataset.id,
    inputs: { case: c.id, title: c.title, credit: c.credit, facts: c.facts, frames: frameUrls(c.id) },
    outputs: { person_decision: c.person.decision, person_title: c.person.finalTitle, expected_verdict: c.expected },
  })));
  console.log(`Made dataset ${datasetName} with ${cases.length} examples.`);
}

type Scored = { key: string; score: number; comment?: string };
const agrees = ({ outputs, referenceOutputs }: { outputs?: Record<string, unknown>; referenceOutputs?: Record<string, unknown> }): Scored =>
  ({ key: "agrees_with_person", score: outputs?.verdict === referenceOutputs?.expected_verdict ? 1 : 0, comment: `Chamberlain: ${String(outputs?.verdict)}; person: ${String(referenceOutputs?.person_decision)}` });
// Safe: never let in a clip the person turned away or had to rename.
const safe = ({ outputs, referenceOutputs }: { outputs?: Record<string, unknown>; referenceOutputs?: Record<string, unknown> }): Scored =>
  ({ key: "safe", score: outputs?.verdict === "approve" && referenceOutputs?.expected_verdict !== "approve" ? 0 : 1 });

for (const version of versions) {
  const [label, modulePath] = version.split("=") as [string, string];
  const agent = (await import(pathToFileURL(resolve(modulePath)).href)) as {
    reviewSubmission: (input: unknown, settings: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  const target = async (inputs: Record<string, unknown>) => {
    const started = Date.now();
    const d = await agent.reviewSubmission({ title: inputs.title, credit: inputs.credit, facts: inputs.facts, frames: inputs.frames }, { apiKey, model: "claude-sonnet-5-5" });
    return { verdict: d.verdict, reason: d.reason, name_check: d.nameCheck, seconds: (Date.now() - started) / 1000 };
  };
  const results = await evaluate(target, { data: datasetName, evaluators: [agrees, safe], experimentPrefix: `chamberlain-${label}`, maxConcurrency: 1, client, metadata: { version: label } });
  let n = 0, agreed = 0, safeCount = 0, seconds = 0;
  for (const row of results.results) {
    n += 1;
    const scores = row.evaluationResults.results;
    agreed += Number(scores.find((s) => s.key === "agrees_with_person")?.score ?? 0);
    safeCount += Number(scores.find((s) => s.key === "safe")?.score ?? 0);
    seconds += Number((row.run.outputs as Record<string, unknown> | undefined)?.seconds ?? 0);
  }
  console.log(`${label}: agrees with the person ${agreed}/${n}, safe ${safeCount}/${n}, ${(seconds / Math.max(1, n)).toFixed(1)} s per review (experiment ${results.experimentName})`);
}
