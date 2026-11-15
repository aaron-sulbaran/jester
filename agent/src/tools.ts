// The referee coach's tools. Each one runs the real, deterministic scorer through eval/src; none of them asks a
// model for a number. They read the round log and write nothing to the repo. Raw pose data never reaches a model.
// Every tool's output is also kept in `corpus`, so check_numbers can tell whether a number in the report came from
// a tool (the agent proposes, the replay proves).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { SCORER_VERSION, constants, type PoseRoundResult, type TrajectoryRoundResult } from "../../engine/src/index.ts";
import { clipName, judge, rescore, setConstant, type Rescored, type Verdict } from "../../eval/src/judge.ts";
import { deriveAll, deriveCase, TRANSFORMS, type Transform } from "../../eval/src/derive.ts";
import { isFrozen, loadCases, loadDataRounds } from "../../eval/src/store.ts";
import { unpackPose, type AnyPackedPose } from "../../eval/src/record.ts";

export const WORKSPACE = join(import.meta.dirname, "..", "workspace");

// ---- What every tool said this run ----

const corpus: string[] = [];
/** How often each tool ran this run, subagents included. */
export const toolCalls = new Map<string, number>();
const recorded = (name: string, text: string) => {
  corpus.push(text);
  toolCalls.set(name, (toolCalls.get(name) ?? 0) + 1);
  return text;
};

const round2 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

// ---- The round log, re-scored ----

/** "camera" for a person in front of a webcam; "simulated" for the built-in stand-in player, which moves too evenly to tell a real player's habits. */
const playerSource = (r: Rescored["record"]) => (r.device.camera ? "camera" : "simulated");

interface Item { id: string; frozenCase: boolean; record: Rescored["record"]; now: Rescored["now"]; was: number | null; verdict: Verdict | null; source?: Rescored; transform?: Transform }

function loadAll(): { items: Rescored[]; derived: ReturnType<typeof deriveAll> } {
  const frozen = loadCases().rounds;
  const local = loadDataRounds().rounds.filter((r) => !isFrozen(r.id));
  const items: Rescored[] = [...frozen, ...local].map((record) => ({ record, now: rescore(record), was: record.result.score }));
  return { items, derived: deriveAll(items) };
}

function everyCase(): Item[] {
  const { items, derived } = loadAll();
  return [
    ...items.map((it) => ({ id: it.record.id, frozenCase: isFrozen(it.record.id), record: it.record, now: it.now, was: it.was, verdict: judge(it, items) })),
    ...derived.map((d) => ({ id: d.id, frozenCase: false, record: d.record, now: d.now, was: d.source.now.score, verdict: d.verdict, source: d.source, transform: d.transform })),
  ];
}

/** Every round re-scored now, with its expectation, plus every derived case, plus the ids that do not hold. */
export function evalSummary() {
  const { items, derived } = loadAll();
  const rounds = items.map((it) => {
    const v = judge(it, items);
    return {
      id: it.record.id, frozenCase: isFrozen(it.record.id), clip: clipName(it.record), mode: it.record.mode, channel: it.record.channel, tag: it.record.tag,
      player: playerSource(it.record),
      scoreWhenPlayed: it.was, scoreNow: it.now.score, lagMs: Math.round(it.now.lagMs),
      outlineFit: it.now.channel === "pose" ? (it.now as PoseRoundResult).placement.outlineFit : null,
      expectation: v?.expectation ?? null, holds: v?.holds ?? null, detail: v?.detail ?? null,
    };
  });
  const derivedRows = derived.map((d) => ({
    id: d.id, transform: d.transform, clip: clipName(d.record), sourceScore: d.source.now.score, scoreNow: d.now.score,
    expectation: d.verdict.expectation, holds: d.verdict.holds, detail: d.verdict.detail,
  }));
  return {
    scorerVersion: SCORER_VERSION,
    roundCount: rounds.length,
    rounds,
    derived: derivedRows,
    notHolding: [...rounds.filter((r) => r.holds === false).map((r) => r.id), ...derivedRows.filter((d) => d.holds === false).map((d) => d.id)],
  };
}

