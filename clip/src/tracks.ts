import { iou } from "./boxes.ts";
import { median } from "./rank.ts";
import type { Box, FrameDetections, Track, TrackPoint } from "./types.ts";

export interface LinkOptions {
  /** A detection joins a track only when its overlap with the track's last box is at least this. */
  minIou?: number;
  /** A track survives this many frames without a match; one more ends it. About a second at 15 a second. */
  maxGap?: number;
}

/** Overlaps within this of the best one count as a near tie, settled by direction of travel. */
const NEAR_TIE = 0.1;
/**
 * Tracks missed for at most this many frames pick their detection first. A track missing for
 * longer only takes what is left, so it cannot take over someone who has since moved into its spot.
 */
const FRESH_GAP = 5;
/** Points at each end of a track used for its size and heading. */
const END_POINTS = 5;
/** A heading is carried across at most this many frames of a gap. */
const PREDICT_FRAMES = 15;
/** A track needs this many points before its usual box (see `usualBox`) means anything. */
const USUAL_MIN_POINTS = 3;

interface LiveTrack {
  track: Track;
  lastFrame: number;
  /** Box centre movement per frame, taken from the last two points. */
  vx: number;
  vy: number;
}

interface Pair {
  live: LiveTrack;
  detection: number;
  overlap: number;
  /** Distance between the detection's centre and where the track was heading. */
  drift: number;
}

function pairDrift(live: LiveTrack, box: Box, frame: number): number {
  const last = live.track.points[live.track.points.length - 1]!.box;
  const gap = frame - live.lastFrame;
  return Math.hypot(box.cx - (last.cx + live.vx * gap), box.cy - (last.cy + live.vy * gap));
}

/** The track's last box moved along its recent heading for `frames` frames (at most PREDICT_FRAMES). */
function headedBox(track: Track, frames: number): Box {
  const last = track.points[track.points.length - 1]!.box;
  const { vx, vy } = headingOf(track);
  const ahead = Math.min(frames, PREDICT_FRAMES);
  return { ...last, cx: last.cx + vx * ahead, cy: last.cy + vy * ahead };
}

/** Adds the detection to the track and updates the track's heading. */
function follow(live: LiveTrack, frameDetections: FrameDetections, detection: number, frame: number) {
  const person = frameDetections.people[detection]!;
  const previous = live.track.points[live.track.points.length - 1]!;
  const elapsed = frame - previous.frame;
  live.vx = (person.box.cx - previous.box.cx) / elapsed;
  live.vy = (person.box.cy - previous.box.cy) / elapsed;
  live.lastFrame = frame;
  live.track.points.push({ frame, tMs: frameDetections.tMs, box: person.box, landmarks: person.landmarks, outline: person.outline });
}

/** The track's usual box: the median centre and size of its last END_POINTS boxes, so one odd box does not count. */
function usualBox(track: Track): Box {
  const recent = track.points.slice(-END_POINTS).map((p) => p.box);
  return {
    cx: median(recent.map((b) => b.cx)), cy: median(recent.map((b) => b.cy)),
    w: median(recent.map((b) => b.w)), h: median(recent.map((b) => b.h)),
  };
}

/**
 * Detections no track took this frame, matched to recently seen tracks that found no one, by
 * overlap with each track's usual box instead of its last one. Greedy, best overlap first.
 */
function secondChance(
  frameDetections: FrameDetections,
  frame: number,
  live: readonly LiveTrack[],
  usedTracks: Set<LiveTrack>,
  usedDetections: Set<number>,
  minIou: number,
) {
  const pairs: Pair[] = [];
  for (const l of live) {
    if (usedTracks.has(l) || frame - l.lastFrame - 1 > FRESH_GAP || l.track.points.length < USUAL_MIN_POINTS) continue;
    const usual = usualBox(l.track);
    frameDetections.people.forEach((person, detection) => {
      if (usedDetections.has(detection)) return;
      const overlap = iou(usual, person.box);
      if (overlap >= minIou) pairs.push({ live: l, detection, overlap, drift: pairDrift(l, person.box, frame) });
    });
  }
  pairs.sort((a, b) => b.overlap - a.overlap || byTieOrder(a, b));
  for (const pair of pairs) {
    if (usedTracks.has(pair.live) || usedDetections.has(pair.detection)) continue;
    usedTracks.add(pair.live);
    usedDetections.add(pair.detection);
    follow(pair.live, frameDetections, pair.detection, frame);
  }
}

function byTieOrder(a: Pair, b: Pair): number {
  return a.live.track.id - b.live.track.id || a.detection - b.detection;
}

/**
 * Links per-frame detections into tracks, one shot at a time. Greedy per frame by overlap with
 * each track's last box; near ties go to the pairing that keeps each box moving the way it was.
 * A cut ends every track. `shot` counts the cuts at or before the frame a track starts.
 */
