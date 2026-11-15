// The cast a clip offers, as the Chamberlain checks it: one line per subject the game's analysis found, with
// when, where and how big it is seen. The tracker sometimes splits one object into several subjects (it loses a
// parked car while a dancer stands in front of it) or picks up something seen for a moment; these lines let the
// Chamberlain see that next to the frames. applyCast() then removes the things it found to be duplicates or
// not really there, before a clip goes into the bank. People are never removed here: their tracks are rejoined
// by the analysis itself, and a person is always a role.

import type { Box } from "../../clip/src/index.ts";

export interface CastLine {
  label: string;
  kind: "person" | "thing";
  /** Share of the stretch the subject is seen, 0 to 1. */
  seenShare: number;
  /** When it is seen, in seconds from the start of the stretch, as [from, to] spans (gaps over a second split them). */
  seen: [number, number][];
  /** Median centre and size of its box, as shares of the frame. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** How far its centre wanders, as the larger standard deviation of x and y. Near 0 for something parked. */
  drift: number;
}

interface CastGuide {
  subject: { kind: "person" | "thing"; label: string };
  boxTrack: { frames: readonly { tMs: number; box: Box | null }[] };
}

const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : 0;
};
const spread = (xs: number[]) => {
  if (!xs.length) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
};

export function castSummary(guides: readonly CastGuide[]): CastLine[] {
  return guides.map((g) => {
    const frames = g.boxTrack.frames;
    const seenFrames = frames.filter((f): f is { tMs: number; box: Box } => f.box !== null);
    const seen: [number, number][] = [];
    for (const f of seenFrames) {
      const t = round(f.tMs / 1000, 1);
      const last = seen[seen.length - 1];
      if (last && t - last[1] <= 1) last[1] = t;
      else seen.push([t, t]);
    }
    const xs = seenFrames.map((f) => f.box.cx), ys = seenFrames.map((f) => f.box.cy);
    return {
      label: g.subject.label, kind: g.subject.kind,
      seenShare: round(seenFrames.length / Math.max(1, frames.length)),
      seen,
      x: round(median(xs)), y: round(median(ys)),
      w: round(median(seenFrames.map((f) => f.box.w))), h: round(median(seenFrames.map((f) => f.box.h))),
      drift: round(Math.max(spread(xs), spread(ys)), 3),
    };
  });
}

/** One line per subject, for the Chamberlain's message. */
export function castText(cast: readonly CastLine[]): string {
  return cast.map((c) => `${c.label} (${c.kind}): seen ${c.seen.map(([a, b]) => `${a}-${b} s`).join(", ") || "never"} (${Math.round(c.seenShare * 100)} percent), centre x ${c.x} y ${c.y}, size ${c.w} by ${c.h}, drift ${c.drift}`).join("\n");
}

/**
 * The guides without the things in `drops`. Never removes a person, and never leaves no subject: a drop list
 * that would empty the cast is ignored.
 */
export function applyCast<T extends CastGuide>(guides: readonly T[], drops: readonly string[]): T[] {
  const dropped = new Set(drops);
  // Only a subject that is plainly a thing is ever removed; anything else, people included, stays.
  const kept = guides.filter((g) => g.subject.kind !== "thing" || !dropped.has(g.subject.label));
  return kept.length ? kept : [...guides];
}
