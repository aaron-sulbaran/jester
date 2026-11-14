// Prepare a clip (read it, find the people, follow each one) and finish it into a guide for
// the person picked. The pure work lives in ../../../clip; this file feeds it from the browser.

import {
  buildGuide, checkClip, checkSubject, findCuts, frameSignature, linkTracks, pickConfirmFrame,
  rankCandidates, shotRanges, withConfirmBoxes,
} from "../../../clip/src/index.ts";
import type { Candidate, ClipSource, FrameDetections, Guide, Track } from "../../../clip/src/index.ts";
import { createPeopleDetector } from "./detect.ts";
import { sha256Hex } from "./fingerprint.ts";
import { readFrames, type FrameCanvas } from "./frames.ts";
import { loadPrepared, savePrepared } from "./store.ts";

export { loadPrepared, savePrepared } from "./store.ts";

const SAMPLE_HZ = 15;
const MAX_MS = 30000;
const MAX_SIDE = 720;
const SIGNATURE_WIDTH = 32;
const LONG_CLIP = "This clip is longer than 30 seconds, so only the first 30 are used.";

export interface Prepared {
  fingerprint: string; source: ClipSource; frames: FrameDetections[]; cuts: number[];
  tracks: Track[]; candidates: Candidate[]; confirmFrame: number; confirmTMs: number;
  warnings: string[]; decoder: "webcodecs" | "video-element"; fromSaved: boolean;
}

export interface PrepareOptions {
  /** Analyse again even when a saved analysis exists. The new result is still saved. */
  ignoreSaved?: boolean;
}

type Result<T> = { data: T; error: null } | { data: null; error: string };

/** A 32 pixel wide copy of the frame, as a colour signature for cut detection. */
function signatureOf(canvas: FrameCanvas, scratch: HTMLCanvasElement): number[] {
  const height = Math.max(1, Math.round(SIGNATURE_WIDTH * canvas.height / canvas.width));
  scratch.width = SIGNATURE_WIDTH;
  scratch.height = height;
  const ctx = scratch.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(canvas, 0, 0, SIGNATURE_WIDTH, height);
  return frameSignature(ctx.getImageData(0, 0, SIGNATURE_WIDTH, height).data, SIGNATURE_WIDTH, height);
}

let videoUrl: string | null = null;

/** Points `video` at the file, so the fallback decoder and later playback can use it. */
function attach(file: File, video: HTMLVideoElement) {
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  videoUrl = URL.createObjectURL(file);
  video.src = videoUrl;
}

/**
 * Reads the first 30 seconds at 15 frames a second, finds up to 4 people per frame, follows each
 * through its shot and ranks them. Returns the saved analysis when this exact file was seen before.
 * Progress runs 0 to 1 across reading and tracking together.
 */
export async function prepareClip(
  file: File,
  video: HTMLVideoElement,
  onProgress: (share: number) => void,
  options: PrepareOptions = {},
): Promise<Result<Prepared>> {
  attach(file, video);
  onProgress(0);
  const fingerprint = await sha256Hex(file);
  if (!options.ignoreSaved) {
    const saved = await loadPrepared(fingerprint);
    if (saved) {
      onProgress(1);
      return { data: saved, error: null };
    }
  }

  const detector = await createPeopleDetector();
  if (detector.error !== null) return { data: null, error: detector.error };
  const scratch = document.createElement("canvas");
  const frames: FrameDetections[] = [];
  let read;
  try {
    read = await readFrames(file, video, { sampleHz: SAMPLE_HZ, maxMs: MAX_MS, maxSide: MAX_SIDE }, async ({ tMs, canvas, index, count }) => {
      frames.push({ tMs, people: detector.data.detect(canvas, tMs), signature: signatureOf(canvas, scratch) });
      onProgress((index + 1) / count);
    });
  } finally {
    detector.data.close();
  }
  if (read.error !== null) return { data: null, error: read.error };

  const info = read.data;
  const source: ClipSource = {
    width: info.width,
    height: info.height,
    durationMs: Math.min(info.durationMs, MAX_MS),
    sampleHz: SAMPLE_HZ,
  };
  const cuts = findCuts(frames.map((f) => f.signature));
  const tracks = linkTracks(frames, cuts);
  const ranked = rankCandidates(tracks, { sampleHz: SAMPLE_HZ, frameCount: frames.length });
  const confirmFrame = pickConfirmFrame(ranked, tracks);
  const candidates = withConfirmBoxes(ranked, tracks, confirmFrame);
  const verdict = checkClip({ durationMs: source.durationMs, cuts, candidates });
  if (verdict.refuse !== null) return { data: null, error: verdict.refuse };

  const warnings = [...(info.durationMs > MAX_MS ? [LONG_CLIP] : []), ...verdict.warnings];
  const prepared: Prepared = {
    fingerprint, source, frames, cuts, tracks, candidates, confirmFrame,
    confirmTMs: frames[confirmFrame]?.tMs ?? 0,
    warnings, decoder: info.decoder, fromSaved: false,
  };
  await savePrepared(prepared);
  onProgress(1);
  return { data: prepared, error: null };
}

/** The guide for one picked person, or the sentence saying why that person will not work. */
export function finishClip(prepared: Prepared, trackId: number): Result<Guide> {
  const track = prepared.tracks.find((t) => t.id === trackId);
  const candidate = prepared.candidates.find((c) => c.trackId === trackId);
  if (!track || !candidate) return { data: null, error: "That person is not one of the people found in this clip." };
  const shot = shotRanges(prepared.frames.length, prepared.cuts)[track.shot];
  if (!shot) return { data: null, error: "That person is not one of the people found in this clip." };
  const verdict = checkSubject(track, shot);
  if (verdict.refuse !== null) return { data: null, error: verdict.refuse };
  return {
    data: buildGuide({
      fingerprint: prepared.fingerprint, source: prepared.source, frames: prepared.frames, track, shot,
      label: candidate.label, warnings: [...prepared.warnings, ...verdict.warnings],
    }),
    error: null,
  };
}

/** A guide for every candidate, best first. Blind mode gives each player one subject, so it needs them all. */
export function subjectGuides(prepared: Prepared): { guides: Guide[]; skipped: { number: number; reason: string }[] } {
  const guides: Guide[] = [];
  const skipped: { number: number; reason: string }[] = [];
  for (const candidate of prepared.candidates) {
    const result = finishClip(prepared, candidate.trackId);
    if (result.error !== null) skipped.push({ number: candidate.number, reason: result.error });
    else guides.push(result.data);
  }
  return { guides, skipped };
}