export function linkTracks(
  frames: readonly FrameDetections[],
  cuts: readonly number[],
  options: LinkOptions = {},
): Track[] {
  const minIou = options.minIou ?? 0.3;
  const maxGap = options.maxGap ?? 15;
  const cutSet = new Set(cuts);
  const all: Track[] = [];
  let live: LiveTrack[] = [];

  frames.forEach((frameDetections, frame) => {
    if (cutSet.has(frame)) live = [];
    live = live.filter((l) => frame - l.lastFrame - 1 <= maxGap);

    const pairs: Pair[] = [];
    for (const l of live) {
      const last = l.track.points[l.track.points.length - 1]!.box;
      const missed = frame - l.lastFrame - 1;
      // A track lost for a while is looked for where it was heading, not where it was last seen.
      const near = missed <= FRESH_GAP ? last : headedBox(l.track, frame - l.lastFrame);
      frameDetections.people.forEach((person, detection) => {
        const overlap = iou(near, person.box);
        if (overlap >= minIou) pairs.push({ live: l, detection, overlap, drift: pairDrift(l, person.box, frame) });
      });
    }

    const usedTracks = new Set<LiveTrack>();
    const usedDetections = new Set<number>();
    for (;;) {
      const open = pairs.filter((p) => !usedTracks.has(p.live) && !usedDetections.has(p.detection));
      if (open.length === 0) break;
      const fresh = open.filter((p) => frame - p.live.lastFrame - 1 <= FRESH_GAP);
      const pool = fresh.length > 0 ? fresh : open;
      const best = Math.max(...pool.map((p) => p.overlap));
      const contenders = pool.filter((p) => p.overlap >= best - NEAR_TIE);
      contenders.sort((a, b) => a.drift - b.drift || b.overlap - a.overlap || byTieOrder(a, b));
      const chosen = contenders[0]!;
      usedTracks.add(chosen.live);
      usedDetections.add(chosen.detection);
      follow(chosen.live, frameDetections, chosen.detection, frame);
    }

    // Second chance before a new track starts: a track that found no one this frame is compared
    // again with its usual box (the median of its last few), so one odd box (an arm thrown out, a
    // box that slid onto the next dancer) does not lose the person it was following.
    secondChance(frameDetections, frame, live, usedTracks, usedDetections, minIou);

    frameDetections.people.forEach((person, detection) => {
      if (usedDetections.has(detection)) return;
      const track: Track = {
        id: all.length,
        shot: cuts.filter((c) => c <= frame).length,
        points: [{ frame, tMs: frameDetections.tMs, box: person.box, landmarks: person.landmarks, outline: person.outline }],
      };
      all.push(track);
      live.push({ track, lastFrame: frame, vx: 0, vy: 0 });
    });
  });

  return all;
}

export interface RejoinOptions {
  /** Most frames between the end of one piece and the start of the next. About 3 seconds at 15 a second. */
  maxGap?: number;
  /** Frame width over height, so a sideways step is measured like an upright one. */
  aspect?: number;
}

/** A piece may start this many box heights from where the earlier one ended (or was heading) after a one frame gap... */
const BASE_JUMP = 0.75;
/** ...plus this much for each further frame of gap, since people drift while lost... */
const DRIFT_PER_FRAME = 0.02;
/** ...but never more than this. */
const MAX_JUMP = 1.5;
/** Each frame of gap costs this many box heights, so a close piece soon after beats a close piece much later. */
const GAP_COST = 0.01;
/** A piece whose boxes are more than this many times taller or shorter is someone else. */
const MAX_SIZE_RATIO = 1.5;
/** Joins within this many box heights of the best count as a near tie, settled by how alike the two poses are... */
const REJOIN_TIE = 0.1;
/** ...when their pose differences are at least this far apart, in box heights; closer than that, the cost decides. */
const POSE_TIE = 0.05;
const MIN_VISIBILITY = 0.5;

interface Join { from: Track; to: Track; cost: number; poseDifference: number }

/** Box centre movement per frame over the piece's last few points. */
function headingOf(track: Track): { vx: number; vy: number } {
  const last = track.points[track.points.length - 1]!;
  const earlier = track.points[Math.max(0, track.points.length - 1 - END_POINTS)]!;
  const frames = last.frame - earlier.frame;
  if (frames <= 0) return { vx: 0, vy: 0 };
  return { vx: (last.box.cx - earlier.box.cx) / frames, vy: (last.box.cy - earlier.box.cy) / frames };
}

/** Distance from (x, y) to the box centre, in box heights `h`. */
function distanceTo(x: number, y: number, box: Box, aspect: number, h: number): number {
  return Math.hypot((box.cx - x) * aspect, box.cy - y) / h;
}

