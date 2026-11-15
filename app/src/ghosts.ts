// Ghosts: opponents replayed from rounds saved earlier on the same clip (the `rounds` table, see
// eval/src/record.ts). A ghost has a score bar that fills while the clip plays, a figure in the reveal and a
// place in the ranking. Ghosts get made-up names and are always labelled as ghosts.
// Pure and DOM free (fetching is in ghostSource.ts), so the choices here are unit tested.
//
//   const pool = ghostCandidates(rows, clipId);            // untagged rounds with a score on this bank clip
//   const ids = pickGhosts(rows, clipId, 3);                // a spread: one strong, one middling, one weak
//   const ghost = makeGhost(record, ghostName(record.id));  // ready to draw and rank
//   ghostScoreAt(ghost, mediaMs);                           // the live bar, 0 up to the ghost's final score
//   withGhosts(duelStandings(room), ghosts.map((g) => ghostStanding(g, startMs, endMs)));

import { GRID_HZ } from "../../engine/src/constants.ts";
import { bucketCredits, rankDuel } from "../../clip/src/match.ts";
import { unpackPose, type PackedPose } from "../../eval/src/record.ts";
import { serializeTimeline } from "../../spikes/pose-match/serialize.mjs";
import type { DuelClipInfo, DuelStanding, DuelTable } from "./onlineDuel.ts";

/** One saved round, as much of it as choosing needs (no pose data). */
export interface GhostRow {
  id: string;
  score: number | null;
  tag: string | null;
  /** The bank clip it was played on; null when the round could not be matched to one. */
  bankId: string | null;
  channel?: string | null;
}

/** What a ghost needs from its saved round: the player's poses and the scorer's result. */
export interface GhostRecord {
  id: string;
  score: number;
  player: PackedPose;
  result: { score: number | null; lagMs?: number | null; frameCredits?: (number | null)[]; worstLimb?: { label?: string } | null };
}

export interface Ghost {
  /** The saved round's id. */
  id: string;
  /** The made-up name, without the ghost label. */
  name: string;
  score: number;
  lagMs: number | null;
  worst: string | null;
  frameCredits: (number | null)[];
  /** The ghost's poses in the compact form the reveal draws (serialize.mjs). */
  timeline: unknown;
  /** Running total of frame credits: cumulative[k] is the sum of credits for grid frames 0..k. */
  cumulative: number[];
}

/** The bars and the ranking say this after every ghost's name. */
export const GHOST_LABEL = "(ghost)";
/** Ghost standings use ids that can never be a player's. */
export const GHOST_PREFIX = "ghost:";

export const GHOST_NAMES = [
  "Noodle", "Biscuit", "Pickles", "Waffles", "Marbles", "Juniper", "Turnip", "Pepper",
  "Clementine", "Bramble", "Sprocket", "Dumpling", "Gumdrop", "Wobble", "Parsnip", "Tinsel",
] as const;

/** Rounds a ghost may come from on `clipId`: no dev tag, a score, the same bank clip, pose rounds only. */
export function ghostCandidates(rows: readonly GhostRow[], clipId: string): GhostRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return r.tag === null && typeof r.score === "number" && r.bankId !== null && r.bankId === clipId && (r.channel == null || r.channel === "pose");
  });
}

/**
 * Up to `count` ghost round ids for `clipId`, best score first. With more rounds than seats the scores are
 * split into `count` bands and one round is drawn from each, so the ghosts are not all the best or all the worst.
 */
export function pickGhosts(rows: readonly GhostRow[], clipId: string, count: number, rand: () => number = Math.random): string[] {
  const pool = ghostCandidates(rows, clipId).sort((a, b) => b.score! - a.score! || (a.id < b.id ? -1 : 1));
  if (count <= 0) return [];
  if (pool.length <= count) return pool.map((r) => r.id);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const from = Math.floor((i * pool.length) / count), to = Math.floor(((i + 1) * pool.length) / count);
    out.push(pool[from + Math.min(to - from - 1, Math.floor(rand() * (to - from)))]!.id);
  }
  return out;
}

/** A made-up name for the ghost of round `id`: the same round gets the same name on every device. */
export function ghostName(id: string, taken: ReadonlySet<string> = new Set()): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  for (let k = 0; k < GHOST_NAMES.length; k++) {
    const name = GHOST_NAMES[(h + k) % GHOST_NAMES.length]!;
    if (!taken.has(name)) return name;
  }
  return GHOST_NAMES[h % GHOST_NAMES.length]! + " " + (taken.size + 1);
}

