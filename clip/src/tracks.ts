import { iou } from "./boxes.ts";
import type { Box, FrameDetections, Track } from "./types.ts";

export interface LinkOptions {
  /** A detection joins a track only when its overlap with the track's last box is at least this. */
  minIou?: number;
  /** A track survives this many frames without a match; one more ends it. */
  maxGap?: number;
}

/** Overlaps within this of the best one count as a near tie, settled by direction of travel. */
const NEAR_TIE = 0.1;

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
  const maxGap = options.maxGap ?? 5;
  const cutSet = new Set(cuts);
  const all: Track[] = [];
  let live: LiveTrack[] = [];

  frames.forEach((frameDetections, frame) => {
    if (cutSet.has(frame)) live = [];
    live = live.filter((l) => frame - l.lastFrame - 1 <= maxGap);

    const pairs: Pair[] = [];
    for (const l of live) {
      const last = l.track.points[l.track.points.length - 1]!.box;
      frameDetections.people.forEach((person, detection) => {
        const overlap = iou(last, person.box);
        if (overlap >= minIou) pairs.push({ live: l, detection, overlap, drift: pairDrift(l, person.box, frame) });
      });
    }

    const usedTracks = new Set<LiveTrack>();
    const usedDetections = new Set<number>();
    for (;;) {
      const open = pairs.filter((p) => !usedTracks.has(p.live) && !usedDetections.has(p.detection));
      if (open.length === 0) break;
      const best = Math.max(...open.map((p) => p.overlap));
      const contenders = open.filter((p) => p.overlap >= best - NEAR_TIE);
      contenders.sort((a, b) => a.drift - b.drift || b.overlap - a.overlap || byTieOrder(a, b));
      const chosen = contenders[0]!;
      usedTracks.add(chosen.live);
      usedDetections.add(chosen.detection);
      const person = frameDetections.people[chosen.detection]!;
      const previous = chosen.live.track.points[chosen.live.track.points.length - 1]!;
      const elapsed = frame - previous.frame;
      chosen.live.vx = (person.box.cx - previous.box.cx) / elapsed;
      chosen.live.vy = (person.box.cy - previous.box.cy) / elapsed;
      chosen.live.lastFrame = frame;
      chosen.live.track.points.push({ frame, tMs: frameDetections.tMs, box: person.box, landmarks: person.landmarks, outline: person.outline });
    }

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
