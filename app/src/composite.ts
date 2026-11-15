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

/** A thing role's box at clip media time `mediaMs` (null if out of shot or the guide has no box track). */
function boxAtMs(guide: Guide, mediaMs: number): { cx: number; cy: number; w: number; h: number } | null {
  const frames = guide.boxTrack?.frames;
  if (!frames || frames.length === 0) return null;
  const t = mediaMs - guide.range.startMs;
  let best = frames[0]!;
  for (const f of frames) if (Math.abs(f.tMs - t) < Math.abs(best.tMs - t)) best = f;
  return Math.abs(best.tMs - t) > 250 ? null : best.box;
}

/**
 * Draws all roles at clip media time `mediaMs`. People roles are the player's stick figure on the role's
 * place; thing roles (a ball, a dog) are a coloured disc at the thing's box, in the player's colour.
 * Returns the figures and the winner's index (-1 if no scores).
 */
export function drawReveal(canvas: HTMLCanvasElement, roles: RevealRole[], mediaMs: number, { clipAspect, winner, spreadX = 0 }: { clipAspect: number; winner?: number; spreadX?: number }) {
  // Keep every role (colour = its position in the list); a role with no character pose just draws nothing here.
  const figures = composeFrame(
    roles.map((r) => ({ timeline: r.timeline, characterPose: characterPoseAt(r.guide, mediaMs), name: r.name })),
    mediaMs,
    { playerAspect: 4 / 3, clipAspect },
  );
  if (spreadX) figures.forEach((fig: { pose: { x: number }[] | null }, i: number) => {
    const dx = (i - (figures.length - 1) / 2) * spreadX;
    if (fig.pose) for (const p of fig.pose) p.x += dx;
  });
  const best = winner ?? winnerIndex(roles.map((r) => r.score ?? null));
  const ctx = canvas.getContext("2d")!;
  drawComposite(ctx, canvas.width, canvas.height, figures, { highlight: best });
  roles.forEach((r, i) => {
    if (r.guide.timeline) return;
    const box = boxAtMs(r.guide, mediaMs);
    if (!box) return;
    ctx.globalAlpha = best < 0 || best === i ? 1 : 0.35;
    ctx.fillStyle = figures[i]!.color;
    ctx.beginPath();
    ctx.ellipse(box.cx * canvas.width, box.cy * canvas.height, Math.max(6, (box.w * canvas.width) / 2), Math.max(6, (box.h * canvas.height) / 2), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  });
  return { figures, winner: best };
}