/** Names for a match's ghosts, in order, all different. */
export function ghostNames(ids: readonly string[]): string[] {
  const taken = new Set<string>();
  return ids.map((id) => { const name = ghostName(id, taken); taken.add(name); return name; });
}

export const labelled = (name: string) => `${name} ${GHOST_LABEL}`;

/** A saved round made ready to replay: its poses for the reveal and its credits for the live bar. */
export function makeGhost(record: GhostRecord, name: string): Ghost {
  const pose = unpackPose(record.player);
  const frames = pose.frames.filter((f) => f.landmarks).map((f) => ({
    t: f.tMs,
    landmarks: f.landmarks!.map(([x, y, v]) => ({ x, y, z: 0, visibility: v })),
    outline: null,
  }));
  const last = pose.frames.length ? pose.frames[pose.frames.length - 1]!.tMs : 0;
  const timeline = serializeTimeline({
    version: 1, source: "webcam", mirrored: false, model: "pose_landmarker",
    aspect: pose.source.width / Math.max(1, pose.source.height),
    durationMs: last, coverage: pose.frames.length ? frames.length / pose.frames.length : 0, frames,
  } as never);
  const frameCredits = record.result.frameCredits ?? [];
  const cumulative: number[] = [];
  let sum = 0;
  for (const c of frameCredits) { sum += c ?? 0; cumulative.push(sum); }
  return {
    id: record.id, name, score: record.score, lagMs: record.result.lagMs ?? null,
    worst: record.result.worstLimb?.label ?? null, frameCredits, timeline, cumulative,
  };
}

/**
 * The ghost's live score at clip time `mediaMs`: it fills from 0 to the ghost's final score, faster where the
 * ghost was copying well and not at all where it was off. A ghost with no credits fills evenly.
 */
export function ghostScoreAt(ghost: Ghost, mediaMs: number, gridMs = 1000 / GRID_HZ): number {
  const n = ghost.cumulative.length;
  if (n === 0) return 0;
  const k = Math.floor(mediaMs / gridMs);
  if (k < 0) return 0;
  if (k >= n - 1) return ghost.score;
  const total = ghost.cumulative[n - 1]!;
  const share = total > 0 ? ghost.cumulative[k]! / total : (k + 1) / n;
  return Math.round(ghost.score * share);
}

/** The ghost as a row of the duel table, over the round's stretch (media ms). */
export function ghostStanding(ghost: Ghost, startMs: number, endMs: number, bucketMs = 200): DuelStanding {
  return {
    id: GHOST_PREFIX + ghost.id, name: labelled(ghost.name), place: 0, score: ghost.score, lagMs: ghost.lagMs, worst: ghost.worst,
    credits: bucketCredits(ghost.frameCredits, startMs, endMs, 1000 / GRID_HZ, bucketMs), bucketMs, timeline: ghost.timeline, error: null,
  };
}

/** The players' table with the ghosts ranked in: highest score first, ties by timing, exact ties share a place. */
export function withGhosts(table: DuelTable, ghosts: readonly DuelStanding[]): DuelTable {
  const rows = [...table.ranked, ...ghosts];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return { ...table, ranked: rankDuel(rows).map((p) => ({ ...byId.get(p.id)!, place: p.place })) };
}

export const isGhost = (id: string) => id.startsWith(GHOST_PREFIX);

/**
 * The clip a match plays. Bank clips come first (the starter only when the bank has none). Someone playing
 * alone gets a clip that has ghosts when any does, so there is someone to play against.
 */
export function pickClip(clips: readonly DuelClipInfo[], rows: readonly GhostRow[], { alone, starterId, rand = Math.random }: { alone: boolean; starterId: string; rand?: () => number }): DuelClipInfo | null {
  const bank = clips.filter((c) => c.id !== starterId);
  let pool = bank.length ? bank : [...clips];
  if (alone) {
    const haunted = clips.filter((c) => ghostCandidates(rows, c.id).length > 0);
    if (haunted.length) pool = haunted;
  }
  return pool.length ? pool[Math.floor(rand() * pool.length)] ?? pool[0]! : null;
}
