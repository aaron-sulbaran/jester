// Things in a clip: the MediaPipe object detector (EfficientDet-Lite0) on every third analysed
// frame, then the pure linking, ranking and guide building in ../../../clip. People are left to
// the pose tracker, so the "person" category is dropped here.

import {
  findCuts, frameSignature, linkThings, rankThings, thingGuides,
} from "../../../clip/src/index.ts";
import type {
  ClipSource, ThingCandidate, ThingDetection, ThingFrame, ThingTrack,
} from "../../../clip/src/index.ts";
import { MP_BUNDLE, MP_WASM } from "../../../spikes/pose-match/webcam.mjs";
import { sha256Hex } from "./fingerprint.ts";
import { readFrames, type Decoder, type FrameCanvas } from "./frames.ts";

const SAMPLE_HZ = 15;
const MAX_MS = 30000;
const MAX_SIDE = 720;
/** The object detector looks at every this many analysed frames. */
const DETECT_EVERY = 3;
const SCORE_THRESHOLD = 0.5;
const MAX_RESULTS = 10;
const SIGNATURE_WIDTH = 32;
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite";

const LONG_CLIP = "This clip is longer than 30 seconds, so only the first 30 are used.";
const DETECTOR_DID_NOT_LOAD = "The object finder did not load. Check the connection and try again.";
const DETECTOR_STOPPED = "The object finder stopped working. Reload the page and try again.";

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

export interface PreparedThings {
  fingerprint: string;
  source: ClipSource;
  frames: ThingFrame[];
  cuts: number[];
  tracks: ThingTrack[];
  candidates: ThingCandidate[];
  warnings: string[];
  decoder: Decoder;
  /** How many frames the object detector looked at. */
  detectedFrames: number;
}

export type PrepareThingsResult =
  | { data: PreparedThings; error: null }
  | { data: null; error: string; facts: { decoder: Decoder | null; frames: number } };

function signatureOf(canvas: FrameCanvas, scratch: HTMLCanvasElement): number[] {
  const height = Math.max(1, Math.round(SIGNATURE_WIDTH * canvas.height / canvas.width));
  scratch.width = SIGNATURE_WIDTH;
  scratch.height = height;
  const ctx = scratch.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(canvas, 0, 0, SIGNATURE_WIDTH, height);
  return frameSignature(ctx.getImageData(0, 0, SIGNATURE_WIDTH, height).data, SIGNATURE_WIDTH, height);
}

/**
 * Reads the first 30 seconds at 15 frames a second, finds things on every third frame, follows
 * each through its shot and ranks them. `video` must already have the file as its source; it is
 * only read from when the browser's decoder cannot open the file. Nothing is saved.
 */
export async function prepareThings(
  file: File,
  video: HTMLVideoElement,
  onProgress: (share: number) => void,
): Promise<PrepareThingsResult> {
  onProgress(0);
  const fingerprint = await sha256Hex(file);
  const frames: ThingFrame[] = [];
  const signatures: number[][] = [];
  const refuse = (error: string, decoder: Decoder | null = null): PrepareThingsResult =>
    ({ data: null, error, facts: { decoder, frames: frames.length } });

  const detector = await createThingDetector();
  if (detector.error !== null) return refuse(detector.error);
  const scratch = document.createElement("canvas");
  let read: Awaited<ReturnType<typeof readFrames>>;
  try {
    read = await readFrames(file, video, { sampleHz: SAMPLE_HZ, maxMs: MAX_MS, maxSide: MAX_SIDE }, async ({ tMs, canvas, index, count }) => {
      const things = index % DETECT_EVERY === 0 ? detector.data.detect(canvas, tMs) : null;
      frames.push({ tMs, things });
      signatures.push(signatureOf(canvas, scratch));
      onProgress((index + 1) / count);
    });
  } catch {
    return refuse(DETECTOR_STOPPED);
  } finally {
    detector.data.close();
  }
  if (read.error !== null) return refuse(read.error);

  const info = read.data;
  const source: ClipSource = {
    width: info.width,
    height: info.height,
    durationMs: Math.min(info.durationMs, MAX_MS),
    sampleHz: SAMPLE_HZ,
  };
  const aspect = info.width / info.height;
  const cuts = findCuts(signatures);
  const tracks = linkThings(frames, cuts, { aspect });
  const candidates = rankThings(tracks, { sampleHz: SAMPLE_HZ, frameCount: frames.length, aspect });
  onProgress(1);
  return {
    data: {
      fingerprint, source, frames, cuts, tracks, candidates,
      warnings: info.durationMs > MAX_MS ? [LONG_CLIP] : [],
      decoder: info.decoder,
      detectedFrames: frames.filter((f) => f.things !== null).length,
    },
    error: null,
  };
}

/** A guide for every thing found, best first, and why each one left out was left out. */
export function preparedThingGuides(prepared: PreparedThings): ReturnType<typeof thingGuides> {
  return thingGuides({
    fingerprint: prepared.fingerprint, source: prepared.source, frames: prepared.frames, cuts: prepared.cuts,
    tracks: prepared.tracks, candidates: prepared.candidates, warnings: prepared.warnings,
  });
}
