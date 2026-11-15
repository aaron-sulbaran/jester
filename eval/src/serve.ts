// npm run serve: replays real players' recordings on bank clips against the bank's guide served in different
// ways (src/serving.ts), and reports per clip what an honest attempt scores, what a frozen copy of the same
// attempt scores (the guard: it must stay at 10 or less), and the credit on the limbs real players lose most on.
// With --what-ifs it instead keeps the guide as served today and tries engine settings for this run only.
// It changes nothing in the game or the engine; it says which way of serving or judging would play better.
//
//   npm run serve                            every serving variant, guides from the live bank
//   npm run serve -- --bank <folder>         guides from a local bank folder (index.json and <id>/guides.json)
//   npm run serve -- --variant steady-ends   as-served and one other variant
//   npm run serve -- --what-ifs              every engine what-if in src/serving.ts (WHAT_IFS)
//   npm run serve -- --what-if angles-20 --what-if POSE.thetaInDeg=25,LIMB.hands=0.25
//                                            today and the named or spelled-out what-ifs
//
// Honest attempts are rounds tagged "nailed", or until enough are tagged, untagged real camera rounds that
// lagged 0.4 s or more (see honestRound). Writes serve-report.md beside this folder's report.md.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scorePoseRound, type PoseRoundOptions, type PoseRoundResult, type PoseTimeline } from "../../engine/src/index.ts";
import type { Guide } from "../../clip/src/types.ts";
import { EXPECT } from "../expectations.ts";
import { transformPlayer } from "./derive.ts";
import { legSwingDeg } from "./judge.ts";
import { fingerprint, packPose, unpackPose, type AnyPackedPose, type RoundRecord } from "./record.ts";
import { EVAL_DIR, loadCases, loadDataRounds } from "./store.ts";
import {
  applySettings, asServed, honestRound, median, turningRate, VARIANTS, variantNamed, WEAK_LIMBS, WHAT_IFS, whatIfNamed,
  type Variant, type WhatIf,
} from "./serving.ts";

type Result<T> = { data: T; error: null } | { data: null; error: string };

const LIVE_BANK = "https://jester-pi.vercel.app/bank/";
const REPORT = join(EVAL_DIR, "serve-report.md");
/** Each honest recording is also scored against this many other clips' people: a wrong dance, done honestly. */
const WRONG_DANCES = 4;
/** "Good" or better. */
const GOOD_MIN = 55;

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

/**
 * An honest round. `reference` is what it was scored on, as recorded; `guide` is the bank part it was played
 * against when the bank still has it (null once the clip's moves were read again since).
 */
interface Played { round: RoundRecord; clip: string; guide: Guide | null; exact: boolean; player: PoseTimeline; reference: PoseTimeline }
type Served = Played & { guide: Guide };

const fmt = (v: number | null | undefined, digits = 0) => (v === null || v === undefined ? "-" : v.toFixed(digits));
const sorted = (xs: readonly number[]) => [...xs].sort((a, b) => a - b);
const limbCredit = (result: PoseRoundResult, limb: string) =>
  (result.perLimb as Record<string, { credit: number } | undefined>)[limb]?.credit;

// ---- Serving variants (the default run) ----

interface Scored { score: number | null; frozen: number | null; limbs: Record<string, number> }

function scoreWith(variant: Variant, p: Served): Scored {
  const reference = variant.serve(p.guide.timeline!);
  const options = p.round.options as PoseRoundOptions;
  const result = scorePoseRound(reference, p.player, options);
  const frozen = scorePoseRound(reference, transformPlayer(p.player, "frozen"), options);
  const limbs: Record<string, number> = {};
  for (const limb of WEAK_LIMBS) {
    const credit = limbCredit(result, limb);
    if (typeof credit === "number") limbs[limb] = credit;
  }
  return { score: result.score, frozen: frozen.score, limbs };
}

