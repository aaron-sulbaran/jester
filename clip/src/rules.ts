import { median, motionPerFrame } from "./rank.ts";
import type { Candidate, Track } from "./types.ts";

export interface Verdict { refuse: string | null; warnings: string[] }

const MIN_DURATION_MS = 3000;
const MS_PER_CUT_ALLOWED = 2000;
const MIN_SHARE_OF_SHOT = 0.5;
const MIN_MEDIAN_HEIGHT = 0.25;
const STILL_BELOW = 0.002;

/** Refusals about the clip as a whole, checked in this order: too short, too many cuts, nobody in it. */
export function checkClip(input: {
  durationMs: number;
  cuts: readonly number[];
  candidates: readonly Candidate[];
}): Verdict {
  let refuse: string | null = null;
  if (input.durationMs < MIN_DURATION_MS) refuse = "This clip is under 3 seconds. Pick a longer one.";
  else if (input.cuts.length > input.durationMs / MS_PER_CUT_ALLOWED) refuse = "This clip cuts too often to follow one person.";
  else if (input.candidates.length === 0) refuse = "No person found in this clip.";
  return { refuse, warnings: [] };
}

/** Refusals and warnings about the person picked: out of view first, then too small, then a still warning. */
export function checkSubject(track: Track, shot: { start: number; end: number }): Verdict {
  const share = track.points.length / (shot.end - shot.start);
  if (share < MIN_SHARE_OF_SHOT) {
    return { refuse: "The person you picked is out of view for most of the clip.", warnings: [] };
  }
  if (median(track.points.map((p) => p.box.h)) < MIN_MEDIAN_HEIGHT) {
    return { refuse: "The person is too small in the frame. Pick a clip where they fill more of it.", warnings: [] };
  }
  const warnings = motionPerFrame(track) < STILL_BELOW
    ? ["Nothing much moves here. This will be a hold-this-pose round."]
    : [];
  return { refuse: null, warnings };
}
