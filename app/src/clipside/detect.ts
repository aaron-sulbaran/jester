// The people detector: MediaPipe PoseLandmarker in VIDEO mode, up to 4 people, a fresh
// instance per clip so its time stamps start over. Each person also gets a segmentation mask
// (one per detected pose, same order as the landmarks), turned into an outline of up to 60 points.

import type { Landmark } from "../../../engine/src/index.ts";
import { boxFromLandmarks, largestBlobInBox, type Box, type Detection, type Outline } from "../../../clip/src/index.ts";
import { binarizeMask, downsampleMask, extractOutline, MP_BUNDLE, MP_WASM, MODEL_URLS } from "../../../spikes/pose-match/webcam.mjs";
import type { FrameCanvas } from "./frames.ts";

const MAX_PEOPLE = 4;

/** "full" is what the game uses; "lite" and "heavy" are there to time in the clip lab. */
export type PoseModel = "lite" | "full" | "heavy";
const HEAVY_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task";
const MODEL_PATHS: Record<PoseModel, string> = { lite: MODEL_URLS.lite, full: MODEL_URLS.full, heavy: HEAVY_MODEL_URL };
const OUTLINE_POINTS = 60;
/** The outline is traced on a mask shrunk so its long side is about this many cells. */
const OUTLINE_GRID = 180;

interface MpMask { width: number; height: number; getAsFloat32Array(): Float32Array; close(): void }

const round4 = (v: number) => Math.round(v * 10000) / 10000;

/** The person's outline from their mask, kept to the blob around their joints. Null when the mask is empty there. */
function outlineFromMask(mask: MpMask, box: Box): Outline | null {
  const { width, height } = mask;
  const factor = Math.max(1, Math.round(Math.max(width, height) / OUTLINE_GRID));
  const small = downsampleMask(binarizeMask(mask.getAsFloat32Array(), width, height), factor);
  const blob = largestBlobInBox(small, box);
  if (!blob) return null;
  const points = extractOutline(blob, OUTLINE_POINTS);
  if (!points || points.length < 3) return null;
  // extractOutline normalizes by the shrunk grid; map cell centres back onto the full frame.
  const sx = (blob.width * factor) / width;
  const sy = (blob.height * factor) / height;
  return points.map(([x, y]) => [round4(Math.min(1, x! * sx)), round4(Math.min(1, y! * sy))] as [number, number]);
}

export interface PeopleDetector {
  /** People in this frame. `tMs` is the frame's media time; it becomes the detector's time stamp. */
  detect(canvas: FrameCanvas, tMs: number): Detection[];
  close(): void;
}

interface MpLandmark { x: number; y: number; visibility?: number }

let visionPromise: Promise<{ mp: any; vision: any }> | null = null;

function loadVision(): Promise<{ mp: any; vision: any }> {
  visionPromise ??= (async () => {
    const mp = await import(/* @vite-ignore */ MP_BUNDLE);
    const vision = await mp.FilesetResolver.forVisionTasks(MP_WASM);
    return { mp, vision };
  })();
  visionPromise.catch(() => { visionPromise = null; });
  return visionPromise;
}

export async function createPeopleDetector(model: PoseModel = "full"): Promise<{ data: PeopleDetector; error: null } | { data: null; error: string }> {
  let landmarker: any;
  try {
    const { mp, vision } = await loadVision();
    const make = (delegate: "GPU" | "CPU") => mp.PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_PATHS[model], delegate },
      runningMode: "VIDEO", numPoses: MAX_PEOPLE, outputSegmentationMasks: true,
    });
    try { landmarker = await make("GPU"); } catch { landmarker = await make("CPU"); }
  } catch {
    return { data: null, error: "The pose tracker did not load. Check the connection and try again." };
  }

  let lastStamp = -Infinity;
  return {
    error: null,
    data: {
      detect(canvas, tMs) {
        // Time stamps must increase; equal or earlier ones are raised to one past the last.
        const stamp = tMs > lastStamp ? tMs : lastStamp + 1;
        lastStamp = stamp;
        const result = landmarker.detectForVideo(canvas, stamp);
        const masks = (result.segmentationMasks ?? []) as MpMask[];
        const people: Detection[] = [];
        try {
          ((result.landmarks ?? []) as MpLandmark[][]).forEach((raw, i) => {
            if (raw.length < 33) return;
            const landmarks: Landmark[] = raw.map((l) => [l.x, l.y, l.visibility ?? 1] as const);
            const box = boxFromLandmarks(landmarks);
            if (!box) return;
            const mask = masks[i];
            people.push({ box, landmarks, outline: mask ? outlineFromMask(mask, box) : null });
          });
        } finally {
          for (const mask of masks) mask.close();
        }
        return people;
      },
      close() { landmarker.close(); },
    },
  };
}
