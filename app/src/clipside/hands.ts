// The hands pass: the pose model gives a hand only 4 points, and at 512 px a hand in a full-body shot is a
// few pixels wide, so a clip's finger movement never reached the player. This pass re-reads the clip at a
// larger size, crops a square around each of the subject's wrists and runs MediaPipe's Hand Landmarker on
// the crop (21 points per hand). The result goes on the guide as `hands`, one entry per timeline frame.
// It is best effort: any failure returns the guides as they were.

import type { Guide, GuideHands, HandPoints } from "../../../clip/src/index.ts";
import { cachedModelOptions, HAND_MODEL_URL, MP_BUNDLE, MP_WASM } from "../../../spikes/pose-match/webcam.mjs";
import { readFrames, type FrameCanvas } from "./frames.ts";

/** Frames are read this large on the long side, so a hand is big enough for the hand model to see fingers. */
const HAND_MAX_SIDE = 1280;
const CROP = 256;
const MIN_VISIBILITY = 0.4;
/** The hand model's wrist must land this close (in crop sides) to the pose wrist, or it found someone else's hand. */
const MAX_WRIST_OFFSET = 0.4;
const SIDES = [
  { key: "left" as const, elbow: 13, wrist: 15 },
  { key: "right" as const, elbow: 14, wrist: 16 },
];

/** Crop sizes to try, as multiples of the first guess. */
const GROWS = [1, 1.7];
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** The crop square, in frame pixels, to look for the hand in: centred a little past the wrist, along the forearm. */
export function handCrop(elbow: readonly [number, number], wrist: readonly [number, number], W: number, H: number, grow = 1): { x: number; y: number; side: number } {
  const ex = elbow[0] * W, ey = elbow[1] * H, wx = wrist[0] * W, wy = wrist[1] * H;
  const length = Math.hypot(wx - ex, wy - ey) || 1;
  const side = Math.min(Math.min(W, H) * 0.8, Math.max(96, length * 1.1) * grow);
  const cx = wx + ((wx - ex) / length) * side * 0.3, cy = wy + ((wy - ey) / length) * side * 0.3;
  return { x: cx - side / 2, y: cy - side / 2, side };
}

/** Maps a hand found in the crop back to normalized frame coordinates, or null when it is not the subject's hand. */
export function handFromCrop(points: readonly { x: number; y: number }[], crop: { x: number; y: number; side: number }, wrist: readonly [number, number], W: number, H: number): HandPoints | null {
  if (points.length < 21) return null;
  const mapped = points.slice(0, 21).map((p) => [round4((crop.x + p.x * crop.side) / W), round4((crop.y + p.y * crop.side) / H)] as [number, number]);
  const off = Math.hypot((mapped[0]![0] - wrist[0]) * W, (mapped[0]![1] - wrist[1]) * H) / crop.side;
  return off <= MAX_WRIST_OFFSET ? mapped : null;
}

async function createHandDetector() {
  const mp = await import(/* @vite-ignore */ MP_BUNDLE);
  const vision = await mp.FilesetResolver.forVisionTasks(MP_WASM);
  const make = async (delegate: "GPU" | "CPU") => mp.HandLandmarker.createFromOptions(vision, {
    baseOptions: { ...(await cachedModelOptions(HAND_MODEL_URL)), delegate },
    runningMode: "IMAGE", numHands: 1, minHandDetectionConfidence: 0.3, minHandPresenceConfidence: 0.3,
  });
  try { return await make("GPU"); } catch { return make("CPU"); }
}

/**
 * Adds `hands` to each person guide. `onProgress` runs from 0 to 1. Guides that are things, or have no
 * timeline, come back unchanged; so does everything when the hand model or the video cannot be used.
 */
export async function addHands(guides: Guide[], file: File, video: HTMLVideoElement, onProgress: (share: number) => void = () => {}): Promise<Guide[]> {
  const people = guides.filter((g) => g.subject.kind === "person" && g.timeline && g.timeline.frames.length > 0);
  if (people.length === 0) return guides;
  let detector: any;
  try { detector = await createHandDetector(); } catch { return guides; }

  const found = new Map<Guide, (GuideHands | null)[]>(people.map((g) => [g, g.timeline!.frames.map(() => null)]));
  const crop = document.createElement("canvas");
  crop.width = crop.height = CROP;
  const ctx = crop.getContext("2d", { willReadFrequently: true })!;
  const hz = people[0]!.source.sampleHz;
  const startMs = Math.min(...people.map((g) => g.range.startMs));
  const endMs = Math.max(...people.map((g) => g.range.endMs));

  try {
    const read = await readFrames(file, video, { sampleHz: hz, maxMs: endMs, maxSide: HAND_MAX_SIDE }, async ({ tMs, canvas, index, count }) => {
      onProgress((index + 1) / count);
      if (tMs < startMs - 1000 / hz) return;
      const frame = canvas as FrameCanvas;
      for (const g of people) {
        const i = Math.round((tMs - g.range.startMs) / (1000 / g.source.sampleHz));
        const landmarks = g.timeline!.frames[i]?.landmarks;
        if (!landmarks || i < 0) continue;
        const entry: GuideHands = { left: null, right: null };
        for (const side of SIDES) {
          const w = landmarks[side.wrist], e = landmarks[side.elbow];
          if (!w || !e || w[2] < MIN_VISIBILITY || e[2] < MIN_VISIBILITY) continue;
          // A tight look first; a hand it misses (fingers spread, close to the camera) gets a wider one.
          for (const grow of GROWS) {
            const box = handCrop([e[0], e[1]], [w[0], w[1]], frame.width, frame.height, grow);
            ctx.clearRect(0, 0, CROP, CROP);
            ctx.drawImage(frame, box.x, box.y, box.side, box.side, 0, 0, CROP, CROP);
            const result = detector.detect(crop);
            const points = result?.landmarks?.[0] as { x: number; y: number }[] | undefined;
            const hand = points ? handFromCrop(points, box, [w[0], w[1]], frame.width, frame.height) : null;
            if (hand) { entry[side.key] = hand; break; }
          }
        }
        found.get(g)![i] = entry.left || entry.right ? entry : null;
      }
    });
    if (read.error !== null) return guides;
  } catch {
    return guides;
  } finally {
    try { detector.close(); } catch { /* already closed */ }
  }
  return guides.map((g) => {
    const hands = found.get(g);
    return hands && hands.some((h) => h) ? { ...g, hands } : g;
  });
}
