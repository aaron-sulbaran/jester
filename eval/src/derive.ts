// Derived test cases: one good round becomes seven. Each transform changes the player's recording in a way whose
// effect on the score is known (late, frozen, seated, walked out, jittered, mirrored), so the suite grows without
// anyone playing more rounds. Deterministic: no randomness, no AI. The thresholds live in ../expectations.ts.

import { constants, type PoseFrame, type PoseTimeline, type PoseRoundResult } from "../../engine/src/index.ts";
import { EXPECT } from "../expectations.ts";
import { legSwingDeg, rescore, type Rescored, type Verdict } from "./judge.ts";
import { packPose, unpackPose, type AnyPackedPose, type RoundRecord } from "./record.ts";

export const TRANSFORMS = ["late", "frozen", "seated", "walked-out", "jittered", "mirrored"] as const;
export type Transform = (typeof TRANSFORMS)[number];

export interface DerivedCase {
  /** `<source id>~<transform>`, stable across runs. */
  id: string;
  transform: Transform;
  source: Rescored;
  record: RoundRecord;
  now: Rescored["now"];
  verdict: Verdict;
}

const D = EXPECT.derived;
type Point = readonly [number, number, number];

/** MediaPipe's left and right points, as pairs: eyes, ears, mouth, shoulders down to the feet. Point 0, the nose, has no pair. */
const PAIRS: readonly (readonly [number, number])[] = [
  [1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22],
  [23, 24], [25, 26], [27, 28], [29, 30], [31, 32],
];
const OTHER_SIDE = new Map<number, number>(PAIRS.flatMap(([a, b]) => [[a, b], [b, a]] as [number, number][]));
const LEG_POINTS = new Set([25, 26, 27, 28, 29, 30, 31, 32]);

const withFrames = (t: PoseTimeline, frames: PoseFrame[]): PoseTimeline => ({ ...t, frames });

/** The player's recording after one transform. */
export function transformPlayer(player: PoseTimeline, transform: Transform): PoseTimeline {
  const frames = player.frames;
  switch (transform) {
    case "late":
      return withFrames(player, frames.map((f) => ({ ...f, tMs: f.tMs + D.lateShiftMs })));
    case "frozen": {
      const first = frames.find((f) => f.landmarks)?.landmarks ?? null;
      return withFrames(player, frames.map((f) => ({ ...f, landmarks: first })));
    }
    case "seated":
      return withFrames(player, frames.map((f) => ({
        ...f,
        landmarks: f.landmarks && f.landmarks.map((p, i): Point => (LEG_POINTS.has(i) ? [p[0], p[1], 0] : p)),
      })));
    case "walked-out": {
      const from = Math.floor(frames.length * (0.5 - D.walkedOutShare / 2));
      const to = Math.ceil(frames.length * (0.5 + D.walkedOutShare / 2));
      return withFrames(player, frames.map((f, i) => (i >= from && i < to ? { ...f, landmarks: null } : f)));
    }
    case "jittered":
      // A fixed pattern, not random numbers, so every run gives the same case.
      return withFrames(player, frames.map((f, i) => ({
        ...f,
        landmarks: f.landmarks && f.landmarks.map((p, k): Point => [
          p[0] + D.jitter * Math.sin(1.7 * i + 2.3 * k),
          p[1] + D.jitter * Math.cos(1.3 * i + 3.1 * k),
          p[2],
        ]),
      })));
    case "mirrored": {
      // The same performance done with the other side: each point takes its partner's place, reflected about a
      // fixed vertical line (the first frame's shoulder midpoint), so steps to one side become steps to the other.
      const first = frames.find((f) => f.landmarks)?.landmarks;
      const axis = first ? (first[11]![0] + first[12]![0]) / 2 : 0.5;
      return withFrames(player, frames.map((f) => ({
        ...f,
        landmarks: f.landmarks && f.landmarks.map((_, i): Point => {
          const q = f.landmarks![OTHER_SIDE.get(i) ?? i]!;
          return [2 * axis - q[0], q[1], q[2]];
        }),
      })));
    }
  }
}

