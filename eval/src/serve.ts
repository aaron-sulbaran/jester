// npm run serve: replays real players' recordings on bank clips against the bank's guide served in different
// ways (src/serving.ts), and reports per clip what an honest attempt scores, what a frozen copy of the same
// attempt scores (the guard: it must stay at 10 or less), and the credit on the limbs real players lose most on.
// It changes nothing in the game or the engine; it says which way of serving the guide would play better.
//
//   npm run serve                            every variant, guides from the live bank
//   npm run serve -- --bank <folder>         guides from a local bank folder (index.json and <id>/guides.json)
//   npm run serve -- --variant steady-ends   as-served and one other variant
//
// Honest attempts are rounds tagged "nailed", or until enough are tagged, untagged real camera rounds that
// lagged 0.4 s or more (see honestRound). Writes serve-report.md beside this folder's report.md.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scorePoseRound, type PoseRoundOptions, type PoseRoundResult, type PoseTimeline } from "../../engine/src/index.ts";
import type { Guide } from "../../clip/src/types.ts";
import { EXPECT } from "../expectations.ts";
import { transformPlayer } from "./derive.ts";
import { fingerprint, packPose, unpackPose, type AnyPackedPose, type RoundRecord } from "./record.ts";
import { EVAL_DIR, loadCases, loadDataRounds } from "./store.ts";
import { asServed, honestRound, median, VARIANTS, variantNamed, WEAK_LIMBS, type Variant } from "./serving.ts";

type Result<T> = { data: T; error: null } | { data: null; error: string };

const LIVE_BANK = "https://jester-pi.vercel.app/bank/";
const REPORT = join(EVAL_DIR, "serve-report.md");

interface BankClip { id: string; title: string; guides: string }

