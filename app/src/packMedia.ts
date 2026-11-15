// Pictures that travel between players in an online game: a face still (for the crowning and the results badge)
// and the series of cutouts of the player's body (for the recap video). Both are packed as small WebP pictures
// inside one text string, because a room sends text. They go to the other players in the room only, never to a
// server's storage, and only after a round; the room page says so.

import type { Cutout } from "./cutout.ts";

const MAX_CHARS = 2_500_000;
/** Size, WebP quality and the least gap between cutouts in ms, tried in turn until the pack fits. */
const TIERS: readonly [number, number, number][] = [[192, 0.65, 200], [160, 0.6, 240], [128, 0.55, 280], [96, 0.5, 320]];
const SAFE_PREFIX = /^data:image\/(webp|png|jpeg);base64,/;

function toDataUrl(src: HTMLCanvasElement, size: number, quality: number): string {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  c.getContext("2d")!.drawImage(src, 0, 0, size, size);
  const webp = c.toDataURL("image/webp", quality);
  return webp.startsWith("data:image/webp") ? webp : c.toDataURL("image/png"); // a browser without WebP falls back to PNG
}

function loadCanvas(url: string): Promise<HTMLCanvasElement | null> {
  if (!SAFE_PREFIX.test(url)) return Promise.resolve(null); // only plain pictures from other players, never anything else
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
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

export async function unpackFace(text: string | undefined): Promise<HTMLCanvasElement | null> {
  return text ? loadCanvas(text) : null;
}

/** The player's cutouts as one string, thinned to about 5 a second and shrunk until it fits a room's message budget. */
export function packCutouts(cutouts: readonly Cutout[]): string {
  for (const [size, quality, gap] of TIERS) {
    let last = -Infinity;
    const items: { t: number; a: unknown; d: string }[] = [];
    for (const c of cutouts) {
      if (c.clipMs - last < gap) continue;
      last = c.clipMs;
      items.push({ t: Math.round(c.clipMs), a: c.anchor ?? null, d: toDataUrl(c.image, size, quality) });
    }
    const text = JSON.stringify({ v: 1, items });
    if (text.length <= MAX_CHARS) return text;
  }
  return JSON.stringify({ v: 1, items: [] });
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
