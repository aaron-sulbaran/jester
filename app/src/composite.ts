// The reveal: every player's recording fitted onto its clip character, in one frame.
// Pure glue between a clip guide (one character per guide) and the recordings; drawing is canvas only.
//   const roles = [{ timeline: deserializeTimeline(data), guide, name: "Ana" }, ...];
//   drawReveal(revealCanvas, roles, clipMediaMs, { clipAspect, winner });

import type { Guide } from "../../clip/src/types.ts";
import { composeFrame, drawComposite, winnerIndex } from "../../spikes/pose-match/reveal.mjs";

export interface RevealRole {
  /** A player's recording (recorder.finish() or deserializeTimeline()), times in clip media ms. */
  timeline: { aspect?: number; frames: { t: number; landmarks: unknown[] }[] };
  /** The clip character this player played. */
  guide: Guide;
  name?: string;
  /** The round score for this role; the highest is highlighted as the winner. */
  score?: number | null;
}

type Obj = { x: number; y: number; z: number; visibility: number };

/** The character's pose at clip media time `mediaMs`, as landmark objects (null if it is out of shot). */
export function characterPoseAt(guide: Guide, mediaMs: number): Obj[] | null {
  const frames = guide.timeline?.frames;
  if (!frames || frames.length === 0) return null;
  const t = mediaMs - guide.range.startMs; // the guide's timeline starts at 0 at range.startMs
  let best = frames[0]!;
  for (const f of frames) if (Math.abs(f.tMs - t) < Math.abs(best.tMs - t)) best = f;
  if (Math.abs(best.tMs - t) > 250 || !best.landmarks) return null;
  return best.landmarks.map(([x, y, visibility]) => ({ x, y, z: 0, visibility }));
}

/** Draws all roles at clip media time `mediaMs`. Returns the figures and the winner's index (-1 if no scores). */
export function drawReveal(canvas: HTMLCanvasElement, roles: RevealRole[], mediaMs: number, { clipAspect, winner, spreadX = 0 }: { clipAspect: number; winner?: number; spreadX?: number }) {
  const shown = roles.map((r) => ({ role: r, characterPose: characterPoseAt(r.guide, mediaMs) }));
  const figures = composeFrame(
    shown.filter((r) => r.characterPose).map((r) => ({ timeline: r.role.timeline, characterPose: r.characterPose!, name: r.role.name })),
    mediaMs,
    { playerAspect: 4 / 3, clipAspect },
  );
  // Players who all play the same character would draw on top of each other; spreadX moves them apart (image width fraction).
  if (spreadX) figures.forEach((fig: { pose: { x: number }[] | null }, i: number) => {
    const dx = (i - (figures.length - 1) / 2) * spreadX;
    if (fig.pose) for (const p of fig.pose) p.x += dx;
  });
  const best = winner ?? winnerIndex(roles.map((r) => r.score ?? null));
  drawComposite(canvas.getContext("2d")!, canvas.width, canvas.height, figures, { highlight: best });
  return { figures, winner: best };
}