function variantReport(all: readonly Played[], variants: readonly Variant[]): string[] {
  const played = all.filter((p): p is Served => p.guide !== null);
  const lines: string[] = [];
  lines.push(`Variants rebuild the reference from the bank's guide, so only the ${played.length} rounds whose part the bank still has are replayed (${all.length - played.length} were played before their clip's moves were read again).`, "");
  for (const v of variants) lines.push(`- **${v.name}**: ${v.about}`);
  lines.push("");
  const scored = new Map<Served, Map<string, Scored>>();
  for (const p of played) scored.set(p, new Map(variants.map((v) => [v.name, scoreWith(v, p)])));
  lines.push(`| clip | pace | n | variant | median score | scores | frozen max | ${WEAK_LIMBS.join(" | ")} |`);
  lines.push(`| --- | --- | --- | --- | --- | --- | --- | ${WEAK_LIMBS.map(() => "---").join(" | ")} |`);
  for (const [clip, ps] of byClip(played)) {
    const pace = paceOf(clip, ps);
    for (const v of variants) {
      const s = ps.map((p) => scored.get(p)!.get(v.name)!);
      const scores = s.map((x) => x.score).filter((x): x is number => x !== null);
      const frozen = s.map((x) => x.frozen ?? 0);
      const limbs = WEAK_LIMBS.map((limb) => fmt(median(s.map((x) => x.limbs[limb]).filter((x): x is number => x !== undefined)), 2));
      lines.push(`| ${clip} | ${pace} | ${ps.length} | ${v.name} | ${fmt(median(scores))} | ${sorted(scores).join(", ")} | ${fmt(frozen.length ? Math.max(...frozen) : null)} | ${limbs.join(" | ")} |`);
    }
  }
  return lines;
}

function byClip<P extends Played>(played: readonly P[]): [string, P[]][] {
  const groups = new Map<string, P[]>();
  for (const p of played) groups.set(p.clip, [...(groups.get(p.clip) ?? []), p]);
  return [...[...groups.entries()].sort(), ["all clips", [...played]]];
}

const paceOf = (clip: string, ps: readonly Played[]) =>
  clip === "all clips" ? "" : [...new Set(ps.map((p) => p.guide?.pace).filter(Boolean))].join(", ") || "-";

// ---- Engine what-ifs ----

interface Person { clip: string; guide: Guide; reference: PoseTimeline }

interface Judged {
  score: number | null;
  frozen: number | null;
  /** Legs hidden; only judged on a clip whose legs swing (as `npm run eval` judges it), else null. */
  seated: number | null;
  /** The same honest recording scored against other clips' people. */
  wrong: { person: Person; score: number | null }[];
  hands: number | null;
  forearms: number | null;
}

const meanOf = (xs: readonly (number | undefined)[]) => {
  const ok = xs.filter((x): x is number => typeof x === "number");
  return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null;
};

/** Up to WRONG_DANCES people from other clips, closest in length to this round's clip (ties by clip id). */
function wrongDancesFor(p: Played, people: readonly Person[]): Person[] {
  const length = (t: PoseTimeline) => t.frames.length;
  const own = length(p.reference);
  return people
    .filter((x) => x.clip !== p.clip)
    .sort((a, b) => Math.abs(length(a.reference) - own) - Math.abs(length(b.reference) - own) || a.clip.localeCompare(b.clip) || a.guide.subject.label.localeCompare(b.guide.subject.label))
    .slice(0, WRONG_DANCES);
}

function judgeRound(p: Played, wrong: readonly Person[], legsSwing: boolean): { judged: Judged; result: PoseRoundResult } {
  const options = p.round.options as PoseRoundOptions;
  const result = scorePoseRound(p.reference, p.player, options);
  return {
    result,
    judged: {
      score: result.score,
      frozen: scorePoseRound(p.reference, transformPlayer(p.player, "frozen"), options).score,
      seated: legsSwing ? scorePoseRound(p.reference, transformPlayer(p.player, "seated"), options).score : null,
      wrong: wrong.map((person) => ({ person, score: scorePoseRound(person.reference, p.player, options).score })),
      hands: meanOf([limbCredit(result, "leftHand"), limbCredit(result, "rightHand")]),
      forearms: meanOf([limbCredit(result, "leftForearm"), limbCredit(result, "rightForearm")]),
    },
  };
}

