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

/** Numbers stored exactly: plain JSON numbers when every value is a short decimal (the bank's guides are saved at
 * 4 decimals), otherwise base64 of little-endian 64-bit floats (the tracker's smoothed points, clip times). */
export type Exact = number[] | { f64: string };

/**
 * A PoseTimeline stored exactly, so a replay with the same engine code gives the same result bit for bit.
 * `empty` lists the frames where nobody was found; `p` holds x, y and visibility for each of the `n` points of
 * every other frame, in order.
 */
export interface PackedPose {
  schema: "packed-pose/2";
  source: { width: number; height: number; mirrored: boolean };
  t: Exact;
  empty: number[];
  n: number;
  p: Exact;
}

/** A BoxTrack stored exactly: cx, cy, w, h for every frame not listed in `empty`. */
export interface PackedBoxes {
  schema: "packed-box/2";
  source: { width: number; height: number };
  t: Exact;
  empty: number[];
  b: Exact;
  scrollX?: Exact;
}

/**
 * Version 1, recorded until about 11:20 PM Saturday: integers, time in hundredths of a ms, x and y in 1e-5,
 * visibility in 1e-4. Read only. Rounding the times moved a clip's last frame off the engine's grid, so these
 * replay a little differently (one live round: 67 recorded, 68 replayed).
 */
export interface PackedPoseV1 {
  schema: "packed-pose/1";
  source: { width: number; height: number; mirrored: boolean };
  t: number[];
  lm: (number[] | null)[];
}

export interface PackedBoxesV1 {
  schema: "packed-box/1";
  source: { width: number; height: number };
  t: number[];
  b: (number[] | null)[];
  scrollX?: number[];
}

export type AnyPackedPose = PackedPose | PackedPoseV1;
export type AnyPackedBoxes = PackedBoxes | PackedBoxesV1;

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
  reference: AnyPackedPose | AnyPackedBoxes;
  player: AnyPackedPose;
  result: PoseRoundResult | TrajectoryRoundResult;
  scorerVersion: string;
  /** Frozen cases keep only width, height, frame rate and playerFps; the rest is blanked (see withoutDeviceDetails). */
  device: {
    userAgent: string;
    /** Left out of frozen cases. */
    cores?: number | null;
    gpu: string | null;
    /** `label` is the camera's name, kept on dev server rounds only; live-site rounds since Nov 15 4 AM have null. */
    camera: { label: string | null; width: number | null; height: number | null; frameRate: number | null } | null;
    /** Frames with a body found per second of the round, from the player's timeline. */
    playerFps: number | null;
  };
  /** Stamped by the dev server when it saves the record: the code that was running. */
  app: { commit: string | null; dirty: boolean | null; engineHash: string | null } | null;
}

// ---- Packing ----

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function fromBase64(b64: string): Uint8Array {
  const text = atob(b64);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

export function exact(values: readonly number[]): Exact {
  if (values.every((v) => Number.isFinite(v) && Number(v.toFixed(6)) === v)) return [...values];
  const view = new DataView(new ArrayBuffer(values.length * 8));
  values.forEach((v, i) => view.setFloat64(i * 8, v, true));
  return { f64: toBase64(new Uint8Array(view.buffer)) };
}

export function numbers(e: Exact): number[] {
  if (Array.isArray(e)) return e;
  const bytes = fromBase64(e.f64);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.length / 8 }, (_, i) => view.getFloat64(i * 8, true));
}

export function packPose(timeline: PoseTimeline): PackedPose {
  const empty: number[] = [];
  const p: number[] = [];
  let n = 0;
  timeline.frames.forEach((f, i) => {
    if (!f.landmarks) { empty.push(i); return; }
    if (n === 0) n = f.landmarks.length;
    if (f.landmarks.length !== n) throw new Error(`frame ${i} has ${f.landmarks.length} points, not ${n}`);
    for (const [x, y, v] of f.landmarks) p.push(x, y, v);
  });
  return { schema: "packed-pose/2", source: { ...timeline.source }, t: exact(timeline.frames.map((f) => f.tMs)), empty, n, p: exact(p) };
}

