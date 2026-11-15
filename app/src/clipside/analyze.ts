// Prepare a clip (read it, find the people, follow each one) and finish it into a guide for
// the person picked. The pure work lives in ../../../clip; this file feeds it from the browser.

import {
  buildGuide, checkClip, checkSubject, findCuts, frameSignature, linkThings, pickConfirmFrame,
  rankCandidates, rankThings, shotRanges, thingGuides, trackPeople, withConfirmBoxes, withoutPeople,
} from "../../../clip/src/index.ts";
import type {
  Candidate, ClipSource, FrameDetections, Guide, ThingCandidate, ThingFrame, ThingTrack, Track,
} from "../../../clip/src/index.ts";
import { createPeopleDetector, type PersonSearch, type PoseModel } from "./detect.ts";
import { nameByPosition } from "../../../clip/src/index.ts";
import { createThingDetector, type ThingDetector } from "./things.ts";
import { sha256Hex } from "./fingerprint.ts";
import { readFrames, type FrameCanvas, type VideoInfo } from "./frames.ts";
import { loadPrepared, savePrepared } from "./store.ts";

export { loadPrepared, savePrepared } from "./store.ts";

const SAMPLE_HZ = 15;
const MAX_MS = 30000;
// Frames are read at most this many pixels on the long side. The pose model looks at a 256 px crop anyway, so 512 is
// plenty and decoding, masks and outlines get about half the work (was 720).
const MAX_SIDE = 512;
const SIGNATURE_WIDTH = 32;
const LONG_CLIP = "This clip is longer than 30 seconds, so only the first 30 are used.";
/** The object detector looks at every this many analysed frames. */
const THING_EVERY = 6;
/**
 * A thing track survives this many analysed frames with no sighting: four missed looks in a row
 * (two seconds at every 6th frame), as before the detector went from every 3rd to every 6th frame.
 */
const THING_MAX_GAP = 5 * THING_EVERY;

/** Things (animals, balls, cars) found by the object detector. People are left to the pose tracker. */
export interface PreparedThings { frames: ThingFrame[]; tracks: ThingTrack[]; candidates: ThingCandidate[] }

export interface Prepared {
  fingerprint: string; source: ClipSource; frames: FrameDetections[]; cuts: number[];
  tracks: Track[]; candidates: Candidate[]; confirmFrame: number; confirmTMs: number;
  warnings: string[]; decoder: "webcodecs" | "video-element"; fromSaved: boolean;
  /** Present only when the clip was prepared with `things: true`. */
  things?: PreparedThings | null;
}

export interface PrepareOptions {
  /** Analyse again even when a saved analysis exists. The new result is still saved. */
  ignoreSaved?: boolean;
  /** Pose model to try, for timing in the lab. Anything but the default "full" ignores and does not save the analysis. */
  model?: PoseModel;
  /** How to look for people, to compare in the lab. Anything but the default "every-frame" ignores and does not save the analysis. */
  search?: PersonSearch;
  /**
   * Also find things (animals, balls, cars) with the object detector, for blind mode roles. Off by
   * default: solo play copies people only, and the second detector adds time. With it off, people
   * results are exactly as before.
   */
  things?: boolean;
}

type Result<T> = { data: T; error: null } | { data: null; error: string };

/** What was learned before a refusal: which decoder read the clip and how many frames were analysed. */
export interface PrepareFacts { decoder: Prepared["decoder"] | null; frames: number }

export type PrepareResult = { data: Prepared; error: null } | { data: null; error: string; facts: PrepareFacts };

const TRACKER_STOPPED = "The pose tracker stopped working. Reload the page and try again.";
const NO_PERSON = "No person found in this clip.";

/** A 32 pixel wide copy of the frame, as a colour signature for cut detection. */
function signatureOf(canvas: FrameCanvas, scratch: HTMLCanvasElement): number[] {
  const height = Math.max(1, Math.round(SIGNATURE_WIDTH * canvas.height / canvas.width));
  scratch.width = SIGNATURE_WIDTH;
  scratch.height = height;
  const ctx = scratch.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(canvas, 0, 0, SIGNATURE_WIDTH, height);
  return frameSignature(ctx.getImageData(0, 0, SIGNATURE_WIDTH, height).data, SIGNATURE_WIDTH, height);
}

