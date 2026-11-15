// npm run freeze -- r-abc123-xyz r-...   copy these local rounds into eval/cases (committed)
// npm run freeze -- --tagged             copy every local round that has a dev test tag
//
// Frozen cases are what `npm run eval` holds the engine to. Pose data only.

import { freezeRound, isFrozen, loadDataRounds } from "./store.ts";
import { clipName } from "./judge.ts";

const args = process.argv.slice(2);
const { rounds } = loadDataRounds();
const wanted = args.includes("--tagged")
  ? rounds.filter((r) => r.tag !== null && !isFrozen(r.id))
  : rounds.filter((r) => args.includes(r.id));

const missing = args.filter((a) => a.startsWith("r-") && !rounds.some((r) => r.id === a));
if (missing.length) console.error(`Not in eval/data/rounds: ${missing.join(", ")}`);
if (!args.length) console.error("Name round ids, or pass --tagged.");

let frozen = 0;
for (const r of wanted) {
  const done = freezeRound(r);
  if (done.error !== null) { console.log(`skip ${done.error}`); continue; }
  frozen++;
  console.log(`froze ${r.id}  ${r.tag ?? "(no tag)"}  ${clipName(r)}  score ${r.result.score ?? "none"}`);
}
console.log(`${frozen} frozen. Then: npm run eval, and once it reads right, npm run eval -- --save`);
if (missing.length || !args.length) process.exit(1);
