// Runs the cast checker (cast-checker.ts) over bank clips, on Aaron's laptop only:
//   npm run check-cast -- [--bank <folder>] [--clip <id>[,<id>...]] [--frames 12] [--parallel 3]
// The bank defaults to JESTER_BANK_DIR, else ~/Personal Projects/hack-princeton/jester-deploy/bank. The key is
// ANTHROPIC_API_KEY from the file JESTER_REVIEW_ENV points at (else .env.review beside the bank folder).
//
// For each clip it writes frames, crops and result.json to cast-checks/<id>/ beside the bank folder, and a table
// of every clip to cast-checks/summary.md and summary.json. That folder must be outside every git checkout: the
// frames show real people. It never changes the bank.
//
// It calls Anthropic directly and never traces: with a LangChain tracing switch (LANGSMITH_TRACING and the like)
// set in the shell, each clip is refused by the Chamberlain's tracingRefusal (see cast-checker.ts).

import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { castFrames, readGuides, videoIn } from "../castFrames.ts";
import { CastUsageMeter, checkCast, DEFAULT_MODEL, readEnvFile, type CastResult, type Usage, type Who } from "../cast-checker.ts";
import { checkoutAround } from "../review-cases.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const bank = resolve(arg("bank") ?? process.env.JESTER_BANK_DIR ?? join(homedir(), "Personal Projects/hack-princeton/jester-deploy/bank"));
const out = resolve(arg("out") ?? join(dirname(bank), "cast-checks"));
/** Frames per clip: 12 by default, kept between 4 and 24 so a typo cannot send hundreds of images. */
const frameCount = Math.min(24, Math.max(4, Math.round(Number(arg("frames") ?? "12")) || 12));
const parallel = Math.max(1, Number(arg("parallel") ?? "3"));
const envPath = process.env.JESTER_REVIEW_ENV ?? join(dirname(bank), ".env.review");

if (!existsSync(bank)) { console.log(`No bank folder at ${bank}.`); process.exit(1); }
if (checkoutAround(out)) { console.log(`Refusing to write to ${out}: it is inside the git checkout ${checkoutAround(out)}, and the frames show real people.`); process.exit(1); }
// Never into the bank: not the bank folder itself, nothing inside it, and not a folder that holds it.
const realOrSelf = (p: string) => { try { return realpathSync(p); } catch { return p; } };
const realBank = realOrSelf(bank), realOut = realOrSelf(out);
if (realOut === realBank || realOut.startsWith(realBank + "/") || realBank.startsWith(realOut + "/")) { console.log("Refusing to write into the bank folder, inside it, or into a folder that holds it."); process.exit(1); }

const env = readEnvFile(envPath);
const apiKey = env.ANTHROPIC_API_KEY;
if (!apiKey) { console.log(`No ANTHROPIC_API_KEY in ${envPath} (set JESTER_REVIEW_ENV to the env file).`); process.exit(1); }


/** Claude Sonnet 5.5 on the Anthropic API, dollars per million tokens. */
const PRICE = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 };

/** Dollars, at Anthropic API prices. LangChain's input count includes cache reads and writes. */
const costOf = (u: Usage) => ((u.input - u.cacheRead - u.cacheWrite) * PRICE.input + u.cacheWrite * PRICE.cacheWrite + u.cacheRead * PRICE.cacheRead + u.output * PRICE.output) / 1e6;

const wanted = arg("clip")?.split(",").map((s) => s.trim()).filter(Boolean);
/** Bank clip ids, as the desk writes them: lower-case words joined by single dashes. */
const BANK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const clips = readdirSync(bank).filter((d) => BANK_ID.test(d) && existsSync(join(bank, d, "guides.json")) && videoIn(join(bank, d)) && (!wanted || wanted.includes(d))).sort();
if (wanted) for (const w of wanted) if (!clips.includes(w)) console.log(`No clip ${w} in ${bank}.`);
if (clips.length === 0) { console.log("No clips to check."); process.exit(1); }

mkdirSync(out, { recursive: true });
console.log(`Checking ${clips.length} clip${clips.length === 1 ? "" : "s"} from ${bank} with ${DEFAULT_MODEL} on Anthropic, untraced. Results go to ${out}.`);

interface Row { id: string; result: CastResult | null; error: string | null; seconds: number; usage: Usage; byAgent: Record<Who, Usage>; cost: number }

