// The clip side entry points: the starter clip, or a video file analysed by ./clipside
// (people found, followed and ranked) and turned into pose samples and a guide.

import { fromClipSamples, type BoxTrack, type ClipSample, type PoseTimeline } from "../../engine/src/index.ts";
import { DEMO_SEQUENCE, makeSequenceTimeline } from "../../spikes/pose-match/synthetic.mjs";
import { boxTrackAt, thingHint, thingObjectName, type Box, type Guide } from "../../clip/src/index.ts";
import { finishClip, prepareClip, type PrepareOptions, type Prepared } from "./clipside/analyze.ts";

export { subjectGuides } from "./clipside/analyze.ts";
export type { Prepared, PrepareOptions } from "./clipside/analyze.ts";

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

/**
 * Everything about the clip before a person is picked. Pass `{ things: true }` for blind mode, so
 * animals, balls and cars are found too; `subjectGuides` then returns them after the people.
 */
export function prepareVideo(file: File, video: HTMLVideoElement, onProgress: (share: number) => void, options: PrepareOptions = {}) {
  return prepareClip(file, video, onProgress, options);
}

/**
 * A thing's guide in the shape the app's object rounds take (`ObjectClip` in ./objectClips.ts on
 * main): `track` is the guide's box-track/1 as is, and clip time 0 is the guide's `range.startMs`.
 */
export function thingObjectClip(guide: Guide): {
  kind: "object"; name: string; hint: string; track: BoxTrack; durationMs: number; width: number; height: number;
  boxAt(ms: number): Box | null;
} {
  const frames = guide.boxTrack.frames;
  const durationMs = (frames[frames.length - 1]?.tMs ?? 0) + 1000 / guide.source.sampleHz;
  return {
    kind: "object",
    name: thingObjectName(guide.subject.label),
    hint: thingHint(guide),
    track: guide.boxTrack,
    durationMs,
    width: guide.source.width,
    height: guide.source.height,
    boxAt: (ms) => boxTrackAt(guide.boxTrack, ms),
  };
}

/** The guide for the person picked, or the sentence saying why that person will not work. */
export function confirmSubject(prepared: Prepared, trackId: number) {
  return finishClip(prepared, trackId);
}
