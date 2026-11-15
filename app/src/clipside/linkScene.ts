// A blind mode scene from a link grab: the roles the player ticked. A link's video is never kept, so
// the scene has no video; blind mode then draws the clip's own subjects as figures on a plain stage,
// as it does for the drawn demo scenes.
//
//   const scene = linkScene(prepared, ["Person 1", "Sports ball 1"], "Pickup game");
//   if (scene.error === null) await runBlindGame(scene.data, names, ui, deps);
//
//   const later = await loadLinkScene("yt:abcdefghijk:12000-27000", ["Person 1"], "Pickup game");

import type { Box, Guide, Outline } from "../../../clip/src/index.ts";
import type { Scene } from "../blind.ts";
import { subjectGuides, type Prepared } from "./analyze.ts";
import { loadGrab } from "./grab.ts";

type Result<T> = { data: T; error: null } | { data: null; error: string };

export const NO_ROLES = "Tick at least one role to play.";
const NOT_SAVED = "Those moves are not saved on this device. Grab them again.";

/** A box as a closed ellipse, as blind.ts gives things with no outline (the same 24 points). */
function ellipseOutline(b: Box, n = 24): Outline {
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return [b.cx + (b.w / 2) * Math.cos(a), b.cy + (b.h / 2) * Math.sin(a)] as [number, number];
  });
}

/** Things always get an outline to show, exactly as blind.ts's `videoScene` does it. */
function withThingOutlines(g: Guide): Guide {
  if (g.subject.kind !== "thing") return g;
  return { ...g, outlines: g.boxTrack.frames.map((f, i) => g.outlines[i] ?? (f.box ? ellipseOutline(f.box) : null)) };
}

/**
 * The scene for the subjects named in `labels` ("Person 1", "Sports ball 1"), in the order the clip
 * side ranks them. Every guide from `subjectGuides` covers the same stretch, so the scene does too.
 */
export function linkScene(prepared: Prepared, labels: readonly string[], name: string): Result<Scene> {
  const wanted = new Set(labels);
  const guides = subjectGuides(prepared).guides.filter((g) => wanted.has(g.subject.label));
  const first = guides[0];
  if (!first) return { data: null, error: NO_ROLES };
  return {
    data: {
      name, width: first.source.width, height: first.source.height,
      startMs: first.range.startMs, durationMs: first.range.endMs - first.range.startMs,
      guides: guides.map(withThingOutlines), video: null,
    },
    error: null,
  };
}

/** The same from a saved grab's key, for a screen that only has the key and the labels. */
export async function loadLinkScene(key: string, labels: readonly string[], name: string): Promise<Result<Scene>> {
  const prepared = await loadGrab(key);
  if (!prepared) return { data: null, error: NOT_SAVED };
  return linkScene(prepared, labels, name);
}
