import type { Box, Guide } from "./types.ts";

/**
 * Where a subject is drawn on a canvas that does not show the clip (blind mode).
 * "fit": centred on the subject's own average position and scaled so it fills about 70 percent of
 * the canvas height, so its movement shows relative to where it usually stands.
 * "exact": the whole clip frame fitted into the canvas, so the subject sits where it was in the clip.
 */
export type Placement = "fit" | "exact";

/** Maps a normalized image point to canvas pixels: `x * source.width * scale + offsetX`, same for y. */
export interface View { scale: number; offsetX: number; offsetY: number }

const FILL = 0.7;
/** In "fit", the subject's whole range of movement stays inside this share of the canvas. */
const KEEP_INSIDE = 0.95;

type Extent = { left: number; right: number; top: number; bottom: number };

/** The subject's extent in source pixels at each frame: the outline's bounds, else the box. */
function extents(guide: Pick<Guide, "source" | "boxTrack" | "outlines">): Extent[] {
  const { width, height } = guide.source;
  const out: Extent[] = [];
  guide.boxTrack.frames.forEach((frame, i) => {
    const outline = guide.outlines[i];
    if (outline && outline.length >= 3) {
      let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
      for (const [x, y] of outline) {
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
      out.push({ left: left * width, right: right * width, top: top * height, bottom: bottom * height });
      return;
    }
    const box: Box | null = frame.box;
    if (!box) return;
    out.push({
      left: (box.cx - box.w / 2) * width, right: (box.cx + box.w / 2) * width,
      top: (box.cy - box.h / 2) * height, bottom: (box.cy + box.h / 2) * height,
    });
  });
  return out;
}

export function placeSubject(
  guide: Pick<Guide, "source" | "boxTrack" | "outlines">,
  canvas: { width: number; height: number },
  placement: Placement,
): View {
  const { width: sw, height: sh } = guide.source;
  const exactScale = Math.min(canvas.width / sw, canvas.height / sh);
  const exact: View = { scale: exactScale, offsetX: (canvas.width - sw * exactScale) / 2, offsetY: (canvas.height - sh * exactScale) / 2 };
  if (placement === "exact") return exact;

  const all = extents(guide);
  if (all.length === 0) return exact;
  let sumX = 0, sumY = 0, sumH = 0;
  for (const e of all) { sumX += (e.left + e.right) / 2; sumY += (e.top + e.bottom) / 2; sumH += e.bottom - e.top; }
  const meanX = sumX / all.length;
  const meanY = sumY / all.length;
  const meanH = sumH / all.length;
  if (meanH <= 0) return exact;
  const reachX = Math.max(...all.map((e) => Math.max(meanX - e.left, e.right - meanX)));
  const reachY = Math.max(...all.map((e) => Math.max(meanY - e.top, e.bottom - meanY)));
  let scale = (FILL * canvas.height) / meanH;
  if (reachX > 0) scale = Math.min(scale, (KEEP_INSIDE * canvas.width) / 2 / reachX);
  if (reachY > 0) scale = Math.min(scale, (KEEP_INSIDE * canvas.height) / 2 / reachY);
  return { scale, offsetX: canvas.width / 2 - meanX * scale, offsetY: canvas.height / 2 - meanY * scale };
}