/** The bank's clips and each one's guides, from a local folder or the live site. */
async function loadBank(folder: string | null): Promise<Result<Map<string, { title: string; guides: Guide[] }>>> {
  const read = async (path: string): Promise<unknown> => {
    if (folder) return JSON.parse(readFileSync(join(folder, path), "utf8"));
    const response = await fetch(LIVE_BANK + path, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response.json();
  };
  try {
    const index = (await read("index.json")) as { clips: BankClip[] };
    const bank = new Map<string, { title: string; guides: Guide[] }>();
    for (const clip of index.clips) bank.set(clip.id, { title: clip.title, guides: (await read(clip.guides)) as Guide[] });
    return { data: bank, error: null };
  } catch (error) {
    return { data: null, error: `Could not read the bank ${folder ?? LIVE_BANK}: ${(error as Error).message}` };
  }
}

/** The person guide a round was played against: the one whose as-served timeline has the round's fingerprint, else by label. */
function partOf(r: RoundRecord, guides: readonly Guide[], keys: Map<Guide, string>): { guide: Guide; exact: boolean } | null {
  const people = guides.filter((g) => g.subject.kind === "person" && g.timeline);
  const exact = people.find((g) => keys.get(g) === r.clip.key);
  if (exact) return { guide: exact, exact: true };
  const label = (r.clip.subject ?? "").toLowerCase();
  const byLabel = people.find((g) => g.subject.label.toLowerCase() === label);
  return byLabel ? { guide: byLabel, exact: false } : null;
}

interface Played { round: RoundRecord; guide: Guide; exact: boolean; player: PoseTimeline }

interface Scored { score: number | null; frozen: number | null; limbs: Record<string, number> }

function scoreWith(variant: Variant, p: Played): Scored {
  const reference = variant.serve(p.guide.timeline!);
  const options = p.round.options as PoseRoundOptions;
  const result: PoseRoundResult = scorePoseRound(reference, p.player, options);
  const frozen = scorePoseRound(reference, transformPlayer(p.player, "frozen"), options);
  const limbs: Record<string, number> = {};
  for (const limb of WEAK_LIMBS) {
    const credit = (result.perLimb as Record<string, { credit: number } | undefined> | undefined)?.[limb]?.credit;
    if (typeof credit === "number") limbs[limb] = credit;
  }
  return { score: result.score, frozen: frozen.score, limbs };
}

const fmt = (v: number | null, digits = 0) => (v === null ? "-" : v.toFixed(digits));

async function main() {
  const args = process.argv.slice(2);
  const folderAt = args.indexOf("--bank");
  const folder = folderAt >= 0 ? args[folderAt + 1] ?? null : null;
  const variantAt = args.indexOf("--variant");
  const variants: Variant[] = variantAt >= 0
    ? [VARIANTS[0]!, ...[variantNamed(args[variantAt + 1] ?? "")].filter((v): v is Variant => v !== null && v.name !== "as-served")]
    : [...VARIANTS];
  if (variantAt >= 0 && variants.length < 2) {
    console.error(`Unknown variant "${args[variantAt + 1] ?? ""}". Known: ${VARIANTS.map((v) => v.name).join(", ")}`);
    process.exit(1);
  }

  const bank = await loadBank(folder && existsSync(folder) ? folder : null);
  if (bank.error !== null) { console.error(bank.error); process.exit(1); }
  const keys = new Map<Guide, string>();
  for (const { guides } of bank.data.values()) {
    for (const g of guides) if (g.subject.kind === "person" && g.timeline) keys.set(g, fingerprint(packPose(asServed(g.timeline))));
  }

  const rounds = [...loadDataRounds().rounds, ...loadCases().rounds];
  const seen = new Set<string>();
  const played: Played[] = [];
  const left: Record<string, number> = {};
  const skip = (why: string) => { left[why] = (left[why] ?? 0) + 1; };
  for (const r of rounds) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    if (!honestRound(r)) { skip("not an honest attempt on a bank clip (tag, camera, lag or channel)"); continue; }
    const clip = bank.data.get(r.clip.bankId!);
    if (!clip) { skip("clip no longer in the bank"); continue; }
    const part = partOf(r, clip.guides, keys);
    if (!part) { skip("part not found in the bank guide"); continue; }
    played.push({ round: r, guide: part.guide, exact: part.exact, player: unpackPose(r.player) });
  }

  // Sanity: as-served must rebuild exactly the reference each exact-matched round was scored on.
  let checked = 0, worst = 0;
  for (const p of played.filter((x) => x.exact)) {
    const stored = scorePoseRound(unpackPose(p.round.reference as AnyPackedPose), p.player, p.round.options as PoseRoundOptions).score;
    const rebuilt = scorePoseRound(asServed(p.guide.timeline!), p.player, p.round.options as PoseRoundOptions).score;
    if (stored !== null && rebuilt !== null) { checked++; worst = Math.max(worst, Math.abs(stored - rebuilt)); }
  }

  const scored = new Map<Played, Map<string, Scored>>();
  for (const p of played) scored.set(p, new Map(variants.map((v) => [v.name, scoreWith(v, p)])));

  const lines: string[] = [];
  lines.push("# Serving replay", "");
  lines.push(`${played.length} honest attempts on bank clips (${played.filter((p) => honestRound(p.round) === "nailed").length} tagged nailed), from ${seen.size} rounds. Frozen copies must score ${EXPECT.derived.frozenMaxScore} or less.`);
  lines.push(`Check: as-served rebuilds the recorded reference for ${played.filter((p) => p.exact).length} of them; re-scored ${checked}, largest difference ${worst} points.`);
  lines.push(`Left out: ${Object.entries(left).map(([why, n]) => `${n} ${why}`).join("; ") || "none"}.`, "");
  for (const v of variants) lines.push(`- **${v.name}**: ${v.about}`);
  lines.push("");

  const byClip = new Map<string, Played[]>();
  for (const p of played) byClip.set(p.round.clip.bankId!, [...(byClip.get(p.round.clip.bankId!) ?? []), p]);
  const groups: [string, Played[]][] = [...[...byClip.entries()].sort(), ["all clips", played]];
  lines.push(`| clip | pace | n | variant | median score | scores | frozen max | ${WEAK_LIMBS.join(" | ")} |`);
  lines.push(`| --- | --- | --- | --- | --- | --- | --- | ${WEAK_LIMBS.map(() => "---").join(" | ")} |`);
  for (const [clip, ps] of groups) {
    const pace = clip === "all clips" ? "" : [...new Set(ps.map((p) => p.guide.pace))].join(", ");
    for (const v of variants) {
      const s = ps.map((p) => scored.get(p)!.get(v.name)!);
      const scores = s.map((x) => x.score).filter((x): x is number => x !== null);
      const frozen = s.map((x) => x.frozen ?? 0);
      const limbs = WEAK_LIMBS.map((limb) => fmt(median(s.map((x) => x.limbs[limb]).filter((x): x is number => x !== undefined)), 2));
      lines.push(`| ${clip} | ${pace} | ${ps.length} | ${v.name} | ${fmt(median(scores))} | ${[...scores].sort((a, b) => a - b).join(", ")} | ${fmt(frozen.length ? Math.max(...frozen) : null)} | ${limbs.join(" | ")} |`);
    }
  }
  const text = lines.join("\n") + "\n";
  writeFileSync(REPORT, text);
  console.log(text);
}

await main();
