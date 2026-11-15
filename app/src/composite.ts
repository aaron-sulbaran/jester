// The reveal: every player's recording fitted onto its clip character, in one frame.
// Pure glue between a clip guide (one character per guide) and the recordings; drawing is canvas only.
//   const roles = [{ timeline: deserializeTimeline(data), guide, name: "Ana" }, ...];
//   drawReveal(revealCanvas, roles, clipMediaMs, { clipAspect, winner });

import type { Guide } from "../../clip/src/types.ts";
import { composeFrame, drawComposite } from "../../spikes/pose-match/reveal.mjs";

export interface RevealRole {
  /** A player's recording (recorder.finish() or deserializeTimeline()), times in clip media ms. */
  timeline: { aspect?: number; frames: { t: number; landmarks: unknown[] }[] };
  /** The clip character this player played. */
  guide: Guide;
  name?: string;
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

export function drawReveal(canvas: HTMLCanvasElement, roles: RevealRole[], mediaMs: number, { clipAspect, winner = -1 }: { clipAspect: number; winner?: number }) {
  const withCharacter = roles.map((r) => ({ timeline: r.timeline, characterPose: characterPoseAt(r.guide, mediaMs), name: r.name }));
  const figures = composeFrame(
    withCharacter.filter((r) => r.characterPose).map((r) => ({ ...r, characterPose: r.characterPose! })),
    mediaMs,
    { playerAspect: 4 / 3, clipAspect },
  );
  drawComposite(canvas.getContext("2d")!, canvas.width, canvas.height, figures, { highlight: winner });
  return figures;
}