/** One round or derived case in detail: what the scorer saw, limb by limb and second by second. */
export function roundDetail(id: string) {
  const [baseId, transform] = id.split("~");
  const { items } = loadAll();
  const base = items.find((it) => it.record.id === baseId);
  if (!base) return { error: `No round ${baseId}. Use eval_summary for the ids.` };
  if (transform && !(TRANSFORMS as readonly string[]).includes(transform)) return { error: `No transform ${transform}; they are ${TRANSFORMS.join(", ")}.` };
  const c = transform ? deriveCase(base, transform as Transform) : null;
  const r = c ? c.now : base.now;
  const verdict = c ? c.verdict : judge(base, items);
  const common = {
    id, clip: clipName(base.record), mode: base.record.mode, channel: base.record.channel, tag: base.record.tag, player: playerSource(base.record),
    transform: transform ?? null, sourceScore: c ? base.now.score : null, score: r.score, tier: r.tier, failure: r.failure,
    lagMs: Math.round(r.lagMs), timing: round2(r.timing),
    expectation: verdict?.expectation ?? null, holds: verdict?.holds ?? null, detail: verdict?.detail ?? null,
  };
  if (r.channel === "trajectory") {
    const t = r as TrajectoryRoundResult;
    return { ...common, continuous: round2(t.continuous), correlation: round2(t.correlation), chanceCorrelation: round2(t.chanceCorrelation), eventF1: round2(t.eventF1), activity: round2(t.activity), axes: t.axes, events: t.matches.length, eventsCaught: t.matches.filter((m) => m.playerFrame !== null).length };
  }
  const p = r as PoseRoundResult & { motion?: Record<string, number> };
  // Credit per second: the mean of the 30 grid frames in each second, or null when none could be scored.
  const perSecond: (number | null)[] = [];
  for (let i = 0; i < p.frameCredits.length; i += 30) {
    const slice = p.frameCredits.slice(i, i + 30).filter((v): v is number => v !== null);
    perSecond.push(slice.length ? round2(slice.reduce((a, b) => a + b, 0) / slice.length) : null);
  }
  return {
    ...common,
    accuracy: round2(p.accuracy), stillBaseline: round2(p.stillBaseline), validShare: round2(p.validShare),
    motion: p.motion ? Object.fromEntries(Object.entries(p.motion).map(([k, v]) => [k, round2(v)])) : null,
    worstLimb: p.worstLimb, hiddenLimbs: p.hiddenLimbs,
    perLimb: Object.fromEntries(Object.entries(p.perLimb).map(([limb, b]) => [limb, { credit: round2(b.credit), meanErrorDeg: Math.round(b.meanErrorDeg), direction: b.direction, unseenShare: round2(b.unseenShare) }])),
    placementUsed: p.placement.used, placementGain: round2(p.placement.gain),
    outlineFit: p.placement.outlineFit, outlineHints: p.placement.outlineHints,
    creditPerSecond: perSecond,
  };
}

/** What every case scores now, and with the given constant changes, and which expectations that changes. */
export function replayWith(changes: { constant: string; value: number }[]) {
  const before = everyCase();
  const restore: { constant: string; value: number }[] = [];
  try {
    for (const ch of changes) {
      const done = setConstant(ch.constant, ch.value);
      if (done.error !== null) return { error: done.error };
      restore.push({ constant: ch.constant, value: done.data });
    }
    const after = new Map(everyCase().map((it) => [it.id, it]));
    const rows = before.map((b) => {
      const a = after.get(b.id)!;
      return { id: b.id, scoreBefore: b.now.score, scoreAfter: a.now.score, holdsBefore: b.verdict?.holds ?? null, holdsAfter: a.verdict?.holds ?? null };
    });
    return {
      changes: changes.map((ch, i) => ({ constant: ch.constant, from: restore[i]?.value, to: ch.value })),
      broken: rows.filter((r) => r.holdsBefore === true && r.holdsAfter === false),
      fixed: rows.filter((r) => r.holdsBefore === false && r.holdsAfter === true),
      movedBy5OrMore: rows.filter((r) => r.scoreBefore !== null && r.scoreAfter !== null && Math.abs(r.scoreAfter - r.scoreBefore) >= 5),
      nullChanged: rows.filter((r) => (r.scoreBefore === null) !== (r.scoreAfter === null)),
      cases: rows.length,
    };
  } finally {
    for (const r of restore.reverse()) setConstant(r.constant, r.value);
  }
}

/** Numbers in `text` that no tool returned this run. Small whole numbers (0 to 10) and ids are not checked. */
export function unsupportedNumbers(text: string): string[] {
  const known: number[] = [];
  for (const out of corpus) for (const m of out.matchAll(/-?\d+(?:\.\d+)?/g)) known.push(Number(m[0]));
  const cleaned = text.replace(/r-[a-z0-9]{6,12}-[a-z0-9]{6}(?:~[a-z-]+)?/g, " ").replace(/clip [0-9a-f]{8}/g, " ").replace(/\b[0-9a-f]{12,16}\b/g, " ");
  const missing = new Set<string>();
  for (const m of cleaned.matchAll(/-?\d+(?:\.\d+)?/g)) {
    const s = m[0];
    const n = Number(s);
    if (Number.isInteger(n) && Math.abs(n) <= 10) continue;
    const decimals = s.includes(".") ? s.split(".")[1]!.length : 0;
    const scale = 10 ** decimals;
    const supported = known.some((k) => Math.abs(k - n) < 1e-9 || Math.round(k * scale) / scale === n || Math.round(Math.abs(k) * scale) / scale === Math.abs(n));
    if (!supported) missing.add(s);
  }
  return [...missing];
}