/** A --what-if value: a preset's name, or settings joined by commas. */
function parseWhatIf(spec: string): WhatIf {
  return whatIfNamed(spec) ?? { name: spec, about: "Spelled out on the command line.", settings: spec.split(",").map((s) => s.trim()).filter(Boolean) };
}

function whatIfReport(played: readonly Played[], people: readonly Person[], whatIfs: readonly WhatIf[]): Result<string[]> {
  const wrong = new Map(played.map((p) => [p, wrongDancesFor(p, people)]));
  const legsSwing = new Map(played.map((p) => [p, legSwingDeg(p.reference) >= EXPECT.seated.legRangeDeg]));
  const judged = new Map<string, Map<Played, Judged>>();
  const why = new Map<Played, PoseRoundResult>();
  for (const w of whatIfs) {
    const applied = applySettings(w.settings);
    if (applied.error !== null) return { data: null, error: `${w.name}: ${applied.error}` };
    try {
      const row = new Map<Played, Judged>();
      for (const p of played) {
        const { judged: j, result } = judgeRound(p, wrong.get(p)!, legsSwing.get(p)!);
        row.set(p, j);
        if (w.settings.length === 0 && !why.has(p)) why.set(p, result);
      }
      judged.set(w.name, row);
    } finally {
      applied.data();
    }
  }

  const lines: string[] = [];
  lines.push(`Each honest round is scored on the reference it was played against, as recorded. Guards: a frozen copy must score ${EXPECT.derived.frozenMaxScore} or less, and a copy with the legs out of view ${EXPECT.derived.seatedMaxScore} or less on the ${[...legsSwing.values()].filter(Boolean).length} rounds whose clip swings the legs ${EXPECT.seated.legRangeDeg} degrees or more. "Wrong dance" scores each honest recording against ${WRONG_DANCES} other clips' people, the closest in length: a real person moving honestly, to the wrong moves. Gap is the honest median minus the wrong-dance median; a setting that lifts honest rounds should not shrink it.`, "");
  for (const w of whatIfs) lines.push(`- **${w.name}**: ${w.about}${w.settings.length ? ` (${w.settings.join(", ")})` : ""}`);
  lines.push("", "## All clips", "");
  lines.push(`Frozen max must stay ${EXPECT.derived.frozenMaxScore} or less. The seated and wrong-dance counts should not rise over today's; today's are already too high (see the last two sections).`, "");
  lines.push(`| what-if | honest median | ${GOOD_MIN}+ | lowest | frozen max | seated over ${EXPECT.derived.seatedMaxScore} | seated max | wrong-dance median | wrong dances ${GOOD_MIN}+ | wrong-dance max | gap | hands credit | forearms credit |`);
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const w of whatIfs) {
    const row = [...judged.get(w.name)!.values()];
    const scores = row.map((j) => j.score).filter((x): x is number => x !== null);
    const frozen = Math.max(0, ...row.map((j) => j.frozen ?? 0));
    const seatedScores = row.map((j) => j.seated).filter((x): x is number => x !== null);
    const seated = seatedScores.length ? Math.max(...seatedScores) : null;
    const wrongs = row.flatMap((j) => j.wrong.map((x) => x.score ?? 0));
    const honest = median(scores);
    const wrongMedian = median(wrongs);
    const good = scores.filter((s) => s >= GOOD_MIN).length;
    const seatedOver = seatedScores.filter((x) => x > EXPECT.derived.seatedMaxScore).length;
    const wrongGood = wrongs.filter((x) => x >= GOOD_MIN).length;
    lines.push(`| ${w.name} | ${fmt(honest)} | ${good} of ${scores.length} | ${sorted(scores).slice(0, 5).join(", ")} | ${frozen}${frozen > EXPECT.derived.frozenMaxScore ? " (too high)" : ""} | ${seatedOver} of ${seatedScores.length} | ${fmt(seated)} | ${fmt(wrongMedian)} | ${wrongGood} of ${wrongs.length} | ${wrongs.length ? Math.max(...wrongs) : "-"} | ${honest !== null && wrongMedian !== null ? fmt(honest - wrongMedian) : "-"} | ${fmt(median(row.map((j) => j.hands).filter((x): x is number => x !== null)), 2)} | ${fmt(median(row.map((j) => j.forearms).filter((x): x is number => x !== null)), 2)} |`);
  }

  lines.push("", "## Honest median by clip", "");
  lines.push(`Turning is a rough difficulty (degrees per second the clip's limbs turn, src/serving.ts turningRate): the bank has no difficulty rating. A fair engine should score busier clips somewhat lower, never a plain copy of an easy clip low.`, "");
  lines.push(`| clip | pace | turning (deg/s) | n | ${whatIfs.map((w) => w.name).join(" | ")} |`);
  lines.push(`| --- | --- | --- | --- | ${whatIfs.map(() => "---").join(" | ")} |`);
  for (const [clip, ps] of byClip(played).filter(([c]) => c !== "all clips")) {
    const pace = paceOf(clip, ps);
    const turning = median(ps.map((p) => turningRate(p.reference)).filter((x): x is number => x !== null));
    const cells = whatIfs.map((w) => fmt(median(ps.map((p) => judged.get(w.name)!.get(p)!.score).filter((x): x is number => x !== null))));
    lines.push(`| ${clip} | ${pace} | ${fmt(turning)} | ${ps.length} | ${cells.join(" | ")} |`);
  }

  lines.push("", "## Why each honest round scored what it did (today)", "");
  lines.push("| clip | part | score | lag ms | timing | accuracy | still would earn | moving gate | hidden limbs | worst limb |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const today = [...why.entries()].sort(([a, ra], [b, rb]) => a.clip.localeCompare(b.clip) || (ra.score ?? -1) - (rb.score ?? -1));
  for (const [p, r] of today) {
    lines.push(`| ${p.clip} | ${p.round.clip.subject ?? p.guide?.subject.label ?? "-"} | ${fmt(r.score)} | ${fmt(r.lagMs)} | ${fmt(r.timing, 2)} | ${fmt(r.accuracy, 2)} | ${fmt(r.stillBaseline, 2)} | ${fmt(r.motion.gate, 2)} | ${r.hiddenLimbs.join(", ") || "-"} | ${r.worstLimb?.limb ?? "-"} |`);
  }

  const todayJudged = judged.get(whatIfs[0]!.name)!;
  lines.push("", `## Seated copies over ${EXPECT.derived.seatedMaxScore} (today)`, "");
  lines.push("Legs hidden, nothing else changed. The hidden-limb cap only counts a limb the clip moves at least half as much as its busiest limb (POSE.hiddenActiveMin), and dances move the arms most, so hidden legs only cost a little accuracy.", "");
  lines.push("| clip | part | honest | seated |");
  lines.push("| --- | --- | --- | --- |");
  for (const [p, j] of [...todayJudged.entries()].filter(([, j]) => (j.seated ?? 0) > EXPECT.derived.seatedMaxScore)) {
    lines.push(`| ${p.clip} | ${p.round.clip.subject ?? "-"} | ${fmt(j.score)} | ${fmt(j.seated)} |`);
  }

  lines.push("", "## Highest wrong-dance scores (today)", "");
  lines.push("A wrong dance scoring well usually means the other part is calm: when standing still already earns more than 1 - ROUND.minHeadroom, the engine scores plain accuracy, so anyone who moves at all scores high there.", "");
  lines.push("| played on | scored against | score |");
  lines.push("| --- | --- | --- |");
  const pairs = [...todayJudged.entries()].flatMap(([p, j]) => j.wrong.map((x) => ({ p, ...x })));
  for (const x of pairs.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 6)) {
    lines.push(`| ${x.p.clip} (${x.p.round.clip.subject ?? "-"}) | ${x.person.clip} (${x.person.guide.subject.label}) | ${fmt(x.score)} |`);
  }
  return { data: lines, error: null };
}

