// npm run pull: download every round in the shared Supabase table into eval/data/rounds.

import { saveDataRound } from "./store.ts";
import { fetchRounds, settings } from "./supabase.ts";

const s = settings();
if (s.error !== null) { console.error(s.error); process.exit(1); }
const rounds = await fetchRounds(s.data);
if (rounds.error !== null) { console.error(rounds.error); process.exit(1); }
const added = rounds.data.filter(saveDataRound).length;
console.log(`${rounds.data.length} rounds in Supabase, ${added} new here. Next: npm run eval`);