/** A round that is a good copy, worth deriving from. */
export function isSource(it: Rescored): boolean {
  if (it.record.mode === "derived") return false;
  if (it.record.tag === "nailed") return true;
  return it.record.tag === null && it.now.score !== null && it.now.score >= D.minSourceScore;
}

const show = (s: number | null) => (s === null ? "no score" : String(s));

export function judgeDerived(transform: Transform, source: Rescored, record: RoundRecord, now: Rescored["now"]): Verdict {
  const s = now.score;
  const src = source.now.score;
  switch (transform) {
    case "late": {
      if (src === null) return { expectation: "lag moves by 500 ms", holds: null, detail: "source has no score" };
      // A player already far behind, pushed 500 ms later, lands past the lags the engine looks for: no answer is right.
      const searchEnd = constants.LAG.maxMs - D.lateLagToleranceMs;
      if (source.now.lagMs + D.lateShiftMs > searchEnd) {
        return { expectation: "lag moves by 500 ms", holds: null, detail: `${show(s)}; source lag ${Math.round(source.now.lagMs)} ms plus ${D.lateShiftMs} is past the engine's lag search (up to ${constants.LAG.maxMs} ms)` };
      }
      const lagMove = now.lagMs - source.now.lagMs;
      const holds = s !== null && Math.abs(lagMove - D.lateShiftMs) <= D.lateLagToleranceMs && src - s <= D.lateMaxBelowSource;
      return { expectation: `lag moves by ${D.lateShiftMs} +- ${D.lateLagToleranceMs} ms, at most ${D.lateMaxBelowSource} below source`, holds, detail: `${show(s)}, lag ${Math.round(source.now.lagMs)} -> ${Math.round(now.lagMs)} ms` };
    }
    case "frozen":
      return { expectation: `${D.frozenMaxScore} or less`, holds: s === null || s <= D.frozenMaxScore, detail: show(s) };
    case "seated": {
      if (record.channel !== "pose") return { expectation: "capped (person clips only)", holds: null, detail: show(s) };
      const swing = legSwingDeg(unpackPose(record.reference as AnyPackedPose));
      if (swing < EXPECT.seated.legRangeDeg) return { expectation: "capped when the clip uses the legs", holds: null, detail: `${show(s)}; legs swing only ${Math.round(swing)} degrees here` };
      const hidden = (now as PoseRoundResult).hiddenLimbs ?? [];
      return { expectation: `${D.seatedMaxScore} or less (legs swing ${Math.round(swing)} degrees)`, holds: s === null || s <= D.seatedMaxScore, detail: `${show(s)}${hidden.length ? "; hidden: " + hidden.join(", ") : "; nothing marked hidden"}` };
    }
    case "walked-out":
      return { expectation: `no score or ${D.walkedOutMaxScore} or less`, holds: s === null || s <= D.walkedOutMaxScore, detail: now.failure ? `${show(s)} (${now.failure})` : show(s) };
    case "jittered":
      if (src === null) return { expectation: `within ${D.jitterMaxMove} of source`, holds: null, detail: "source has no score" };
      return { expectation: `within ${D.jitterMaxMove} of source`, holds: s !== null && Math.abs(s - src) <= D.jitterMaxMove, detail: `${show(s)} vs ${src}` };
    case "mirrored":
      return { expectation: "report only (should swapping sides cost points? Alex's call)", holds: null, detail: `${show(s)} vs ${show(src)}` };
  }
}

/** One derived case, scored with the engine code on disk (and any what-if constants already set). */
export function deriveCase(source: Rescored, transform: Transform): DerivedCase {
  const player = transformPlayer(unpackPose(source.record.player), transform);
  const record: RoundRecord = {
    ...source.record,
    id: `${source.record.id}~${transform}`,
    mode: "derived",
    tag: null,
    note: `${transform} copy of ${source.record.id}`,
    player: packPose(player),
  };
  const now = rescore(record);
  return { id: record.id, transform, source, record, now, verdict: judgeDerived(transform, source, record, now) };
}

/** Every derived case for every source among `items`. */
export function deriveAll(items: readonly Rescored[], transforms: readonly Transform[] = TRANSFORMS): DerivedCase[] {
  return items.filter(isSource).flatMap((source) => transforms.map((t) => deriveCase(source, t)));
}