async function one(id: string): Promise<Row> {
  const started = Date.now();
  const meter = new CastUsageMeter();
  const dir = join(out, id);
  try {
    mkdirSync(dir, { recursive: true });
    const realDir = realOrSelf(dir);
    if (realDir === realBank || realDir.startsWith(realBank + "/")) throw new Error("its output folder leads into the bank folder, so nothing was written");
    const guides = readGuides(join(bank, id));
    const frames = await castFrames(join(bank, id), join(dir, "frames"), frameCount);
    const result = await checkCast(guides, frames, {
      apiKey,
      meter,
      tags: ["cast-checker"], metadata: { clip: id }, runName: `cast-check ${id}`,
    });
    const row: Row = { id, result, error: null, seconds: (Date.now() - started) / 1000, usage: meter.total(), byAgent: meter.by, cost: costOf(meter.total()) };
    writeFileSync(join(dir, "result.json"), JSON.stringify({ ...row, model: DEFAULT_MODEL, provider: "anthropic", at: new Date().toISOString() }, null, 2));
    console.log(`${id}: ${result.verdict === "clear" ? "clear for play" : "ask Aaron"} (cast ${result.peopleInCast}p ${result.thingsInCast}t, seen ${result.peopleSeen ?? "?"}p ${result.thingsSeen ?? "?"}t) in ${row.seconds.toFixed(0)} s, $${row.cost.toFixed(3)}`);
    return row;
  } catch (err) {
    const error = (err as Error).message;
    console.log(`${id}: could not check: ${error}`);
    return { id, result: null, error, seconds: (Date.now() - started) / 1000, usage: meter.total(), byAgent: meter.by, cost: costOf(meter.total()) };
  }
}

const rows: Row[] = new Array(clips.length);
let next = 0;
await Promise.all(Array.from({ length: Math.min(parallel, clips.length) }, async () => {
  while (next < clips.length) { const i = next++; rows[i] = await one(clips[i]!); }
}));

const cell = (s: string) => s.replace(/\|/g, "/").replace(/\n/g, " ");
const lines = [
  `# Cast checks`,
  "",
  `${new Date().toISOString()}, ${clips.length} clips from \`${bank}\`, model ${DEFAULT_MODEL} on Anthropic, untraced. Cost at Anthropic API prices.`,
  "",
  "| Clip | Cast (people, things) | Seen (people, things) | Verdict | Why | Model calls | Tokens in / out | Cost | Time |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ...rows.map((r) => r.result
    ? `| ${r.id} | ${r.result.peopleInCast}, ${r.result.thingsInCast} | ${r.result.peopleSeen ?? "?"}, ${r.result.thingsSeen ?? "?"} | ${r.result.verdict === "clear" ? "clear for play" : "ask Aaron"} | ${cell(r.result.why.join(" ") || r.result.modelReason)} | ${r.usage.calls} | ${r.usage.input} / ${r.usage.output} | $${r.cost.toFixed(3)} | ${r.seconds.toFixed(0)} s |`
    : `| ${r.id} | | | could not check | ${cell(r.error ?? "")} | ${r.usage.calls} | ${r.usage.input} / ${r.usage.output} | $${r.cost.toFixed(3)} | ${r.seconds.toFixed(0)} s |`),
  "",
  `Total: ${rows.reduce((a, r) => a + r.usage.calls, 0)} model calls, $${rows.reduce((a, r) => a + r.cost, 0).toFixed(2)}, ${rows.filter((r) => r.result?.verdict === "clear").length} clear, ${rows.filter((r) => r.result?.verdict === "ask_a_person").length} ask Aaron, ${rows.filter((r) => !r.result).length} not checked.`,
  "",
  "Model calls per agent, all clips: " + (["cast-checker", "person-checker", "thing-checker", "recounter"] as Who[]).map((w) => `${w} ${rows.reduce((a, r) => a + r.byAgent[w].calls, 0)}`).join(", ") + ".",
];
writeFileSync(join(out, "summary.md"), lines.join("\n") + "\n");
writeFileSync(join(out, "summary.json"), JSON.stringify(rows.map((r) => ({
  id: r.id, verdict: r.result?.verdict ?? null, error: r.error,
  peopleInCast: r.result?.peopleInCast ?? null, thingsInCast: r.result?.thingsInCast ?? null,
  peopleSeen: r.result?.peopleSeen ?? null, thingsSeen: r.result?.thingsSeen ?? null,
  why: r.result?.why ?? [], seconds: r.seconds, cost: r.cost, usage: r.usage, byAgent: r.byAgent,
})), null, 2));
console.log(`\n${lines.slice(4).join("\n")}\n\nWrote ${join(out, "summary.md")}.`);