// ---- Main ----

function flagValues(args: readonly string[], flag: string): string[] {
  const values: string[] = [];
  args.forEach((a, i) => { if (a === flag && args[i + 1] !== undefined) values.push(args[i + 1]!); });
  return values;
}

async function main() {
  const args = process.argv.slice(2);
  const folder = flagValues(args, "--bank")[0] ?? null;
  const variantAt = args.indexOf("--variant");
  const variants: Variant[] = variantAt >= 0
    ? [VARIANTS[0]!, ...[variantNamed(args[variantAt + 1] ?? "")].filter((v): v is Variant => v !== null && v.name !== "as-served")]
    : [...VARIANTS];
  if (variantAt >= 0 && variants.length < 2) {
    console.error(`Unknown variant "${args[variantAt + 1] ?? ""}". Known: ${VARIANTS.map((v) => v.name).join(", ")}`);
    process.exit(1);
  }
  const asked = flagValues(args, "--what-if").map(parseWhatIf);
  const whatIfs: WhatIf[] | null = args.includes("--what-ifs")
    ? [...WHAT_IFS, ...asked]
    : asked.length ? [WHAT_IFS[0]!, ...asked] : null;

  const bank = await loadBank(folder && existsSync(folder) ? folder : null);
  if (bank.error !== null) { console.error(bank.error); process.exit(1); }
  const keys = new Map<Guide, string>();
  const people: Person[] = [];
  for (const [clip, { guides }] of bank.data) {
    for (const g of guides) {
      if (g.subject.kind !== "person" || !g.timeline) continue;
      const reference = asServed(g.timeline);
      keys.set(g, fingerprint(packPose(reference)));
      people.push({ clip, guide: g, reference });
    }
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
    const part = clip ? partOf(r, clip.guides, keys) : null;
    played.push({
      round: r, clip: r.clip.bankId!, guide: part?.guide ?? null, exact: part?.exact ?? false,
      player: unpackPose(r.player), reference: unpackPose(r.reference as AnyPackedPose),
    });
  }

  // Sanity: as-served must rebuild exactly the reference each exact-matched round was scored on.
  let checked = 0, worst = 0;
  for (const p of played.filter((x) => x.exact)) {
    const stored = scorePoseRound(p.reference, p.player, p.round.options as PoseRoundOptions).score;
    const rebuilt = scorePoseRound(asServed(p.guide!.timeline!), p.player, p.round.options as PoseRoundOptions).score;
    if (stored !== null && rebuilt !== null) { checked++; worst = Math.max(worst, Math.abs(stored - rebuilt)); }
  }

  const lines: string[] = [];
  lines.push(whatIfs ? "# Serving replay: engine what-ifs" : "# Serving replay", "");
  lines.push(`${played.length} honest attempts on bank clips (${played.filter((p) => honestRound(p.round) === "nailed").length} tagged nailed), from ${seen.size} rounds. Frozen copies must score ${EXPECT.derived.frozenMaxScore} or less.`);
  lines.push(`Check: as-served rebuilds the recorded reference for ${played.filter((p) => p.exact).length} of them; re-scored ${checked}, largest difference ${worst} points.`);
  lines.push(`Left out: ${Object.entries(left).map(([why, n]) => `${n} ${why}`).join("; ") || "none"}.`, "");
  if (whatIfs) {
    const report = whatIfReport(played, people, whatIfs);
    if (report.error !== null) { console.error(report.error); process.exit(1); }
    lines.push(...report.data);
  } else {
    lines.push(...variantReport(played, variants));
  }
  const text = lines.join("\n") + "\n";
  writeFileSync(REPORT, text);
  console.log(text);
}

await main();
