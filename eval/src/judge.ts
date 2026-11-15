// Re-scoring a recorded round with the engine code on disk, and checking it against what its tag promises.

import {
  constants, fromClipSamples, scorePoseRound, scoreTrajectoryRound,
  type ClipSample, type PoseRoundOptions, type PoseRoundResult, type PoseTimeline, type TrajectoryRoundOptions, type TrajectoryRoundResult,
} from "../../engine/src/index.ts";
import { DEMO_SEQUENCE, makeSequenceTimeline } from "../../spikes/pose-match/synthetic.mjs";
import { EXPECT } from "../expectations.ts";
import { fingerprint, packPose, unpackBoxes, unpackPose, type PackedBoxes, type PackedPose, type RoundRecord } from "./record.ts";

type Result<T> = { data: T; error: null } | { data: null; error: string };
type AnyResult = PoseRoundResult | TrajectoryRoundResult;

export function rescore(r: RoundRecord): AnyResult {
  const player = unpackPose(r.player);
  if (r.channel === "pose") return scorePoseRound(unpackPose(r.reference as PackedPose), player, r.options as PoseRoundOptions);
  return scoreTrajectoryRound(unpackBoxes(r.reference as PackedBoxes), player, r.options as TrajectoryRoundOptions);
}

// ---- What-if: change an engine constant for this run only ----

/** Sets e.g. "ROUND.ceiling" to 0.9 in the engine's constants for the rest of this process. Returns the old value. */
export function setConstant(path: string, value: number): Result<number> {
  const [group, key, extra] = path.split(".");
  const table = group ? (constants as unknown as Record<string, Record<string, unknown>>)[group] : undefined;
  if (!table || !key || extra !== undefined || typeof table[key] !== "number") {
    return { data: null, error: `${path} is not a number in engine/src/constants.ts (use GROUP.name, for example ROUND.ceiling)` };
  }
  const old = table[key] as number;
  table[key] = value;
  return { data: old, error: null };
}

/** The round's raw 0..1 value before the floor, ceiling and hidden cap, for the calibration hint. Pose channel only. */
export function rawPoseValue(r: RoundRecord): number | null {
  if (r.channel !== "pose") return null;
  const round = constants.ROUND as unknown as Record<string, number>;
  const saved = { floor: round.floor!, ceiling: round.ceiling!, hiddenCap: round.hiddenCap! };
  Object.assign(round, { floor: 0, ceiling: 1, hiddenCap: 100 });
  try {
    const s = rescore(r).score;
    return s === null ? null : s / 100;
  } finally {
    Object.assign(round, saved);
  }
}

// ---- Clip names ----

let starterKey: string | null = null;

/** The same starter dance app/src/clip.ts builds, so its rounds read "starter" instead of a fingerprint. */
function starter(): string {
  if (starterKey) return starterKey;
  const aspect = 4 / 3;
  const samples = makeSequenceTimeline(DEMO_SEQUENCE, { idleDegrees: 2, aspect }) as ClipSample[];
  starterKey = fingerprint(packPose(fromClipSamples(samples, { width: Math.round(aspect * 1000), height: 1000, timeUnit: "s" })));
  return starterKey;
}

export function clipName(r: RoundRecord): string {
  if (r.clip.bankId) return r.clip.bankId + (r.clip.subject ? ` (${r.clip.subject})` : "");
  if (r.clip.key === starter()) return "starter";
  return r.clip.title ?? "clip " + r.clip.key.slice(0, 8);
}

// ---- Does the clip use the legs? ----

const LEG_BONES: readonly (readonly [number, number])[] = [[23, 25], [24, 26], [25, 27], [26, 28]];