/**
 * How unlike two poses are: the mean distance between matching landmarks seen in both, each
 * measured from its own box centre, in box heights. Infinity when no landmark is seen in both.
 */
function poseDifference(a: TrackPoint, b: TrackPoint, aspect: number): number {
  const h = (a.box.h + b.box.h) / 2;
  let total = 0;
  let seen = 0;
  const count = Math.min(a.landmarks.length, b.landmarks.length);
  for (let k = 0; k < count; k++) {
    const p = a.landmarks[k]!;
    const q = b.landmarks[k]!;
    if (p[2] < MIN_VISIBILITY || q[2] < MIN_VISIBILITY) continue;
    total += Math.hypot(((p[0] - a.box.cx) - (q[0] - b.box.cx)) * aspect, (p[1] - a.box.cy) - (q[1] - b.box.cy)) / h;
    seen++;
  }
  return seen === 0 ? Infinity : total / seen;
}

function joinBetween(from: Track, to: Track, maxGap: number, aspect: number): Join | null {
  if (from === to || from.shot !== to.shot) return null;
  const end = from.points[from.points.length - 1]!;
  const start = to.points[0]!;
  const gap = start.frame - end.frame;
  if (gap < 1 || gap > maxGap) return null;
  const endHeight = median(from.points.slice(-END_POINTS).map((p) => p.box.h));
  const startHeight = median(to.points.slice(0, END_POINTS).map((p) => p.box.h));
  if (Math.max(endHeight, startHeight) > MAX_SIZE_RATIO * Math.min(endHeight, startHeight)) return null;
  const h = Math.max((endHeight + startHeight) / 2, 1e-6);
  const headed = headedBox(from, gap);
  const fromLast = distanceTo(end.box.cx, end.box.cy, start.box, aspect, h);
  const fromHeading = distanceTo(headed.cx, headed.cy, start.box, aspect, h);
  // Near either spot is close enough; the cost weighs both, so two people lost while crossing are
  // matched by where each was heading rather than swapped.
  if (Math.min(fromLast, fromHeading) > Math.min(MAX_JUMP, BASE_JUMP + DRIFT_PER_FRAME * (gap - 1))) return null;
  const cost = (fromLast + fromHeading) / 2 + GAP_COST * gap;
  return { from, to, cost, poseDifference: poseDifference(end, start, aspect) };
}

/**
 * Joins the pieces of one person that linking split apart: the pose model drops a dancer who is
 * hidden or at the back for a while, and they come back as a new track. A piece joins an earlier
 * one in the same shot when the earlier one ended before it starts (they never overlap in time),
 * the gap is at most `maxGap`, it starts near where the earlier one ended or was heading, allowing
 * more drift the longer the gap, and its boxes are a similar size. When several joins compete, the
 * cheapest goes first (closest, then soonest); near ties go to the more alike pose. A joined track
 * keeps its first piece's id and shot. Tracks come back ordered by id.
 */
export function rejoinTracks(tracks: readonly Track[], options: RejoinOptions = {}): Track[] {
  const maxGap = options.maxGap ?? 45;
  const aspect = options.aspect ?? 1;
  const pieces = tracks.filter((t) => t.points.length > 0);
  const joins: Join[] = [];
  for (const from of pieces) {
    for (const to of pieces) {
      const join = joinBetween(from, to, maxGap, aspect);
      if (join) joins.push(join);
    }
  }

  const next = new Map<Track, Track>();
  const previous = new Map<Track, Track>();
  for (;;) {
    const open = joins.filter((j) => !next.has(j.from) && !previous.has(j.to));
    if (open.length === 0) break;
    const best = Math.min(...open.map((j) => j.cost));
    const contenders = open.filter((j) => j.cost <= best + REJOIN_TIE);
    const byPose = (a: Join, b: Join) =>
      a.poseDifference === b.poseDifference || Math.abs(a.poseDifference - b.poseDifference) < POSE_TIE ? 0
        : a.poseDifference < b.poseDifference ? -1 : 1;
    contenders.sort((a, b) => byPose(a, b) || a.cost - b.cost || a.from.id - b.from.id || a.to.id - b.to.id);
    const chosen = contenders[0]!;
    next.set(chosen.from, chosen.to);
    previous.set(chosen.to, chosen.from);
  }

  const joined: Track[] = [];
  for (const head of pieces) {
    if (previous.has(head)) continue;
    const points: TrackPoint[] = [];
    for (let piece: Track | undefined = head; piece; piece = next.get(piece)) points.push(...piece.points);
    joined.push({ id: head.id, shot: head.shot, points });
  }
  return joined.sort((a, b) => a.id - b.id);
}
