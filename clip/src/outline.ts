import type { Box } from "./types.ts";

/** A binary mask: `data[y * width + x]` is 1 inside, 0 outside. */
export interface BinaryMask { width: number; height: number; data: Uint8Array }

/** How far past the joint box a person's mask may reach, as a share of the box size per side. */
const SIDE_MARGIN = 0.35;
const TOP_MARGIN = 0.2;
const BOTTOM_MARGIN = 0.1;

/**
 * Keeps only the largest 8-connected blob of the mask that lies inside `box` (normalized, from the
 * person's joints) widened to take in the head, hands and feet. Returns a new mask of the same size,
 * or null when nothing inside the box is set. Specks and other people outside the box are dropped.
 */
export function largestBlobInBox(mask: BinaryMask, box: Box): BinaryMask | null {
  const { width, height, data } = mask;
  const x0 = Math.max(0, Math.floor((box.cx - box.w / 2 - box.w * SIDE_MARGIN) * width));
  const x1 = Math.min(width - 1, Math.ceil((box.cx + box.w / 2 + box.w * SIDE_MARGIN) * width));
  const y0 = Math.max(0, Math.floor((box.cy - box.h / 2 - box.h * TOP_MARGIN) * height));
  const y1 = Math.min(height - 1, Math.ceil((box.cy + box.h / 2 + box.h * BOTTOM_MARGIN) * height));
  if (x0 > x1 || y0 > y1) return null;

  const label = new Int32Array(width * height);
  let best = 0;
  let bestSize = 0;
  let next = 0;
  const stack: number[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const start = y * width + x;
      if (!data[start] || label[start]) continue;
      next++;
      let size = 0;
      label[start] = next;
      stack.push(start);
      while (stack.length) {
        const cell = stack.pop()!;
        size++;
        const cx = cell % width;
        const cy = (cell - cx) / width;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
            const n = ny * width + nx;
            if (data[n] && !label[n]) { label[n] = next; stack.push(n); }
          }
        }
      }
      if (size > bestSize) { bestSize = size; best = next; }
    }
  }
  if (best === 0) return null;
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) if (label[i] === best) out[i] = 1;
  return { width, height, data: out };
}
