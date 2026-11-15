// Small rules behind the online recap, kept DOM free so they are unit tested (app/test/recapRules.test.ts).
//
//   castRowShare(ms, i)        how far row i of the closing cast card has come in at ms (0..1)
//   packTier(sizes, budget)    the first picture tier whose pictures fit a room's budget
//   keepFinished(seen, now)    the standings, keeping players who finished but dropped while pictures arrived
//   sameDancer(a, b)           how often two roles' boxes sit on the same person (a clip tracking slip)

/** The cast card's rows come in one after another; the first is there from the card's first frame. */
export const CAST_ROW_GAP_MS = 450;
export const CAST_ROW_FADE_MS = 350;

export function castRowShare(ms: number, i: number): number {
  if (i === 0) return 1;
  return Math.min(1, Math.max(0, (ms - i * CAST_ROW_GAP_MS) / CAST_ROW_FADE_MS));
}

/**
 * The first tier whose packed size fits `budget` characters. `sizeOf(i)` packs tier i and returns its length, or
 * Infinity once it is known to be too big (the packer stops encoding early), so later tiers are tried only when
 * needed. Returns the tier index, or -1 when none fits.
 */
export function packTier(tierCount: number, budget: number, sizeOf: (i: number) => number): number {
  for (let i = 0; i < tierCount; i++) if (sizeOf(i) <= budget) return i;
  return -1;
}

/** A room's standings row, as runOnline reads it. */
export interface StandingRow { id: string; timeline: unknown; media?: Record<string, string>; extra: unknown }

/**
 * The standings to build the recap from. A player can finish, send their result, then go quiet long enough for the
 * room to drop them (a slow phone packing its pictures, a hidden tab), and the room forgets a dropped player's
 * result. `seen` is a copy taken the moment everyone had finished: anyone in it but missing now is kept, with the
 * pictures that had arrived for them by then or since.
 */
export function keepFinished<R extends StandingRow>(seen: readonly R[], now: readonly R[]): R[] {
  const here = new Set(now.map((r) => r.id));
  const kept = seen.filter((r) => !here.has(r.id) && r.timeline);
  return [...now, ...kept];
}

export interface PlainBox { cx: number; cy: number; w: number; h: number }

/** Overlap of two boxes over their union, 0..1. */
export function overlap(a: PlainBox, b: PlainBox): number {
  const ix = Math.max(0, Math.min(a.cx + a.w / 2, b.cx + b.w / 2) - Math.max(a.cx - a.w / 2, b.cx - b.w / 2));
  const iy = Math.max(0, Math.min(a.cy + a.h / 2, b.cy + b.h / 2) - Math.max(a.cy - a.h / 2, b.cy - b.h / 2));
  const inter = ix * iy, union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? Math.min(1, inter / union) : 0;
}

/**
 * The share of samples where two roles' boxes sit on the same person (overlap over `threshold`), among samples
 * where both have a box. Two roles that follow one dancer leave the other dancer uncovered in the recap and stack
 * both players on the first, so this is logged with the recap's inputs.
 */
export function sameDancer(a: readonly (PlainBox | null)[], b: readonly (PlainBox | null)[], threshold = 0.6): number {
  let both = 0, same = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (!x || !y) continue;
    both++;
    if (overlap(x, y) > threshold) same++;
  }
  return both ? same / both : 0;
}
