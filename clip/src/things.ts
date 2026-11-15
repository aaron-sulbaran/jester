// Things as subjects: boxes from the object detector, followed through each shot, ranked, and
// turned into box-track/1 guides for the engine's trajectory channel. Pure: no DOM, no clock.
//
// The detector runs on every third analysed frame, so a ThingFrame with `things: null` means
// "not looked at", not "nothing there". Tracks are filled by straight interpolation so every
// analysed frame between a thing's first and last sighting has a box.

import { constants } from "../../engine/src/index.ts";
import type { BoxFrame, BoxTrack } from "../../engine/src/index.ts";
import { iou } from "./boxes.ts";
import { shotEndMs } from "./guide.ts";
import type { Box, ClipSource, Guide, Outline, Pace } from "./types.ts";

/** One thing the object detector found in one frame. `category` is the model's name, such as "dog". */
export interface ThingDetection { box: Box; category: string; score: number }

/** One analysed frame. `things` is null on frames the object detector skipped. */
export interface ThingFrame { tMs: number; things: ThingDetection[] | null }

/** One thing in one analysed frame. `detected` is false where the box was filled in between sightings. */
export interface ThingPoint { frame: number; tMs: number; box: Box; detected: boolean }

/** One thing followed through one shot. Points cover every analysed frame from first to last sighting. */
export interface ThingTrack { id: number; category: string; shot: number; points: ThingPoint[] }

export interface ThingCandidate {
  trackId: number;
  /** Rank among things, from 1. */
  number: number;
  /** "Dog 1", "Ball 2" and so on, numbered within the category in rank order. */
  label: string;
  category: string;
  score: number;
  /** False when the box never moves enough for the engine to score a copy. */
  moves: boolean;
}

export const THING_STILL = "This one does not move, so there is nothing to copy.";
export const THING_OTHER_SHOT = "This thing is in a different shot of the clip.";
const NOT_FOUND = "That thing is not one of the things found in this clip.";

export interface ThingLinkOptions {
  /** Image width over height, so sideways and up-down distances compare fairly. Default 1. */
  aspect?: number;
  /** Overlap with the track's last box that always counts as the same thing. Default 0.2. */
  minIou?: number;
  /** A track survives this many analysed frames without a sighting; one more ends it. Default 15. */
  maxGap?: number;
  /**
   * Without overlap, a sighting still joins when its centre is within this many box sizes per
   * analysed frame since the last sighting (fast small things, such as a thrown ball). Default 1.5.
   */
  maxJumpPerFrame?: number;
}

type Result<T> = { data: T; error: null } | { data: null; error: string };

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return NaN;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The larger side of the box, in image heights. */
function sizeOf(box: Box, aspect: number): number {
  return Math.max(box.h, box.w * aspect);
}

function lerpBox(a: Box, b: Box, share: number): Box {
  return {
    cx: a.cx + (b.cx - a.cx) * share,
    cy: a.cy + (b.cy - a.cy) * share,
    w: a.w + (b.w - a.w) * share,
    h: a.h + (b.h - a.h) * share,
  };
}

/**
 * Drops thing boxes that are mostly a person the pose tracker already follows: overlap above
 * `maxOverlap` with any person box in the same frame. `peopleBoxes[i]` belongs to `frames[i]`.
 */
export function withoutPeople(
  frames: readonly ThingFrame[],
  peopleBoxes: readonly (readonly Box[])[],
  maxOverlap = 0.6,
): ThingFrame[] {
  return frames.map((frame, i) => {
    if (frame.things === null) return frame;
    const people = peopleBoxes[i] ?? [];
    return { tMs: frame.tMs, things: frame.things.filter((t) => people.every((p) => iou(p, t.box) <= maxOverlap)) };
  });
}

interface LiveThing { track: ThingTrack; lastFrame: number }

interface ThingPair { live: LiveThing; detection: number; overlap: number; jump: number }

/**
 * Links sightings of the same category into tracks, one shot at a time, greedy per looked-at
 * frame: most overlap first, then the nearest centre. A cut ends every track. Gaps between
 * sightings are filled by straight interpolation.
 */
