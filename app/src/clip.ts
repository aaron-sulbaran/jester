// The clip side entry points: the starter clip, or a video file analysed by ./clipside
// (people found, followed and ranked) and turned into pose samples and a guide.

import { fromClipSamples, type ClipSample, type PoseTimeline } from "../../engine/src/index.ts";
import { DEMO_SEQUENCE, makeSequenceTimeline } from "../../spikes/pose-match/synthetic.mjs";
import type { Guide } from "../../clip/src/index.ts";
import { finishClip, prepareClip, type Prepared } from "./clipside/analyze.ts";

export { subjectGuides } from "./clipside/analyze.ts";
export type { Prepared } from "./clipside/analyze.ts";

export interface Clip {
  /** Samples with `t` in seconds, as the spike produces them. */
  samples: ClipSample[];
  width: number;
  height: number;
  durationMs: number;
  /** Object URL of the video, or null for the synthetic starter clip. */
  videoUrl: string | null;
  timeline: PoseTimeline;
  /** The guide for the person followed; null for the starter clip. */
  guide: Guide | null;
}

const STARTER_ASPECT = 4 / 3;

function finish(samples: ClipSample[], width: number, height: number, videoUrl: string | null): Omit<Clip, "guide"> {
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
  return { ...finish(samples, Math.round(STARTER_ASPECT * 1000), 1000, null), guide: null };
}

/** Analyse a video file and follow its top ranked person, on media time from 0. Throws the refusal sentence. */
export async function analyzeVideo(file: File, video: HTMLVideoElement, onProgress: (share: number) => void): Promise<Clip> {
  const prepared = await prepareClip(file, video, onProgress);
  if (prepared.error !== null) throw new Error(prepared.error);
  const top = prepared.data.candidates[0];
  if (!top) throw new Error("No person found in this clip.");
  const guide = finishClip(prepared.data, top.trackId);
  if (guide.error !== null) throw new Error(guide.error);
  const track = prepared.data.tracks.find((t) => t.id === top.trackId);
  const byFrame = new Map(track?.points.map((p) => [p.frame, p.landmarks]) ?? []);
  const samples: ClipSample[] = prepared.data.frames.map((frame, index) => {
    const landmarks = byFrame.get(index);
    return { t: frame.tMs / 1000, landmarks: landmarks ? landmarks.map(([x, y, visibility]) => ({ x, y, z: 0, visibility })) : null };
  });
  const { width, height } = prepared.data.source;
  return { ...finish(samples, width, height, video.currentSrc || video.src), guide: guide.data };
}

/** Everything about the clip before a person is picked. */
export function prepareVideo(file: File, video: HTMLVideoElement, onProgress: (share: number) => void) {
  return prepareClip(file, video, onProgress);
}

/** The guide for the person picked, or the sentence saying why that person will not work. */
export function confirmSubject(prepared: Prepared, trackId: number) {
  return finishClip(prepared, trackId);
}
