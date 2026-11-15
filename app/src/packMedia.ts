// Pictures that travel between players in an online game: a face still (for the crowning and the results badge)
// and the series of cutouts of the player's body (for the recap video). Both are packed as small WebP pictures
// inside one text string, because a room sends text. They go to the other players in the room only, never to a
// server's storage, and only after a round; the room page says so.

import type { Cutout } from "./cutout.ts";
import { dropShrunkCrops, packTier } from "./recapRules.ts";

const MAX_CHARS = 2_500_000;
/**
 * Size, WebP quality and the least gap between cutouts in ms, tried in turn until the pack fits. The first is the
 * size the cutouts are captured at (cutout.ts SIDE): a remote player is drawn about as large as a local one, so a
 * smaller copy is drawn several times its size on a tall reveal and smears.
 */
export const TIERS: readonly [number, number, number][] = [[256, 0.7, 200], [224, 0.65, 200], [192, 0.65, 200], [160, 0.6, 240], [128, 0.55, 280], [96, 0.5, 320]];
const SAFE_PREFIX = /^data:image\/(webp|png|jpeg);base64,/;

function toDataUrl(src: HTMLCanvasElement, size: number, quality: number): string {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  c.getContext("2d")!.drawImage(src, 0, 0, size, size);
  const webp = c.toDataURL("image/webp", quality);
  return webp.startsWith("data:image/webp") ? webp : c.toDataURL("image/png"); // a browser without WebP falls back to PNG
}

function loadCanvas(url: string, maxSide = Infinity): Promise<HTMLCanvasElement | null> {
  if (!SAFE_PREFIX.test(url)) return Promise.resolve(null); // only plain pictures from other players, never anything else
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      // A small file can still be a huge picture: past maxSide on a side it is never drawn into a canvas.
      if (img.naturalWidth > maxSide || img.naturalHeight > maxSide) { resolve(null); return; }
      const c = document.createElement("canvas");
      c.width = img.naturalWidth || 1; c.height = img.naturalHeight || 1;
      c.getContext("2d")!.drawImage(img, 0, 0);
      resolve(c);
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export function packFace(face: HTMLCanvasElement | null): string | null {
  return face ? toDataUrl(face, 160, 0.8) : null;
}

export async function unpackFace(text: string | undefined, maxSide?: number): Promise<HTMLCanvasElement | null> {
  return text ? loadCanvas(text, maxSide) : null;
}

/**
 * The player's cutouts as one string, thinned to about 5 a second and shrunk only as far as it must to fit a room's
 * message budget. A tier stops encoding as soon as it is over budget, so trying the larger sizes first costs little.
 */
export function packCutouts(cutouts: readonly Cutout[]): string {
  let text = JSON.stringify({ v: 1, items: [] });
  // Frames where the tracker lost the head are left out first, so the thinning below picks a whole body instead.
  cutouts = dropShrunkCrops(cutouts);
  packTier(TIERS.length, MAX_CHARS, (i) => {
    const [size, quality, gap] = TIERS[i]!;
    let last = -Infinity, chars = 0;
    const items: { t: number; a: unknown; d: string }[] = [];
    for (const c of cutouts) {
      if (c.clipMs - last < gap) continue;
      last = c.clipMs;
      const d = toDataUrl(c.image, size, quality);
      chars += d.length;
      if (chars > MAX_CHARS) return Infinity;
      items.push({ t: Math.round(c.clipMs), a: c.anchor ?? null, d });
    }
    const packed = JSON.stringify({ v: 1, items });
    if (packed.length <= MAX_CHARS) text = packed;
    return packed.length;
  });
  return text;
}

export async function unpackCutouts(text: string | undefined): Promise<Cutout[]> {
  if (!text) return [];
  try {
    const data = JSON.parse(text) as { v?: number; items?: { t?: unknown; a?: unknown; d?: unknown }[] };
    if (data.v !== 1 || !Array.isArray(data.items)) return [];
    const out = await Promise.all(data.items.slice(0, 600).map(async (it) => {
      if (typeof it.t !== "number" || typeof it.d !== "string") return null;
      const image = await loadCanvas(it.d);
      return image ? ({ clipMs: it.t, image, anchor: (it.a as Cutout["anchor"]) ?? null } as Cutout) : null;
    }));
    return out.filter((c): c is Cutout => c !== null).sort((a, b) => a.clipMs - b.clipMs);
  } catch {
    return [];
  }
}
