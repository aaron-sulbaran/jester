// Starting a round from a bank clip with no analysis at play time: the clip's moves come from its saved
// guides (./bank.ts), and the video plays from the bank's address.
//
//   const listed = await listBank();
//   const scene = await bankScene(listed.data[0], deps.clipVideo);       // blind mode: same Scene as videoScene
//   if (scene.error === null) await runBlindGame(scene.data, names, ui, deps);
//
//   const solo = await bankSoloClip(clip, guide, clipVideo);              // practice: one person, the Clip analyzeVideo gives
//   const thing = thingObjectClip(guide);                                 // practice: one thing (from ./clip.ts)

import { fromClipSamples, type ClipSample } from "../../engine/src/index.ts";
import type { Box, Guide, Outline } from "../../clip/src/index.ts";
import { loadBankGuides, type BankClip } from "./bank.ts";
import type { Scene } from "./blind.ts";
import type { Clip } from "./clip.ts";

type Result<T> = { data: T; error: null } | { data: null; error: string };

const VIDEO_UNREACHABLE = "The video for this clip did not load. Check your connection, or pick another clip.";
const NO_ONE = "No one to copy in this clip.";
const NOT_A_PERSON = "Practice with a person needs one of the people in this clip.";
const LOAD_TIMEOUT_MS = 20000;

/**
 * Points `video` at `url` and waits until its first frame can be drawn. The bank's files are served with
 * an open cross-origin header, and asking for them that way keeps canvases the video is drawn on readable,
 * so the reveal can be recorded.
 */
export function loadBankVideo(video: HTMLVideoElement, url: string): Promise<Result<HTMLVideoElement>> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: Result<HTMLVideoElement>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener("loadeddata", ok);
      video.removeEventListener("error", failed);
      resolve(result);
    };
    const ok = () => done({ data: video, error: null });
    const failed = () => done({ data: null, error: VIDEO_UNREACHABLE });
    const timer = setTimeout(failed, LOAD_TIMEOUT_MS);
    video.addEventListener("loadeddata", ok);
    video.addEventListener("error", failed);
    video.pause();
    video.crossOrigin = "anonymous";
    video.playsInline = true;
    video.preload = "auto";
    video.src = url;
    video.load();
  });
}

/** A box as a closed ellipse, as blind.ts gives things with no outline (the same 24 points). */
function ellipseOutline(b: Box, n = 24): Outline {
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return [b.cx + (b.w / 2) * Math.cos(a), b.cy + (b.h / 2) * Math.sin(a)] as [number, number];
  });
}

/** Things always get an outline to show, exactly as `videoScene` does it. */
function withThingOutlines(g: Guide): Guide {
  if (g.subject.kind !== "thing") return g;
  return { ...g, outlines: g.boxTrack.frames.map((f, i) => g.outlines[i] ?? (f.box ? ellipseOutline(f.box) : null)) };
}

/** The blind mode scene for a bank clip: the same thing `videoScene` builds from a file, without reading the file. */
export async function bankScene(clip: BankClip, video: HTMLVideoElement): Promise<Result<Scene>> {
  const guides = await loadBankGuides(clip);
  if (guides.error !== null) return guides;
  if (guides.data.length === 0) return { data: null, error: NO_ONE };
  const loaded = await loadBankVideo(video, clip.video);
  if (loaded.error !== null) return loaded;
  const g = guides.data[0]!;
  return {
    data: {
      name: clip.title, width: g.source.width, height: g.source.height,
      startMs: g.range.startMs, durationMs: g.range.endMs - g.range.startMs,
      guides: guides.data.map(withThingOutlines), video,
    },
    error: null,
  };
}

/**
 * The practice round's `Clip` for one person in a bank clip, as `analyzeVideo` gives it for a file: samples
 * on the video's own time from 0, empty before the guide's stretch starts. Play it with `playRound(clip, video, ...)`.
 */
export async function bankSoloClip(clip: BankClip, guide: Guide, video: HTMLVideoElement): Promise<Result<Clip>> {
  const timeline = guide.timeline;
  if (guide.subject.kind !== "person" || !timeline) return { data: null, error: NOT_A_PERSON };
  const loaded = await loadBankVideo(video, clip.video);
  if (loaded.error !== null) return loaded;
  const frameMs = 1000 / guide.source.sampleHz;
  const before: ClipSample[] = [];
  for (let t = 0; t < guide.range.startMs - frameMs / 2; t += frameMs) before.push({ t: t / 1000, landmarks: null });
  const during: ClipSample[] = timeline.frames.map((f) => ({
    t: (guide.range.startMs + f.tMs) / 1000,
    landmarks: f.landmarks ? f.landmarks.map(([x, y, visibility]) => ({ x, y, z: 0, visibility })) : null,
  }));
  const samples = [...before, ...during];
  const { width, height } = guide.source;
  const last = samples[samples.length - 1]?.t ?? 0;
  return {
    data: {
      samples, width, height, videoUrl: clip.video, guide,
      durationMs: last * 1000,
      timeline: fromClipSamples(samples, { width, height, timeUnit: "s" }),
    },
    error: null,
  };
}
