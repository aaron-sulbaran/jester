const BINS = 8;
const CHANNELS = 3;
const HISTORY_PAIRS = 8;

/** A colour histogram of the frame: 8 bins each for red, green and blue, each channel summing to 1. */
export function frameSignature(rgba: Uint8ClampedArray, width: number, height: number): number[] {
  const signature = new Array<number>(BINS * CHANNELS).fill(0);
  const pixels = width * height;
  for (let i = 0; i < pixels; i++) {
    for (let c = 0; c < CHANNELS; c++) {
      const bin = Math.min(BINS - 1, Math.floor(rgba[i * 4 + c]! / (256 / BINS)));
      signature[c * BINS + bin]! += 1;
    }
  }
  return pixels > 0 ? signature.map((count) => count / pixels) : signature;
}

/** How different two signatures are, 0 (same) to 1 (nothing in common): mean total variation over channels. */
export function signatureDistance(a: readonly number[], b: readonly number[]): number {
  let total = 0;
  for (let i = 0; i < BINS * CHANNELS; i++) total += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return total / (2 * CHANNELS);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Indexes of the first frame of each new shot. A frame is a cut when it differs from the previous
 * frame by at least `threshold` and by at least `ratio` times the median of up to 8 preceding
 * differences (that ratio test applies only when that median is above 0). The very first pair has
 * no history to compare against, so it is never a cut.
 */
export function findCuts(
  signatures: readonly (readonly number[])[],
  options: { threshold?: number; ratio?: number } = {},
): number[] {
  const threshold = options.threshold ?? 0.35;
  const ratio = options.ratio ?? 3;
  const distances = signatures.slice(1).map((s, i) => signatureDistance(signatures[i]!, s));
  const cuts: number[] = [];
  for (let i = 1; i < distances.length; i++) {
    const distance = distances[i]!;
    if (distance < threshold) continue;
    const typical = median(distances.slice(Math.max(0, i - HISTORY_PAIRS), i));
    if (typical > 0 && distance < ratio * typical) continue;
    cuts.push(i + 1);
  }
  return cuts;
}

/** The frame range of each shot, end exclusive. */
export function shotRanges(frameCount: number, cuts: readonly number[]): { start: number; end: number }[] {
  const starts = [0, ...cuts];
  return starts.map((start, i) => ({ start, end: starts[i + 1] ?? frameCount }));
}