/**
 * Follows each person through the frames, joins people the tracker split into pieces, ranks them
 * and picks the frame to choose from. Pure and quick, so saved analyses run it again too.
 */
function findPeople(frames: readonly FrameDetections[], cuts: readonly number[], source: ClipSource) {
  const { tracks } = trackPeople(frames, cuts, { sampleHz: SAMPLE_HZ, aspect: source.width / source.height });
  const ranked = rankCandidates(tracks, { sampleHz: SAMPLE_HZ, frameCount: frames.length });
  const confirmFrame = pickConfirmFrame(ranked, tracks);
  const candidates = withConfirmBoxes(ranked, tracks, confirmFrame);
  const verdict = checkClip({ durationMs: source.durationMs, cuts, candidates });
  return { tracks, candidates, confirmFrame, confirmTMs: frames[confirmFrame]?.tMs ?? 0, verdict };
}

/** The clip's refusal, except that with no people a moving thing still makes a blind mode role. */
function refusalWith(refusal: string | null, things: PreparedThings | null, source: ClipSource, cuts: readonly number[]): string | null {
  if (refusal !== NO_PERSON || !things || !things.candidates.some((c) => c.moves)) return refusal;
  // No people, but a moving thing is a role for blind mode: check the other clip rules with the things standing in.
  const standIns: Candidate[] = things.candidates.map((c) => ({ trackId: c.trackId, number: c.number, label: c.label, score: c.score, boxAtConfirm: null }));
  return checkClip({ durationMs: source.durationMs, cuts, candidates: standIns }).refuse;
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
): Promise<PrepareResult> {
  attach(file, video);
  onProgress(0);
  const fingerprint = await sha256Hex(file);
  const model = options.model ?? "full";
  const search = options.search ?? "every-frame";
  const usual = model === "full" && search === "every-frame";
  if (!options.ignoreSaved && usual) {
    const saved = await loadPrepared(fingerprint);
    // A saved analysis from a run without things does not have them; analyse again to find them.
    if (saved && (!options.things || saved.things)) {
      // The saved frames are kept as read; following the people again picks up the current rules.
      const { verdict, ...people } = findPeople(saved.frames, saved.cuts, saved.source);
      const refusal = refusalWith(verdict.refuse, saved.things ?? null, saved.source, saved.cuts);
      onProgress(1);
      if (refusal !== null) return { data: null, error: refusal, facts: { decoder: saved.decoder, frames: saved.frames.length } };
      const warnings = [...saved.warnings.filter((w) => w === LONG_CLIP), ...verdict.warnings];
      return { data: { ...saved, ...people, warnings }, error: null };
    }
  }

  const frames: FrameDetections[] = [];
  const refuse = (error: string, decoder: PrepareFacts["decoder"] = null): PrepareResult =>
    ({ data: null, error, facts: { decoder, frames: frames.length } });

  // Both detectors load at the same time (each is a model download plus a GPU setup).
  const [detector, made] = await Promise.all([createPeopleDetector(model, search), options.things ? createThingDetector() : Promise.resolve(null)]);
  if (detector.error !== null) { made?.data?.close(); return refuse(detector.error); }
  let thingDetector: ThingDetector | null = null;
  if (made) {
    if (made.error !== null) {
      detector.data.close();
      return refuse(made.error);
    }
    thingDetector = made.data;
  }
  const thingFrames: ThingFrame[] = [];
  const scratch = document.createElement("canvas");
  const t0 = performance.now();
  let peopleMs = 0, thingMs = 0;
  let read: Awaited<ReturnType<typeof readFrames>>;
  try {
    read = await readFrames(file, video, { sampleHz: SAMPLE_HZ, maxMs: MAX_MS, maxSide: MAX_SIDE }, async ({ tMs, canvas, index, count }) => {
      const a = performance.now();
      frames.push({ tMs, people: detector.data.detect(canvas, tMs), signature: signatureOf(canvas, scratch) });
      const b = performance.now();
      if (thingDetector) thingFrames.push({ tMs, things: index % THING_EVERY === 0 ? thingDetector.detect(canvas, tMs) : null });
      peopleMs += b - a; thingMs += performance.now() - b;
      onProgress((index + 1) / count);
    });
  } catch {
    // Decoding failures come back as `read.error`; anything thrown came from the tracker.
    return refuse(TRACKER_STOPPED);
  } finally {
    detector.data.close();
    thingDetector?.close();
  }
  if (read.error !== null) return refuse(read.error);
  // Where the time went, for tuning: shown in the console after each fresh analysis.
  console.info(`[clip] analysed ${frames.length} frames in ${((performance.now() - t0) / 1000).toFixed(1)} s (people ${(peopleMs / 1000).toFixed(1)} s, things ${(thingMs / 1000).toFixed(1)} s, rest is decoding)`);

  const info: VideoInfo = read.data;
  const source: ClipSource = {
    width: info.width,
    height: info.height,
    durationMs: Math.min(info.durationMs, MAX_MS),
    sampleHz: SAMPLE_HZ,
  };
  const cuts = findCuts(frames.map((f) => f.signature));
  const { verdict, ...people } = findPeople(frames, cuts, source);
  const things = thingDetector ? findThings(thingFrames, frames, cuts, source) : null;
  const refusal = refusalWith(verdict.refuse, things, source, cuts);
  if (refusal !== null) return refuse(refusal, info.decoder);

  const warnings = [...(info.durationMs > MAX_MS ? [LONG_CLIP] : []), ...verdict.warnings];
  const prepared: Prepared = {
    fingerprint, source, frames, cuts, ...people,
    warnings, decoder: info.decoder, fromSaved: false,
    ...(things ? { things } : {}),
  };
  if (usual) await savePrepared(prepared);
  onProgress(1);
  return { data: prepared, error: null };
}

