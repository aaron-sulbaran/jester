// The people detector: MediaPipe PoseLandmarker in VIDEO mode, up to 4 people, a fresh
// instance per clip so its time stamps start over.

import type { Landmark } from "../../../engine/src/index.ts";
import { boxFromLandmarks, type Detection } from "../../../clip/src/index.ts";
import { MP_BUNDLE, MP_WASM, MODEL_URLS } from "../../../spikes/pose-match/webcam.mjs";
import type { FrameCanvas } from "./frames.ts";

const MAX_PEOPLE = 4;

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

export async function createPeopleDetector(): Promise<{ data: PeopleDetector; error: null } | { data: null; error: string }> {
  let landmarker: any;
  try {
    const { mp, vision } = await loadVision();
    const make = (delegate: "GPU" | "CPU") => mp.PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URLS.full, delegate },
      runningMode: "VIDEO", numPoses: MAX_PEOPLE, outputSegmentationMasks: false,
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
        const people: Detection[] = [];
        for (const raw of (result.landmarks ?? []) as MpLandmark[][]) {
          if (raw.length < 33) continue;
          const landmarks: Landmark[] = raw.map((l) => [l.x, l.y, l.visibility ?? 1] as const);
          const box = boxFromLandmarks(landmarks);
          if (box) people.push({ box, landmarks });
        }
        return people;
      },
      close() { landmarker.close(); },
    },
  };
}