export function unpackPose(packed: AnyPackedPose): PoseTimeline {
  if (packed.schema === "packed-pose/1") return unpackPoseV1(packed);
  const t = numbers(packed.t);
  const p = numbers(packed.p);
  const empty = new Set(packed.empty);
  let k = 0;
  return {
    schema: "pose-timeline/1",
    source: { ...packed.source },
    frames: t.map((tMs, i) => {
      if (empty.has(i)) return { tMs, landmarks: null };
      const landmarks: [number, number, number][] = [];
      for (let j = 0; j < packed.n; j++, k += 3) landmarks.push([p[k]!, p[k + 1]!, p[k + 2]!]);
      return { tMs, landmarks };
    }),
  };
}

export function packBoxes(track: BoxTrack): PackedBoxes {
  const empty: number[] = [];
  const b: number[] = [];
  track.frames.forEach((f, i) => {
    if (!f.box) { empty.push(i); return; }
    b.push(f.box.cx, f.box.cy, f.box.w, f.box.h);
  });
  const packed: PackedBoxes = { schema: "packed-box/2", source: { ...track.source }, t: exact(track.frames.map((f) => f.tMs)), empty, b: exact(b) };
  if (track.scrollX) packed.scrollX = exact(track.scrollX);
  return packed;
}

export function unpackBoxes(packed: AnyPackedBoxes): BoxTrack {
  if (packed.schema === "packed-box/1") return unpackBoxesV1(packed);
  const t = numbers(packed.t);
  const b = numbers(packed.b);
  const empty = new Set(packed.empty);
  let k = 0;
  const track: BoxTrack = {
    schema: "box-track/1",
    source: { ...packed.source },
    frames: t.map((tMs, i) => {
      if (empty.has(i)) return { tMs, box: null };
      const box = { cx: b[k]!, cy: b[k + 1]!, w: b[k + 2]!, h: b[k + 3]! };
      k += 4;
      return { tMs, box };
    }),
  };
  return packed.scrollX ? { ...track, scrollX: numbers(packed.scrollX) } : track;
}

// Version 1 readers.
const T_SCALE = 100;
const XY_SCALE = 1e5;
const VIS_SCALE = 1e4;

function unpackPoseV1(p: PackedPoseV1): PoseTimeline {
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

function unpackBoxesV1(p: PackedBoxesV1): BoxTrack {
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

/**
 * Two 32-bit FNV-1a hashes over the reference rounded to version 1's integers, as 16 hex digits. Same reference,
 * same key, whichever version stored it.
 */
export function fingerprint(packed: AnyPackedPose | AnyPackedBoxes): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  const feed = (n: number) => {
    a = Math.imul(a ^ (n & 0xffff), 0x01000193) >>> 0;
    a = Math.imul(a ^ ((n >>> 16) & 0xffff), 0x01000193) >>> 0;
    b = Math.imul(b ^ (n | 0), 0x5bd1e995) >>> 0;
    b = (b ^ (b >>> 13)) >>> 0;
  };
  if (packed.schema === "packed-pose/1" || packed.schema === "packed-pose/2") {
    const timeline = unpackPose(packed);
    feed(1);
    for (const f of timeline.frames) feed(Math.round(f.tMs * T_SCALE));
    for (const f of timeline.frames) {
      if (!f.landmarks) { feed(-1); continue; }
      for (const [x, y, v] of f.landmarks) { feed(Math.round(x * XY_SCALE)); feed(Math.round(y * XY_SCALE)); feed(Math.round(v * VIS_SCALE)); }
    }
  } else {
    const track = unpackBoxes(packed);
    feed(2);
    for (const f of track.frames) feed(Math.round(f.tMs * T_SCALE));
    for (const f of track.frames) {
      if (!f.box) { feed(-1); continue; }
      for (const v of [f.box.cx, f.box.cy, f.box.w, f.box.h]) feed(Math.round(v * XY_SCALE));
    }
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
    && typeof r.player === "object" && r.player !== null && (r.player.schema === "packed-pose/1" || r.player.schema === "packed-pose/2")
    && typeof r.result === "object" && r.result !== null
    && typeof r.scorerVersion === "string";
}