// ---- Lining up with the overlay ----

type Lm = readonly (readonly number[])[] | null;
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

/** Median shoulder-midpoint x and torso height (shoulders to hips, in frame heights) over the frames that show both. */
function bodyInFrame(frames: readonly { readonly landmarks: Lm }[]) {
  const xs: number[] = [], torsos: number[] = [];
  for (const f of frames) {
    const l = f.landmarks;
    if (!l || l.length < 25) continue;
    const vis = (i: number) => (l[i]?.[2] ?? 0) >= 0.5;
    if (!vis(11) || !vis(12)) continue;
    const sx = (l[11]![0]! + l[12]![0]!) / 2, sy = (l[11]![1]! + l[12]![1]!) / 2;
    xs.push(sx);
    if (vis(23) && vis(24)) torsos.push(Math.abs((l[23]![1]! + l[24]![1]!) / 2 - sy));
  }
  return { anchorX: round2(median(xs)), torso: round2(median(torsos)) };
}

/**
 * Per person clip, from camera rounds only (the simulated player always lines up perfectly): how well players
 * matched the subject's place and size on the mirrored screen (outline fit, 0 to 100, shown to players, not
 * scored), which hints they got, and where and how big the subject and the players are in frame.
 */
export function overlaySummary() {
  const { items } = loadAll();
  const byClip = new Map<string, Rescored[]>();
  for (const it of items) {
    if (it.record.channel !== "pose") continue;
    const k = clipName(it.record);
    byClip.set(k, [...(byClip.get(k) ?? []), it]);
  }
  const clips = [...byClip].map(([clip, all]) => {
    const cam = all.filter((it) => it.record.device.camera);
    const fits = cam.map((it) => (it.now as PoseRoundResult).placement.outlineFit).filter((v): v is number => v !== null);
    const hints = cam.map((it) => (it.now as PoseRoundResult).placement.outlineHints);
    const count = (pick: (h: { distance: string | null; side: string | null }) => string | null) => {
      const c: Record<string, number> = {};
      for (const h of hints) { const v = pick(h) ?? "none"; c[v] = (c[v] ?? 0) + 1; }
      return c;
    };
    const distance = count((h) => h.distance), side = count((h) => h.side);
    const share = (c: Record<string, number>) => Math.max(0, ...Object.entries(c).filter(([k]) => k !== "none").map(([, v]) => v)) / Math.max(1, cam.length);
    const subject = bodyInFrame(unpackPose(all[0]!.record.reference as AnyPackedPose).frames);
    const players = cam.map((it) => bodyInFrame(unpackPose(it.record.player).frames));
    const playerX = median(players.map((p) => p.anchorX).filter((v): v is number => v !== null));
    return {
      clip,
      cameraRounds: cam.length,
      simulatedRounds: all.length - cam.length,
      outlineFit: { median: median(fits), min: fits.length ? Math.min(...fits) : null, max: fits.length ? Math.max(...fits) : null },
      distanceHints: distance,
      sideHints: side,
      sameHintShare: { distance: round2(share(distance)), side: round2(share(side)) },
      subjectInFrame: subject,
      // The player's camera image is not mirrored; on screen it is, so x becomes 1 - x.
      playersInFrame: { anchorXOnScreen: playerX === null ? null : round2(1 - playerX), torso: round2(median(players.map((p) => p.torso).filter((v): v is number => v !== null))) },
      scores: cam.map((it) => it.now.score),
    };
  });
  return {
    note: "outlineFit is shown to players, not scored. anchorX is across the frame from 0 (left) to 1 (right); torso is shoulders to hips in frame heights. A hint most camera players share on one clip points at the overlay's size or place for that clip, or at how laptops frame players, more than at the players.",
    clips,
  };
}

// ---- The tools ----

