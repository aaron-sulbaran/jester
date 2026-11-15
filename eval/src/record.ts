// One scored attempt, as the round log keeps it: the exact two timelines the engine compared, the result
// it gave, and enough context to group and judge it later. Pose data only: no video, no images, no masks.
// DOM free and Node free, so the app's dev tap and the eval tool share it.

import type { BoxTrack, PoseRoundResult, PoseTimeline, TrajectoryRoundResult } from "../../engine/src/index.ts";

export const RECORD_SCHEMA = "jester-round/1";

/** What the tester meant to do, picked before the round on `?dev=1`. Each one has an expectation in eval/expectations.ts. */
export const DEV_TAGS = [
  "nailed",
  "stood-still",
  "seated",
  "late-half-second",
  "wrong-moves",
  "left-right-swapped",
  "walked-out-of-frame",
] as const;
export type DevTag = (typeof DEV_TAGS)[number];

export const isDevTag = (x: unknown): x is DevTag => typeof x === "string" && (DEV_TAGS as readonly string[]).includes(x);

/**
 * A PoseTimeline in integers: time in hundredths of a ms, x and y in units of 1e-5, visibility in 1e-4.
 * The engine rounds to 4 decimals after resampling, so this precision replays to the same score.
 */
export interface PackedPose {
  schema: "packed-pose/1";
  source: { width: number; height: number; mirrored: boolean };
  t: number[];
  /** Per frame: 33 points as x, y, visibility, or null when nobody was found. */
  lm: (number[] | null)[];
}

/** A BoxTrack in the same integers: per frame cx, cy, w, h, or null. */
export interface PackedBoxes {
  schema: "packed-box/1";
  source: { width: number; height: number };
  t: number[];
  b: (number[] | null)[];
  scrollX?: number[];
}

export type Channel = "pose" | "trajectory";

export interface RoundRecord {
  schema: typeof RECORD_SCHEMA;
  /** r-<time base 36>-<random>, sortable by time. */
  id: string;
  createdAt: string;
  /** A random id kept per browser, so one tester's rounds can be compared with each other. */
  browserId: string;
  /** solo, room, blind, blind-online, duel, link, eval-lab, lab or unknown (from the page and the call stack). */
  mode: string;
  page: string;
  /** App source files on the call stack when the round was scored, nearest first. */
  callers: string[];
  clip: {
    /** Fingerprint of the reference the round was scored against: rounds with the same key played the same thing. */
    key: string;
    bankId: string | null;
    title: string | null;
    /** The subject's label in the bank guide, for example "person 1" or "ball". */
    subject: string | null;
  };
  tag: DevTag | null;
  note: string | null;
  channel: Channel;
  /** The options passed to the scorer, as given. */
  options: Record<string, unknown>;
  /** What the player copied: a pose timeline (pose channel) or a box track (trajectory channel). */
  reference: PackedPose | PackedBoxes;
  player: PackedPose;
  result: PoseRoundResult | TrajectoryRoundResult;
  scorerVersion: string;
  device: {
    userAgent: string;
    cores: number | null;
    gpu: string | null;
    camera: { label: string; width: number | null; height: number | null; frameRate: number | null } | null;
    /** Frames with a body found per second of the round, from the player's timeline. */
    playerFps: number | null;
  };
  /** Stamped by the dev server when it saves the record: the code that was running. */
  app: { commit: string | null; dirty: boolean | null; engineHash: string | null } | null;
}

// ---- Packing ----

const T_SCALE = 100;
const XY_SCALE = 1e5;
const VIS_SCALE = 1e4;

export function packPose(timeline: PoseTimeline): PackedPose {
  const t: number[] = [];
  const lm: (number[] | null)[] = [];
  for (const f of timeline.frames) {
    t.push(Math.round(f.tMs * T_SCALE));
    if (!f.landmarks) { lm.push(null); continue; }
    const row: number[] = [];
    for (const [x, y, v] of f.landmarks) row.push(Math.round(x * XY_SCALE), Math.round(y * XY_SCALE), Math.round(v * VIS_SCALE));
    lm.push(row);
  }
  return { schema: "packed-pose/1", source: { ...timeline.source }, t, lm };
}

