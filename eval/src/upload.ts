// npm run upload: send this laptop's rounds (eval/data/rounds) to the shared Supabase table, so the
// whole team's rounds end up in one place. Rounds already there are skipped.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EVAL_DIR, loadDataRounds } from "./store.ts";
import { insertRounds, settings } from "./supabase.ts";

const SENT_FILE = join(EVAL_DIR, "data", "uploaded.json");
const s = await settings();
if (s.error !== null) { console.error(s.error); process.exit(1); }
const sent = new Set<string>(existsSync(SENT_FILE) ? (JSON.parse(readFileSync(SENT_FILE, "utf8")) as string[]) : []);
const todo = loadDataRounds({ withSelftest: true }).rounds.filter((r) => !sent.has(r.id));
const done = await insertRounds(s.data, todo);
if (done.error !== null) { console.error(done.error); process.exit(1); }
for (const r of todo) sent.add(r.id);
writeFileSync(SENT_FILE, JSON.stringify([...sent]));
console.log(`${done.data} rounds sent to Supabase.`);