export const evalSummaryTool = tool(async () => recorded("eval_summary", JSON.stringify(evalSummary())), {
  name: "eval_summary",
  description:
    "Re-scores every recorded Jester round with the current scorer and returns, as JSON: each round (clip, mode, tag, player: camera or simulated stand-in, score when played, score now, lag, outline fit, expectation, whether it holds), every derived case (late, frozen, seated, walked-out, jittered and mirrored copies of good rounds, with whether each expectation holds; holds null means report only or not applicable), and the ids that do not hold. Deterministic.",
  schema: z.object({}),
});

export const getRoundTool = tool(async ({ id }) => recorded("get_round", JSON.stringify(roundDetail(id))), {
  name: "get_round",
  description:
    "One round (id like r-abc123-def456) or one derived case (id like r-abc123-def456~frozen) in detail: score, tier, failure, lag, timing, the expectation and whether it holds; for a person (pose) round also accuracy, still baseline, motion share and gate, credit per limb with mean angle error, hidden limbs, worst limb, and credit for each second of the round; for a thing (trajectory) round correlation, chance correlation, events caught. Deterministic.",
  schema: z.object({ id: z.string().describe("A round id, or a round id followed by ~transform") }),
});

export const engineConstantsTool = tool(async ({ group }) => {
  const all = constants as unknown as Record<string, unknown>;
  const picked = group ? { [group]: all[group] ?? `no group ${group}; groups are ${Object.keys(all).join(", ")}` } : all;
  return recorded("engine_constants", JSON.stringify({ scorerVersion: SCORER_VERSION, constants: picked }));
}, {
  name: "engine_constants",
  description: "The scorer's tunable numbers as they are now (engine/src/constants.ts), for example LAG.maxMs, POSE.thetaOutDeg, ROUND.ceiling, MOTION.gateLow. Pass a group name (POSE, LAG, TIMING, ROUND, MOTION, PLACEMENT, TRAJECTORY, EVENTS) or nothing for all. Use this instead of guessing any limit.",
  schema: z.object({ group: z.string().optional().describe("One group, for example LAG") }),
});

export const replayWithTool = tool(async ({ changes }) => recorded("replay_with", JSON.stringify(replayWith(changes))), {
  name: "replay_with",
  description:
    "What-if: re-scores every round and derived case with some engine constants changed for this call only (the engine files are never touched), and returns which expectations it would break (held before, not after), which it would fix, which scores move by 5 or more, and which change between a score and no score. Use it to test a hypothesis before recommending anything.",
  schema: z.object({
    changes: z.array(z.object({ constant: z.string().describe("GROUP.name, for example ROUND.ceiling"), value: z.number() })).min(1).max(4),
  }),
});

export const overlaySummaryTool = tool(async () => recorded("overlay_summary", JSON.stringify(overlaySummary())), {
  name: "overlay_summary",
  description:
    "How well camera players line up with the overlay, per person clip: outline fit (0 to 100, shown not scored), the distance and side hints they got and how many share the same one, and where and how big the subject and the players are in frame (shoulder midpoint across the frame, torso height in frame heights). Simulated rounds are counted but left out. Deterministic.",
  schema: z.object({}),
});

export const checkNumbersTool = tool(async ({ text }) => {
  const missing = unsupportedNumbers(text);
  return missing.length
    ? `These numbers do not appear in any tool result this run: ${missing.join(", ")}. Replace each with a number a tool returned, or remove it.`
    : "Every number in the text appears in a tool result from this run.";
}, {
  name: "check_numbers",
  description: "Checks a draft (for example the report) and lists every number in it that no tool returned this run. Run it on the report before finishing; fix every number it lists.",
  schema: z.object({ text: z.string() }),
});

export const proposeConstantsChangeTool = tool(async ({ changes, rationale, evidence }) => {
  mkdirSync(join(WORKSPACE, "proposals"), { recursive: true });
  const file = join(WORKSPACE, "proposals", `proposal-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  const body = [
    "# Proposed engine constant change (for Alex; not applied)", "",
    ...changes.map((c) => `- \`${c.constant}\`: ${c.value}`), "", "## Why", "", rationale, "", "## Evidence (from replay_with)", "", evidence, "",
  ].join("\n");
  writeFileSync(file, body);
  return `Proposal written to ${file}. Nothing in the engine changed; Alex decides.`;
}, {
  name: "propose_constants_change",
  description: "Writes a proposal file for Alex, who owns the scorer, describing a constant change and its replay_with evidence. Never edits the engine. A person must approve each call before it runs. Only propose a change that replay_with showed fixes something and breaks nothing.",
  schema: z.object({
    changes: z.array(z.object({ constant: z.string(), value: z.number() })).min(1),
    rationale: z.string(),
    evidence: z.string().describe("The replay_with result that supports it, summarised with its numbers"),
  }),
});