/** The widest swing of a thigh or shin over the reference, in degrees (5th to 95th percentile). */
export function legSwingDeg(reference: PoseTimeline): number {
  let widest = 0;
  for (const [a, b] of LEG_BONES) {
    const angles: number[] = [];
    let first: number | null = null;
    for (const f of reference.frames) {
      const p = f.landmarks?.[a], q = f.landmarks?.[b];
      if (!p || !q || p[2] < 0.5 || q[2] < 0.5) continue;
      const angle = (Math.atan2(q[1] - p[1], q[0] - p[0]) * 180) / Math.PI;
      if (first === null) first = angle;
      angles.push(((angle - first + 540) % 360) - 180);
    }
    if (angles.length < 10) continue;
    angles.sort((x, y) => x - y);
    const at = (share: number) => angles[Math.min(angles.length - 1, Math.floor(share * angles.length))]!;
    widest = Math.max(widest, at(0.95) - at(0.05));
  }
  return widest;
}

// ---- Expectations ----

export interface Rescored {
  record: RoundRecord;
  now: AnyResult;
  /** The score the round got when it was played. */
  was: number | null;
}

export interface Verdict {
  expectation: string;
  /** null when it does not apply (or the tag is report only). */
  holds: boolean | null;
  detail: string;
}

const show = (s: number | null) => (s === null ? "no score" : String(s));

/** The same tester's nailed round on the same clip, latest first, for the tags that compare against one. */
function nailedPartner(item: Rescored, all: readonly Rescored[]): Rescored | null {
  const mates = all.filter((o) => o !== item && o.record.tag === "nailed" && o.record.browserId === item.record.browserId && o.record.clip.key === item.record.clip.key);
  return mates[mates.length - 1] ?? null;
}

export function judge(item: Rescored, all: readonly Rescored[]): Verdict | null {
  const r = item.record;
  const s = item.now.score;
  switch (r.tag) {
    case null:
      return null;
    case "stood-still":
      return { expectation: `${EXPECT.stoodStill.maxScore} or less`, holds: s === null || s <= EXPECT.stoodStill.maxScore, detail: show(s) };
    case "nailed":
      return { expectation: `${EXPECT.nailed.minScore} or more`, holds: s !== null && s >= EXPECT.nailed.minScore, detail: show(s) };
    case "wrong-moves":
      return { expectation: `under ${EXPECT.wrongMoves.maxScore + 1}`, holds: s === null || s <= EXPECT.wrongMoves.maxScore, detail: show(s) };
    case "walked-out-of-frame":
      return { expectation: `no score or ${EXPECT.walkedOutOfFrame.maxScore} or less`, holds: s === null || s <= EXPECT.walkedOutOfFrame.maxScore, detail: show(s) };
    case "seated": {
      if (r.channel !== "pose") return { expectation: "capped (pose clips only)", holds: null, detail: show(s) };
      const swing = legSwingDeg(unpackPose(r.reference as PackedPose));
      if (swing < EXPECT.seated.legRangeDeg) return { expectation: "capped when the clip uses the legs", holds: null, detail: `${show(s)}; legs swing only ${Math.round(swing)} degrees here` };
      const hidden = (item.now as PoseRoundResult).hiddenLimbs ?? [];
      return { expectation: `${EXPECT.seated.maxScore} or less (legs swing ${Math.round(swing)} degrees)`, holds: s === null || s <= EXPECT.seated.maxScore, detail: `${show(s)}${hidden.length ? "; hidden: " + hidden.join(", ") : "; nothing marked hidden"}` };
    }
    case "late-half-second": {
      const e = EXPECT.lateHalfSecond;
      const lagOk = s !== null && Math.abs(item.now.lagMs - e.lagMs) <= e.lagToleranceMs;
      const partner = nailedPartner(item, all);
      const ps = partner?.now.score ?? null;
      const nearOk = partner === null || ps === null || (s !== null && ps - s <= e.maxBelowNailed);
      const vs = partner ? `; nailed ${show(ps)}` : "; no nailed round by this tester on this clip to compare";
      return { expectation: `lag ${e.lagMs} +- ${e.lagToleranceMs} ms, within ${e.maxBelowNailed} of nailed`, holds: lagOk && nearOk, detail: `${show(s)}, lag ${Math.round(item.now.lagMs)} ms${vs}` };
    }
    case "left-right-swapped": {
      const partner = nailedPartner(item, all);
      return { expectation: "report only (should swapping cost points? Alex's call)", holds: null, detail: `${show(s)}${partner ? `; nailed ${show(partner.now.score)}` : ""}` };
    }
  }
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