export function unpackPose(p: PackedPose): PoseTimeline {
  return {
    schema: "pose-timeline/1",
    source: { ...p.source },
    frames: p.t.map((t, i) => {
      const row = p.lm[i];
      if (!row) return { tMs: t / T_SCALE, landmarks: null };
      const landmarks: [number, number, number][] = [];
      for (let k = 0; k + 2 < row.length; k += 3) landmarks.push([row[k]! / XY_SCALE, row[k + 1]! / XY_SCALE, row[k + 2]! / VIS_SCALE]);
      return { tMs: t / T_SCALE, landmarks };
    }),
  };
}

export function packBoxes(track: BoxTrack): PackedBoxes {
  const packed: PackedBoxes = {
    schema: "packed-box/1",
    source: { ...track.source },
    t: track.frames.map((f) => Math.round(f.tMs * T_SCALE)),
    b: track.frames.map((f) => (f.box ? [f.box.cx, f.box.cy, f.box.w, f.box.h].map((v) => Math.round(v * XY_SCALE)) : null)),
  };
  if (track.scrollX) packed.scrollX = track.scrollX.map((v) => Math.round(v * XY_SCALE));
  return packed;
}

export function unpackBoxes(p: PackedBoxes): BoxTrack {
  const track: BoxTrack = {
    schema: "box-track/1",
    source: { ...p.source },
    frames: p.t.map((t, i) => {
      const b = p.b[i];
      return { tMs: t / T_SCALE, box: b ? { cx: b[0]! / XY_SCALE, cy: b[1]! / XY_SCALE, w: b[2]! / XY_SCALE, h: b[3]! / XY_SCALE } : null };
    }),
  };
  return p.scrollX ? { ...track, scrollX: p.scrollX.map((v) => v / XY_SCALE) } : track;
}

// ---- Fingerprints ----

/** Two 32-bit FNV-1a hashes over the packed integers, as 16 hex digits. Same reference, same key. */
export function fingerprint(packed: PackedPose | PackedBoxes): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  const feed = (n: number) => {
    a = Math.imul(a ^ (n & 0xffff), 0x01000193) >>> 0;
    a = Math.imul(a ^ ((n >>> 16) & 0xffff), 0x01000193) >>> 0;
    b = Math.imul(b ^ (n | 0), 0x5bd1e995) >>> 0;
    b = (b ^ (b >>> 13)) >>> 0;
  };
  feed(packed.schema === "packed-pose/1" ? 1 : 2);
  for (const t of packed.t) feed(t);
  const rows = packed.schema === "packed-pose/1" ? packed.lm : packed.b;
  for (const row of rows) {
    if (!row) { feed(-1); continue; }
    for (const v of row) feed(v);
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** The row for the shared Supabase table `rounds` (supabase/migrations/20261115_eval_rounds.sql). */
export function rowOf(r: RoundRecord) {
  return { id: r.id, created_at: r.createdAt, scorer_version: r.scorerVersion, mode: r.mode, tag: r.tag, clip_key: r.clip.key, score: r.result.score, record: r };
}

/** A new round id: sortable by time, random after that. */
export function newRoundId(now = Date.now(), random = Math.random): string {
  return "r-" + now.toString(36) + "-" + Math.floor(random() * 36 ** 6).toString(36).padStart(6, "0");
}

export const ROUND_ID = /^r-[a-z0-9]{6,12}-[a-z0-9]{6}$/;

/** Enough of a record to trust the rest: it came from the same code that reads it. */
export function looksLikeRecord(x: unknown): x is RoundRecord {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Partial<RoundRecord>;
  return r.schema === RECORD_SCHEMA
    && typeof r.id === "string" && ROUND_ID.test(r.id)
    && (r.channel === "pose" || r.channel === "trajectory")
    && typeof r.reference === "object" && r.reference !== null
    && typeof r.player === "object" && r.player !== null && r.player.schema === "packed-pose/1"
    && typeof r.result === "object" && r.result !== null
    && typeof r.scorerVersion === "string";
}
