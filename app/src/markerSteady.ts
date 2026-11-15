// Keeps a role's marker on its own person when two people touch.
//
// When fighters punch or dancers cross, the tracker can hand the role's box, outline or skeleton to the
// other person for a few frames and then give it back. Drawn as it is, the marker (Normal mode's outline
// and name tag, Blind mode's stick figure) jumps to the other person and back. This file finds those
// jumps (a move further than a person goes in 1/15 s that comes back soon) and glides the marker across
// them instead, from where it was to where it comes back. It is drawing only: scoring keeps the guide as it is.
//
// Pure (no DOM), so it is tested in app/test/markerSteady.test.ts.

export interface MarkBox { cx: number; cy: number; w: number; h: number }
export type MarkPoint = [number, number];
export type MarkLandmark = readonly [number, number, number];

export interface MarkTrack {
  /** Normalized boxes (x by width, y by height), one per sample, null where the subject is missing. */
  boxes: (MarkBox | null)[];
  /** Normalized outlines, one per sample, null where there is none. */
  outlines: (MarkPoint[] | null)[];
  /** Skeleton points per sample, if the subject is a person. */
  landmarks?: (readonly MarkLandmark[] | null)[];
}

/** The furthest a person's middle (their torso, or their box with no skeleton) moves in 1/15 s, in their own heights (a fast lunge is about 0.2). */
export const MAX_STEP = 0.3;
/** The most a box's height changes in 1/15 s (as a ratio) before it counts as a different person. */
export const MAX_GROW = 1.6;
/** How long a jump may last and still count as one to glide over (samples at 15 a second, about half a second). */
export const MAX_HOLD_15HZ = 8;

/**
 * True when going from `a` to `b` over `steps` samples at `hz` is further than a person moves (`aspect` is width /
 * height of the frame). `ma` and `mb` are the middles to compare (default the box centres): a torso is steadier
 * than a box, which a punching arm stretches.
 */
export function isJump(a: MarkBox, b: MarkBox, steps: number, hz: number, aspect: number, ma: MarkPoint = [a.cx, a.cy], mb: MarkPoint = [b.cx, b.cy]): boolean {
  const t = Math.max(1, steps) * (15 / hz); // in 1/15 s
  const h = Math.max(a.h, b.h, 1e-6);
  const d = Math.hypot((mb[0] - ma[0]) * aspect, mb[1] - ma[1]) / h;
  const grow = Math.max(a.h, b.h) / Math.max(Math.min(a.h, b.h), 1e-6);
  return d > MAX_STEP * t || grow > Math.pow(MAX_GROW, Math.min(t, 3));
}

/** The middle of the shoulders and hips when all four are seen, else null. */
export function torsoMiddle(l: readonly MarkLandmark[] | null | undefined): MarkPoint | null {
  if (!l || l.length < 25) return null;
  const pts = [l[11]!, l[12]!, l[23]!, l[24]!];
  if (pts.some((p) => p[2] < 0.3)) return null;
  return [(pts[0]![0] + pts[1]![0] + pts[2]![0] + pts[3]![0]) / 4, (pts[0]![1] + pts[1]![1] + pts[2]![1] + pts[3]![1]) / 4];
}

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const lerpBox = (a: MarkBox, b: MarkBox, u: number): MarkBox => ({ cx: lerp(a.cx, b.cx, u), cy: lerp(a.cy, b.cy, u), w: lerp(a.w, b.w, u), h: lerp(a.h, b.h, u) });

/** `outline` (drawn around box `from`) moved and scaled to sit around box `to`. */
export function moveOutline(outline: MarkPoint[], from: MarkBox, to: MarkBox): MarkPoint[] {
  const s = to.h / Math.max(from.h, 1e-6);
  return outline.map(([x, y]) => [to.cx + (x - from.cx) * s, to.cy + (y - from.cy) * s] as MarkPoint);
}

/** True when `outline` plainly belongs to someone else, to two people at once, or to part of a person: its middle is off the box, or it is far wider, taller or shorter. */
export function outlineOffBox(outline: MarkPoint[], box: MarkBox, aspect: number): boolean {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of outline) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const h = Math.max(box.h, 1e-6);
  const off = Math.hypot(((x0 + x1) / 2 - box.cx) * aspect, (y0 + y1) / 2 - box.cy) / h;
  const wider = ((x1 - x0) - box.w) * aspect / h, taller = ((y1 - y0) - box.h) / h;
  return off > 0.5 || wider > 0.6 || taller > 0.5 || (y1 - y0) < box.h * 0.6;
}

