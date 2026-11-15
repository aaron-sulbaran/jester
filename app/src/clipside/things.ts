// The things detector: MediaPipe ObjectDetector (EfficientDet-Lite0) in VIDEO mode, a fresh
// instance per clip so its time stamps start over. People are left to the pose tracker, so the
// "person" category is dropped. prepareClip in ./analyze.ts runs it on every third frame.

import type { ThingDetection } from "../../../clip/src/index.ts";
import { MP_BUNDLE, MP_WASM } from "../../../spikes/pose-match/webcam.mjs";
import type { FrameCanvas } from "./frames.ts";

const SCORE_THRESHOLD = 0.5;
const MAX_RESULTS = 10;
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite";

const DETECTOR_DID_NOT_LOAD = "The object finder did not load. Check the connection and try again.";

export interface ThingDetector {
  /** Things in this frame, people left out. `tMs` must increase from call to call. */
  detect(canvas: FrameCanvas, tMs: number): ThingDetection[];
  close(): void;
}

interface MpDetection {
  boundingBox?: { originX: number; originY: number; width: number; height: number };
  categories?: { categoryName?: string; displayName?: string; score?: number }[];
}

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

/** A fresh detector in VIDEO mode, so its time stamps start over for each clip. */
export async function createThingDetector(): Promise<{ data: ThingDetector; error: null } | { data: null; error: string }> {
  let detector: any;
  try {
    const { mp, vision } = await loadVision();
    const make = (delegate: "GPU" | "CPU") => mp.ObjectDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: "VIDEO",
      scoreThreshold: SCORE_THRESHOLD,
      maxResults: MAX_RESULTS,
      categoryDenylist: ["person"],
    });
    try { detector = await make("GPU"); } catch { detector = await make("CPU"); }
  } catch {
    return { data: null, error: DETECTOR_DID_NOT_LOAD };
  }

  let lastStamp = -Infinity;
  return {
    error: null,
    data: {
      detect(canvas, tMs) {
        const stamp = tMs > lastStamp ? tMs : lastStamp + 1;
        lastStamp = stamp;
        const result = detector.detectForVideo(canvas, stamp);
        const things: ThingDetection[] = [];
        for (const raw of (result.detections ?? []) as MpDetection[]) {
          const top = raw.categories?.[0];
          const bb = raw.boundingBox;
          const category = top?.categoryName || top?.displayName || "";
          if (!top || !bb || !category || category === "person") continue;
          const score = top.score ?? 0;
          if (score < SCORE_THRESHOLD) continue;
          things.push({
            category,
            score,
            box: {
              cx: (bb.originX + bb.width / 2) / canvas.width,
              cy: (bb.originY + bb.height / 2) / canvas.height,
              w: bb.width / canvas.width,
              h: bb.height / canvas.height,
            },
          });
        }
        return things;
      },
      close() { detector.close(); },
    },
  };
}