/** Follows and ranks the things, leaving out boxes that are mostly a person the pose tracker has. */
function findThings(thingFrames: ThingFrame[], frames: readonly FrameDetections[], cuts: number[], source: ClipSource): PreparedThings {
  const aspect = source.width / source.height;
  const kept = withoutPeople(thingFrames, frames.map((f) => f.people.map((p) => p.box)));
  const tracks = linkThings(kept, cuts, { aspect, maxGap: THING_MAX_GAP });
  const candidates = rankThings(tracks, { sampleHz: source.sampleHz, frameCount: frames.length, aspect });
  return { frames: kept, tracks, candidates };
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

const OTHER_SHOT = "This person is in a different shot of the clip.";

/**
 * A guide for every person in the clip, best first, then every thing when the clip was prepared
 * with `things: true`. Blind mode gives each player one subject and plays them all over the same
 * stretch of the clip, so every guide comes from the top person's shot (the top thing's when there
 * are no people) and shares its `range`; with no cuts that is everyone. Subjects in other shots,
 * and subjects a guide cannot be made for, go to `skipped` with the sentence why. A thing guide has
 * `subject.kind` "thing", `timeline` null and `channel` "trajectory". People are named by where they
 * stand among the people offered ("the dancer on the left", see `nameByPosition`); things keep their labels.
 */
export function subjectGuides(prepared: Prepared): { guides: Guide[]; skipped: { number: number; label?: string; reason: string }[] } {
  const guides: Guide[] = [];
  const skipped: { number: number; label?: string; reason: string }[] = [];
  const shotOf = (trackId: number) => prepared.tracks.find((t) => t.id === trackId)?.shot;
  const mainShot = prepared.candidates[0] ? shotOf(prepared.candidates[0].trackId) : undefined;
  for (const candidate of prepared.candidates) {
    if (shotOf(candidate.trackId) !== mainShot) {
      skipped.push({ number: candidate.number, reason: OTHER_SHOT });
      continue;
    }
    const result = finishClip(prepared, candidate.trackId);
    if (result.error !== null) skipped.push({ number: candidate.number, reason: result.error });
    else guides.push(result.data);
  }
  // Named among the people offered only: a short piece of someone that was skipped must not push a real
  // person into "the middle". Saved analyses run this again, so they get the names too.
  const people = nameByPosition(guides);
  const things = prepared.things;
  if (!things) return { guides: people, skipped };
  const topThing = things.candidates[0];
  const shot = mainShot ?? (topThing ? things.tracks.find((t) => t.id === topThing.trackId)?.shot : undefined);
  const found = thingGuides({
    fingerprint: prepared.fingerprint, source: prepared.source, frames: prepared.frames, cuts: prepared.cuts,
    tracks: things.tracks, candidates: things.candidates, warnings: prepared.warnings, shot: shot ?? 0,
  });
  return { guides: [...people, ...found.guides], skipped: [...skipped, ...found.skipped] };
}