export function linkThings(
  frames: readonly ThingFrame[],
  cuts: readonly number[],
  options: ThingLinkOptions = {},
): ThingTrack[] {
  const aspect = options.aspect ?? 1;
  const minIou = options.minIou ?? 0.2;
  const maxGap = options.maxGap ?? 15;
  const maxJumpPerFrame = options.maxJumpPerFrame ?? 1.5;
  const cutSet = new Set(cuts);
  const all: ThingTrack[] = [];
  let live: LiveThing[] = [];

  frames.forEach((frameData, frame) => {
    if (cutSet.has(frame)) live = [];
    const things = frameData.things;
    if (things === null) return;
    live = live.filter((l) => frame - l.lastFrame - 1 <= maxGap);

    const pairs: ThingPair[] = [];
    for (const l of live) {
      const last = l.track.points[l.track.points.length - 1]!.box;
      const elapsed = frame - l.lastFrame;
      things.forEach((thing, detection) => {
        if (thing.category !== l.track.category) return;
        const overlap = iou(last, thing.box);
        const size = Math.max(sizeOf(last, aspect), sizeOf(thing.box, aspect), 1e-6);
        const jump = Math.hypot((thing.box.cx - last.cx) * aspect, thing.box.cy - last.cy) / size;
        if (overlap >= minIou || jump <= maxJumpPerFrame * elapsed) pairs.push({ live: l, detection, overlap, jump });
      });
    }
    pairs.sort((a, b) => b.overlap - a.overlap || a.jump - b.jump
      || a.live.track.id - b.live.track.id || a.detection - b.detection);

    const usedTracks = new Set<LiveThing>();
    const usedDetections = new Set<number>();
    for (const pair of pairs) {
      if (usedTracks.has(pair.live) || usedDetections.has(pair.detection)) continue;
      usedTracks.add(pair.live);
      usedDetections.add(pair.detection);
      pair.live.lastFrame = frame;
      pair.live.track.points.push({ frame, tMs: frameData.tMs, box: things[pair.detection]!.box, detected: true });
    }

    things.forEach((thing, detection) => {
      if (usedDetections.has(detection)) return;
      const track: ThingTrack = {
        id: all.length,
        category: thing.category,
        shot: cuts.filter((c) => c <= frame).length,
        points: [{ frame, tMs: frameData.tMs, box: thing.box, detected: true }],
      };
      all.push(track);
      live.push({ track, lastFrame: frame });
    });
  });

  return all.map((track) => fillGaps(track, frames));
}

/** Adds an interpolated point for every analysed frame between two sightings. */
function fillGaps(track: ThingTrack, frames: readonly ThingFrame[]): ThingTrack {
  const points: ThingPoint[] = [];
  track.points.forEach((point, i) => {
    const previous = track.points[i - 1];
    if (previous) {
      const span = point.frame - previous.frame;
      for (let f = previous.frame + 1; f < point.frame; f++) {
        const share = (f - previous.frame) / span;
        points.push({ frame: f, tMs: frames[f]!.tMs, box: lerpBox(previous.box, point.box, share), detected: false });
      }
    }
    points.push(point);
  });
  return { ...track, points };
}

/** How far the box centre moves per analysed frame, in box heights (mean over neighbouring points). */
export function thingMotionPerFrame(track: ThingTrack, aspect = 1): number {
  let total = 0;
  let pairs = 0;
  for (let i = 1; i < track.points.length; i++) {
    const a = track.points[i - 1]!.box;
    const b = track.points[i]!.box;
    if (a.h <= 0) continue;
    total += Math.hypot((b.cx - a.cx) * aspect, b.cy - a.cy) / a.h;
    pairs++;
  }
  return pairs === 0 ? 0 : total / pairs;
}

function percentile(values: readonly number[], share: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const at = share * (sorted.length - 1);
  const low = Math.floor(at);
  const high = Math.min(sorted.length - 1, low + 1);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (at - low);
}

/** Which ways the boxes move enough for the engine to score: the trajectory channel's own test (p95 minus p5, in median box heights). */
function movingAxes(boxes: readonly Box[], aspect: number): { x: boolean; y: boolean; h: boolean } {
  const scale = median(boxes.map((b) => b.h));
  if (!(scale > 0)) return { x: false, y: false, h: false };
  const range = (values: number[]) => percentile(values, 0.95) - percentile(values, 0.05);
  const { minRangeX, minRangeY } = constants.TRAJECTORY;
  return {
    x: range(boxes.map((b) => (b.cx * aspect) / scale)) >= minRangeX,
    y: range(boxes.map((b) => b.cy / scale)) >= minRangeY,
    h: range(boxes.map((b) => b.h / scale)) >= minRangeY,
  };
}