/**
 * The track with every short jump glided over: boxes and skeletons blend from the last steady sample to the
 * one where the subject comes back; outlines are the last steady outline carried along. A jump that does not
 * come back within about half a second is a real move and is kept. Outlines that do not fit their box are
 * replaced by the last good one carried along (or dropped, so the box is drawn instead). `held[i]` is true
 * where a sample was changed.
 */
export function steadyMarks(track: MarkTrack, hz: number, aspect: number): MarkTrack & { held: boolean[] } {
  const n = track.boxes.length;
  const boxes = track.boxes.slice();
  const outlines = track.outlines.slice();
  const landmarks = track.landmarks?.slice();
  const held = new Array<boolean>(n).fill(false);
  const maxHold = Math.max(1, Math.round(MAX_HOLD_15HZ * (hz / 15)));
  let last = -1; // the last steady sample with a box
  let goodOutline = -1; // the last steady sample whose outline fits its box
  const good: number[] = []; // every such sample, in order
  // Torsos are compared where both samples have one, boxes otherwise.
  // `steps` caps how far apart in time the two may be judged: coming back means back within two steps' reach of
  // where the subject was, not anywhere a person could have walked meanwhile.
  const mids = track.boxes.map((_, i) => torsoMiddle(track.landmarks?.[i]));
  const jump = (a: number, b: number, steps = b - a) => {
    const ma = mids[a], mb = mids[b];
    return ma && mb ? isJump(boxes[a]!, track.boxes[b]!, steps, hz, aspect, ma, mb) : isJump(boxes[a]!, track.boxes[b]!, steps, hz, aspect);
  };
  const carried = (to: MarkBox, at: number): MarkPoint[] | null =>
    goodOutline >= 0 && at - goodOutline <= maxHold * 2 ? moveOutline(outlines[goodOutline]!, boxes[goodOutline]!, to) : null;

  for (let i = 0; i < n; i++) {
    const b = boxes[i];
    if (!b) continue;
    if (last >= 0 && jump(last, i)) {
      let back = -1;
      for (let k = i + 1; k < n && k - last <= maxHold; k++) {
        const bk = boxes[k];
        if (bk && !jump(last, k, Math.min(k - last, 2))) { back = k; break; }
      }
      if (back >= 0) {
        const from = boxes[last]!, to = boxes[back]!;
        const l0 = landmarks?.[last] ?? null, l1 = landmarks?.[back] ?? null;
        for (let m = i; m < back; m++) {
          if (!boxes[m]) continue;
          const u = (m - last) / (back - last);
          boxes[m] = lerpBox(from, to, u);
          outlines[m] = carried(boxes[m]!, m);
          if (landmarks) landmarks[m] = l0 && l1 ? l0.map(([x, y, v], j) => [lerp(x, l1[j]![0], u), lerp(y, l1[j]![1], u), Math.min(v, l1[j]![2])] as const) : l0;
          held[m] = true;
        }
        i = back - 1;
        continue;
      }
    }
    const o = outlines[i];
    if (o && o.length >= 3 && !outlineOffBox(o, b, aspect)) { goodOutline = i; good.push(i); }
    else if (o) { outlines[i] = carried(b, i); held[i] = true; }
    last = i;
  }
  // Samples with a box but no outline (the tracker often gives no mask) borrow the nearest good outline, moved
  // to their box, so the marker does not flick between outline and box.
  let g = 0;
  for (let i = 0; i < n; i++) {
    if (!boxes[i] || outlines[i]) continue;
    while (g + 1 < good.length && Math.abs(good[g + 1]! - i) <= Math.abs(good[g]! - i)) g++;
    const k = good[g];
    if (k !== undefined && Math.abs(k - i) <= maxHold * 2) outlines[i] = moveOutline(track.outlines[k]!, boxes[k]!, boxes[i]!);
  }
  return { boxes, outlines, ...(landmarks ? { landmarks } : {}), held };
}

/** The largest move of a box's middle between two samples in a row, in frame heights (for measuring). */
export function largestStep(boxes: (MarkBox | null)[], aspect: number): number {
  let most = 0;
  for (let i = 1; i < boxes.length; i++) {
    const a = boxes[i - 1], b = boxes[i];
    if (a && b) most = Math.max(most, Math.hypot((b.cx - a.cx) * aspect, b.cy - a.cy));
  }
  return most;
}
