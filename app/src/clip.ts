// The clip side, as simple as it can be for Version 1: a starter clip or a video file,
// turned into pose samples. Aaron's clip side replaces this when it lands.

import { fromClipSamples, type ClipSample, type PoseTimeline } from "../../engine/src/index.ts";
import { DEMO_SEQUENCE, makeSequenceTimeline } from "../../spikes/pose-match/synthetic.mjs";
import { MP_BUNDLE, MP_WASM, MODEL_URLS } from "../../spikes/pose-match/webcam.mjs";

export interface Clip {
  /** Samples with `t` in seconds, as the spike produces them. */
  samples: ClipSample[];
  width: number;
  height: number;
  durationMs: number;
  /** Object URL of the video, or null for the synthetic starter clip. */
  videoUrl: string | null;
  timeline: PoseTimeline;
}

const STARTER_ASPECT = 4 / 3;
const ANALYSIS_STEP_S = 1 / 15;
const MAX_CLIP_S = 60;

function finish(samples: ClipSample[], width: number, height: number, videoUrl: string | null): Clip {
  const last = samples.length ? samples[samples.length - 1].t : 0;
  return {
    samples, width, height, videoUrl,
    durationMs: last * 1000,
    timeline: fromClipSamples(samples, { width, height, timeUnit: "s" }),
  };
}

/** The synthetic stick figure dance from the spike. Works offline. */
export function starterClip(): Clip {
  const samples = makeSequenceTimeline(DEMO_SEQUENCE, { idleDegrees: 2, aspect: STARTER_ASPECT }) as ClipSample[];
  return finish(samples, Math.round(STARTER_ASPECT * 1000), 1000, null);
}

function waitFor(el: HTMLElement, event: string, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); el.removeEventListener(event, done); resolve(); };
    const timer = setTimeout(done, timeoutMs);
    el.addEventListener(event, done);
  });
}

let landmarker: any = null;
let lastTs = 0;

async function clipLandmarker() {
  if (landmarker) return landmarker;
  const mp = await import(/* @vite-ignore */ MP_BUNDLE);
  const vision = await mp.FilesetResolver.forVisionTasks(MP_WASM);
  const make = (delegate: "GPU" | "CPU") => mp.PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL_URLS.full, delegate },
    runningMode: "VIDEO", numPoses: 1, outputSegmentationMasks: false,
  });
  try { landmarker = await make("GPU"); } catch { landmarker = await make("CPU"); }
  return landmarker;
}

/** Seek through the video and track one person per step. */
export async function analyzeVideo(file: File, video: HTMLVideoElement, onProgress: (share: number) => void): Promise<Clip> {
  const url = URL.createObjectURL(file);
  video.src = url;
  await waitFor(video, "loadeddata", 10000);
  const lm = await clipLandmarker();
  const end = Math.min(video.duration || 0, MAX_CLIP_S);
  const samples: ClipSample[] = [];
  for (let t = 0; t < end; t += ANALYSIS_STEP_S) {
    video.currentTime = t;
    await waitFor(video, "seeked");
    const ts = Math.max(lastTs + 1, performance.now());
    lastTs = ts;
    const result = lm.detectForVideo(video, ts);
    const first = result.landmarks?.[0];
    samples.push({ t, landmarks: first ? first.map((l: any) => ({ x: l.x, y: l.y, z: l.z, visibility: l.visibility ?? 1 })) : null });
    onProgress(t / end);
  }
  onProgress(1);
  video.currentTime = 0;
  return finish(samples, video.videoWidth, video.videoHeight, url);
}