/** True when the box moves enough for the engine to have something to score. */
export function thingMoves(track: ThingTrack, aspect = 1): boolean {
  const axes = movingAxes(track.points.map((p) => p.box), aspect);
  return axes.x || axes.y || axes.h;
}

const WEIGHTS = { size: 0.35, central: 0.2, motion: 0.25, onScreen: 0.2 } as const;
/** Centre movement of this many box heights per analysed frame earns the full motion score. */
const FULL_MOTION = 0.1;

/** "dog" to "Dog", "sports ball" to "Ball". */
export function thingName(category: string): string {
  const name = category === "sports ball" ? "ball" : category;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Ranks things worth offering as a subject, best first, by size, how central, how much the box
 * centre moves, and time on screen. A track needs at least one second of frames (`sampleHz`).
 */
export function rankThings(
  tracks: readonly ThingTrack[],
  info: { sampleHz: number; frameCount: number; aspect?: number },
): ThingCandidate[] {
  const aspect = info.aspect ?? 1;
  const scored = tracks
    .filter((track) => track.points.length >= info.sampleHz)
    .map((track) => {
      const size = clamp01(median(track.points.map((p) => sizeOf(p.box, aspect))));
      const central = clamp01(1 - 2 * Math.abs(median(track.points.map((p) => p.box.cx)) - 0.5));
      const motion = clamp01(thingMotionPerFrame(track, aspect) / FULL_MOTION);
      const onScreen = clamp01(track.points.length / Math.max(1, info.frameCount));
      const score = WEIGHTS.size * size + WEIGHTS.central * central + WEIGHTS.motion * motion + WEIGHTS.onScreen * onScreen;
      return { track, score };
    })
    .sort((a, b) => b.score - a.score || a.track.id - b.track.id);
  const perCategory = new Map<string, number>();
  return scored.map(({ track, score }, i) => {
    const count = (perCategory.get(track.category) ?? 0) + 1;
    perCategory.set(track.category, count);
    return {
      trackId: track.id,
      number: i + 1,
      label: `${thingName(track.category)} ${count}`,
      category: track.category,
      score,
      moves: thingMoves(track, aspect),
    };
  });
}

/** An ellipse inside the box as a closed outline of `points` points (24, as the blind mode game draws a thing). */
export function boxEllipse(box: Box, points = 24): Outline {
  return Array.from({ length: points }, (_, i) => {
    const angle = (2 * Math.PI * i) / points;
    return [box.cx + (box.w / 2) * Math.cos(angle), box.cy + (box.h / 2) * Math.sin(angle)] as [number, number];
  });
}

/** The box as a closed four point outline, clockwise from top left. */
export function boxPolygon(box: Box): Outline {
  const left = box.cx - box.w / 2;
  const right = box.cx + box.w / 2;
  const top = box.cy - box.h / 2;
  const bottom = box.cy + box.h / 2;
  return [[left, top], [right, top], [right, bottom], [left, bottom]];
}

const SLOW_BELOW = 0.3;
const MEDIUM_BELOW = 1.0;

/** How fast the thing moves, from box centre travel in box heights per second. */
export function thingPace(track: ThingTrack, sampleHz: number, aspect = 1): Pace {
  const perSecond = thingMotionPerFrame(track, aspect) * sampleHz;
  if (perSecond < SLOW_BELOW) return "slow";
  if (perSecond < MEDIUM_BELOW) return "medium";
  return "fast";
}

/**
 * The guide for one thing in its shot. Like a person's guide, time starts at 0 at the shot's
 * first frame, and frames where the thing is not on screen have a null box and outline. The
 * outline is an ellipse in the box (the detector gives no mask). A thing whose box never moves
 * is refused with THING_STILL.
 */
export function buildThingGuide(input: {
  fingerprint: string;
  source: ClipSource;
  frames: readonly { tMs: number }[];
  track: ThingTrack;
  shot: { start: number; end: number };
  label: string;
  warnings: string[];
}): Result<Guide> {
  const { source, frames, track, shot } = input;
  const aspect = source.width / source.height;
  if (!thingMoves(track, aspect)) return { data: null, error: THING_STILL };
  const pointByFrame = new Map(track.points.map((p) => [p.frame, p]));
  const startMs = frames[shot.start]!.tMs;
  const boxFrames: BoxFrame[] = [];
  const outlines: (Outline | null)[] = [];
  for (let f = shot.start; f < shot.end; f++) {
    const tMs = frames[f]!.tMs - startMs;
    const box = pointByFrame.get(f)?.box ?? null;
    boxFrames.push({ tMs, box });
    outlines.push(box ? boxEllipse(box) : null);
  }
  const guide: Guide = {
    schema: "guide/1",
    fingerprint: input.fingerprint,
    source,
    range: { startMs, endMs: shotEndMs(frames, shot, source) },
    subject: { kind: "thing", label: input.label },
    channel: "trajectory",
    timeline: null,
    boxTrack: { schema: "box-track/1", source: { width: source.width, height: source.height }, frames: boxFrames },
    outlines,
    keyMoments: [],
    pace: thingPace(track, source.sampleHz, aspect),
    warnings: input.warnings,
    check: null,
  };
  return { data: guide, error: null };
}

/** The frame range of the shot that starts after `cuts[shot - 1]`, end exclusive. */
function shotRange(frameCount: number, cuts: readonly number[], shot: number): { start: number; end: number } | null {
  const starts = [0, ...cuts];
  const start = starts[shot];
  if (start === undefined) return null;
  return { start, end: starts[shot + 1] ?? frameCount };
}

/**
 * A guide for every thing candidate, best first, and the reason for each one left out. Pass
 * `shot` to keep to one shot, as the people guides do, so every role shares one range.
 */
export function thingGuides(input: {
  fingerprint: string;
  source: ClipSource;
  frames: readonly { tMs: number }[];
  cuts: readonly number[];
  tracks: readonly ThingTrack[];
  candidates: readonly ThingCandidate[];
  warnings: string[];
  shot?: number;
}): { guides: Guide[]; skipped: { number: number; label: string; reason: string }[] } {
  const guides: Guide[] = [];
  const skipped: { number: number; label: string; reason: string }[] = [];
  for (const candidate of input.candidates) {
    const track = input.tracks.find((t) => t.id === candidate.trackId);
    const shot = track ? shotRange(input.frames.length, input.cuts, track.shot) : null;
    if (!track || !shot) {
      skipped.push({ number: candidate.number, label: candidate.label, reason: NOT_FOUND });
      continue;
    }
    if (input.shot !== undefined && track.shot !== input.shot) {
      skipped.push({ number: candidate.number, label: candidate.label, reason: THING_OTHER_SHOT });
      continue;
    }
    const result = buildThingGuide({
      fingerprint: input.fingerprint, source: input.source, frames: input.frames, track, shot,
      label: candidate.label, warnings: input.warnings,
    });
    if (result.error !== null) skipped.push({ number: candidate.number, label: candidate.label, reason: result.error });
    else guides.push(result.data);
  }
  return { guides, skipped };
}

/** The name a player reads for a thing: "Dog 1" to "dog", "Ball 2" to "ball". */
export function thingObjectName(label: string): string {
  return label.replace(/ \d+$/, "").toLowerCase();
}

/** One line telling the player how to copy the thing, from the ways its box moves. */
export function thingHint(guide: Pick<Guide, "boxTrack" | "subject">): string {
  const boxes = guide.boxTrack.frames.flatMap((f) => (f.box ? [f.box] : []));
  const axes = movingAxes(boxes, guide.boxTrack.source.width / guide.boxTrack.source.height);
  const moves = [
    ...(axes.x ? ["step sideways when it moves sideways"] : []),
    ...(axes.y ? ["jump or crouch when it rises and falls"] : []),
    ...(axes.h ? ["step closer when it grows and back when it shrinks"] : []),
  ];
  const name = thingObjectName(guide.subject.label);
  return moves.length ? `Copy the ${name}: ${moves.join(", and ")}.` : `Copy the ${name}.`;
}

/** The box at time `ms` on the track's own clock (the frame nearest it), or null outside the track or where the thing is not seen. */
export function boxTrackAt(track: BoxTrack, ms: number): Box | null {
  const frames = track.frames;
  const first = frames[0];
  const last = frames[frames.length - 1];
  if (!first || !last || ms < first.tMs || ms > last.tMs) return null;
  let low = 0;
  let high = frames.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (frames[mid]!.tMs <= ms) low = mid;
    else high = mid;
  }
  const nearest = ms - frames[low]!.tMs <= frames[high]!.tMs - ms ? frames[low]! : frames[high]!;
  return nearest.box;
}
