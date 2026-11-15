// npm run pull: download the rounds in the shared Supabase table that this laptop does not have yet into
// eval/data/rounds. Lists ids first, then fetches the missing records ten at a time.

import { localRoundIds, saveDataRound } from "./store.ts";
import { fetchRecords, listRoundIds, settings } from "./supabase.ts";

const s = await settings();
if (s.error !== null) { console.error(s.error); process.exit(1); }
const ids = await listRoundIds(s.data);
if (ids.error !== null) { console.error(ids.error); process.exit(1); }
const have = localRoundIds();
const missing = ids.data.filter((id) => !have.has(id));
const got = await fetchRecords(s.data, missing, saveDataRound);
if (got.error !== null) { console.error(got.error); process.exit(1); }
console.log(`${ids.data.length} rounds in Supabase, ${got.data} new here. Next: npm run eval`);
