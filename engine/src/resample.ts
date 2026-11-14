// Turn uneven timestamps into the fixed grid the scorer works on. Pure and deterministic:
// the same input frames always give the same grid, bit for bit.

import { GRID_MS, MAX_INTERP_GAP_MS, QUANTIZE_DECIMALS } from "./constants.ts";
import type { BoxFrame, Landmark, Landmarks, PoseFrame } from "./types.ts";

const Q = 10 ** QUANTIZE_DECIMALS;
export function quantize(v: number): number {
  return Math.round(v * Q) / Q;
}

/** Number of grid frames needed to cover input frames ending at `lastMs`. */
export function gridLength(lastMs: number): number {
  if (!(lastMs >= 0)) return 0;
  return Math.floor(lastMs / GRID_MS + 1e-9) + 1;
}

function sortedByTime<T extends { tMs: number }>(frames: readonly T[]): T[] {
  // Array.prototype.sort is stable, so equal timestamps keep input order.
  return frames.filter((f) => Number.isFinite(f.tMs)).slice().sort((a, b) => a.tMs - b.tMs);
}

/**
 * For each grid time, find the input frames just before and just after it and blend them.
 * `blend(a, b, u)` gets u in 0..1. Returns null at a grid time when no usable input is near.
 */
function resampleGeneric<T extends { tMs: number }, V>(
  frames: readonly T[],
  n: number,
  value: (f: T) => V | null,
  blend: (a: V, b: V, u: number) => V,
): (V | null)[] {
  const input = sortedByTime(frames);
  const out: (V | null)[] = new Array(n).fill(null);
  let j = 0; // index of the first input frame with tMs > t
  for (let k = 0; k < n; k++) {
    const t = k * GRID_MS;
    while (j < input.length && input[j]!.tMs <= t) j++;
    const prev = j > 0 ? input[j - 1]! : undefined;
    const next = j < input.length ? input[j]! : undefined;
    const pv = prev ? value(prev) : null;
    const nv = next ? value(next) : null;
    if (prev && pv !== null && Math.abs(prev.tMs - t) < 1e-6) {
      out[k] = pv;
    } else if (prev && next && pv !== null && nv !== null && next.tMs - prev.tMs <= MAX_INTERP_GAP_MS) {
      out[k] = blend(pv, nv, (t - prev.tMs) / (next.tMs - prev.tMs));
    } else {
      // Fall back to the nearest detected frame if it is within half a grid step.
      const dp = prev && pv !== null ? t - prev.tMs : Infinity;
      const dn = next && nv !== null ? next.tMs - t : Infinity;
      if (dp <= dn && dp <= GRID_MS / 2) out[k] = pv;
      else if (dn < dp && dn <= GRID_MS / 2) out[k] = nv;
    }
  }
  return out;
}

function quantizeLandmarks(lms: readonly Landmark[]): Landmark[] {
  return lms.map((l) => [quantize(l[0]), quantize(l[1]), quantize(l[2])] as const);
}

function blendLandmarks(a: readonly Landmark[], b: readonly Landmark[], u: number): readonly Landmark[] {
  const n = Math.min(a.length, b.length);
  const out: Landmark[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = a[i]!, q = b[i]!;
    out[i] = [p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u, p[2] + (q[2] - p[2]) * u];
  }
  return out;
}

/** Resample pose frames to `n` grid frames, quantized. */
export function resamplePoses(frames: readonly PoseFrame[], n: number): Landmarks[] {
  const raw = resampleGeneric<PoseFrame, readonly Landmark[]>(
    frames,
    n,
    (f) => (f.landmarks && f.landmarks.length >= 33 ? f.landmarks : null),
    blendLandmarks,
  );
  return raw.map((lms) => (lms ? quantizeLandmarks(lms) : null));
}

export interface GridBox {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/** Resample box frames to `n` grid frames. `scrollX` (cumulative, per input frame) is added to cx. */
export function resampleBoxes(frames: readonly BoxFrame[], n: number, scrollX?: readonly number[]): (GridBox | null)[] {
  let cumulative = 0;
  const withWorld = frames.map((f, i) => {
    cumulative += scrollX?.[i] ?? 0;
    const box = f.box ? { ...f.box, cx: f.box.cx + cumulative } : null;
    return { tMs: f.tMs, box };
  });
  const raw = resampleGeneric<{ tMs: number; box: GridBox | null }, GridBox>(
    withWorld,
    n,
    (f) => f.box,
    (a, b, u) => ({
      cx: a.cx + (b.cx - a.cx) * u,
      cy: a.cy + (b.cy - a.cy) * u,
      w: a.w + (b.w - a.w) * u,
      h: a.h + (b.h - a.h) * u,
    }),
  );
  return raw.map((b) => (b ? { cx: quantize(b.cx), cy: quantize(b.cy), w: quantize(b.w), h: quantize(b.h) } : null));
}
