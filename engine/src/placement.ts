// Where the body is and how big it looks, on top of the limb angles.
//
// Two measures, from the shoulder midpoint (the anchor) and the torso length (the size) of each frame:
// - Relative moves (scored): each body against its own median position and size over the round, in its
//   own torso lengths, so camera distance and framing do not matter. Did the player step sideways,
//   dip, rise, and come closer or move away when the clip subject did?
// - Outline fit (shown, not scored): the player's position and size in the frame against the subject's,
//   as on the mirrored screen. Does the player stand where the subject stands, at the same size?

import { PLACEMENT, POSE } from "./constants.ts";
import { midpoint, MID, torsoLength } from "./geometry.ts";
import { clamp01, falloff } from "./scoring.ts";
import type { Landmarks, PlacementResult } from "./types.ts";

interface Place { x: number; y: number; size: number }

/** Anchor in image-height units (x scaled by aspect) and torso length, or null if either is not visible. */
function placeOf(lms: Landmarks, aspect: number): Place | null {
  if (!lms) return null;
  const a = midpoint(lms, MID.shoulder, aspect);
  if (a.v < POSE.minVisibility) return null;
  const size = torsoLength(lms, aspect);
  if (size === null) return null;
  return { x: a.x, y: a.y, size };
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Each frame's offset from the body's own median place, in its own median torso lengths, and log size change. */
function relative(places: (Place | null)[]) {
  const ok = places.filter((p): p is Place => p !== null);
  if (ok.length === 0) return places.map(() => null);
  const hx = median(ok.map((p) => p.x)), hy = median(ok.map((p) => p.y)), hs = median(ok.map((p) => p.size));
  return places.map((p) => (p ? { dx: (p.x - hx) / hs, dy: (p.y - hy) / hs, ds: Math.log(p.size / hs) } : null));
}

function relCredit(posErr: number, sizeErr: number): number {
  const P = PLACEMENT;
  return P.positionShare * falloff(posErr, P.posFullTorsos, P.posZeroTorsos) + (1 - P.positionShare) * falloff(sizeErr, P.sizeFullLog, P.sizeZeroLog);
}

/**
 * Score placement for the frames the pose round matched. `frameMatch[i]` is the reference frame for
 * player frame i (or -1). `playerGrid` is already mirrored, so it reads like the mirrored screen.
 */
export function scorePlacement(
  refGrid: readonly Landmarks[], playerGrid: readonly Landmarks[], frameMatch: readonly number[],
  refAspect: number, playerAspect: number,
): PlacementResult {
  const P = PLACEMENT;
  const refPlaces = refGrid.map((l) => placeOf(l, refAspect));
  const playerPlaces = playerGrid.map((l) => placeOf(l, playerAspect));
  const refRel = relative(refPlaces), playerRel = relative(playerPlaces);

  let matched = 0, n = 0, sum = 0, stillSum = 0, side = 0, vert = 0, dist = 0;
  let fitSum = 0, sizeLogSum = 0, sideOffsetSum = 0;
  for (let i = 0; i < frameMatch.length; i++) {
    const j = frameMatch[i]!;
    if (j < 0) continue;
    matched++;
    const r = refRel[j], p = playerRel[i], rp = refPlaces[j], pp = playerPlaces[i];
    if (!r || !p || !rp || !pp) continue;
    n++;
    const ex = p.dx - r.dx, ey = p.dy - r.dy, es = Math.abs(p.ds - r.ds);
    sum += relCredit(Math.hypot(ex, ey), es);
    stillSum += relCredit(Math.hypot(r.dx, r.dy), Math.abs(r.ds));
    side += Math.abs(ex); vert += Math.abs(ey); dist += es;

    // Outline: both anchors measured from their frame's center line, in image-height units.
    const ox = (pp.x - playerAspect / 2) - (rp.x - refAspect / 2), oy = pp.y - rp.y;
    const sizeLog = Math.log(pp.size / rp.size);
    fitSum += P.positionShare * falloff(Math.hypot(ox, oy) / rp.size, P.outlinePosFullTorsos, P.outlinePosZeroTorsos)
      + (1 - P.positionShare) * falloff(Math.abs(sizeLog), P.sizeFullLog, P.sizeZeroLog);
    sizeLogSum += sizeLog;
    sideOffsetSum += ox / rp.size;
  }

  const enough = matched > 0 && n >= P.minFrameShare * matched;
  const credit = n > 0 ? sum / n : 0;
  const stillBaseline = n > 0 ? stillSum / n : 1;
  const headroom = 1 - stillBaseline;
  // The clip must travel enough for standing in place to lose real credit; otherwise there is nothing to score.
  const used = enough && headroom >= P.minHeadroom;
  const gain = used ? clamp01((credit - stillBaseline) / headroom) : 0;
  const worstIdx = [side / P.posZeroTorsos, vert / P.posZeroTorsos, dist / P.sizeZeroLog];
  const worst = !used || n === 0 ? null : (["sideways", "up-down", "distance"] as const)[worstIdx.indexOf(Math.max(...worstIdx))]!;
  const meanSizeLog = n > 0 ? sizeLogSum / n : 0, meanSide = n > 0 ? sideOffsetSum / n : 0;
  return {
    used, credit, stillBaseline, gain, worst,
    outlineFit: enough ? Math.round((100 * fitSum) / n) : null,
    outlineHints: {
      distance: !enough ? null : meanSizeLog > P.sizeFullLog ? "back" : meanSizeLog < -P.sizeFullLog ? "closer" : null,
      // On the mirrored screen, appearing right of the subject means moving to your left fixes it.
      side: !enough ? null : meanSide > P.outlinePosFullTorsos ? "left" : meanSide < -P.outlinePosFullTorsos ? "right" : null,
    },
  };
}
