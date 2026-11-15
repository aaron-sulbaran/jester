// Grabbing the moves from a playing clip through tab capture, then the same analysis the file path
// builds (cuts, tracks, ranked candidates), saved under a key made from the link and the range.
// Frames are read, searched for people and dropped at once: no frame or video is kept, saved or sent.

import {
  checkClip, findCuts, frameSignature, linkTracks, pickConfirmFrame, rankCandidates, withConfirmBoxes,
} from "../../../clip/src/index.ts";
import type { ClipSource, FrameDetections } from "../../../clip/src/index.ts";
import type { Prepared } from "./analyze.ts";
import { drawTabFrame, type TabCapture } from "./capture.ts";
import { createPeopleDetector, type PeopleDetector } from "./detect.ts";
import { evenFrames, stitchTracks } from "./link.ts";
import { loadPrepared, savePrepared } from "./store.ts";
import { STATE, type YtPlayer } from "./youtube.ts";

export { loadPrepared } from "./store.ts";

export const SAMPLE_HZ = 15;
export const MAX_GRAB_MS = 30000;
export const MIN_GRAB_MS = 3000;
const MAX_SIDE = 720;
const SIGNATURE_WIDTH = 32;
const STEP_MS = 1000 / SAMPLE_HZ;

export const NOT_PLAYING = "The clip did not start playing. Press play on the video once, then try again.";
export const NOTHING_GRABBED = "Sharing stopped before the moves were grabbed. Press the button again.";
export const TOO_SHORT = "That grab was under 3 seconds. Grab a longer stretch.";
const JUMPY = "Some frames were missed while grabbing, so the moves may look a little jumpy.";
const CUT_SHORT = "Sharing stopped early, so only part of the range was grabbed.";

type Result<T> = { data: T; error: null } | { data: null; error: string };

/** How the grab went, for the lab's table: what was read, how fast, and whether this page was hidden. */
export interface GrabStats {
  /** Frames the tracker looked at, before evening out to 15 a second. */
  read: number;
  /** Seconds of clip covered. */
  seconds: number;
  /** Average tracker time per frame. */
  trackerMs: number;
  /** Seconds this page was hidden while grabbing. */
  hiddenSeconds: number;
  /** Slots filled from a frame more than one slot away. */
  stretched: number;
  tracksBeforeJoining: number;
  tracksAfterJoining: number;
}

export type GrabResult = ({ data: Prepared; error: null } | { data: null; error: string }) & { stats: GrabStats | null };

/** Collects the numbers for GrabStats as frames are read. */
class StatsCounter {
  read = 0;
  private trackerTotal = 0;
  private hiddenMs = 0;
  private lastAt: number | null = null;
  count(trackerMs: number) {
    const now = performance.now();
    if (this.lastAt !== null && document.visibilityState === "hidden") this.hiddenMs += now - this.lastAt;
    this.lastAt = now;
    this.read++;
    this.trackerTotal += trackerMs;
  }
  finish(seconds: number, stretched: number, before: number, after: number): GrabStats {
    return {
      read: this.read, seconds, trackerMs: this.read ? Math.round(this.trackerTotal / this.read) : 0,
      hiddenSeconds: Math.round(this.hiddenMs / 100) / 10, stretched, tracksBeforeJoining: before, tracksAfterJoining: after,
    };
  }
}

/** Prepared's decoder field names how frames were read; a grab reads them from tab capture. */
const TAB_CAPTURE = "tab-capture" as unknown as Prepared["decoder"];

function signatureOf(canvas: HTMLCanvasElement, scratch: HTMLCanvasElement): number[] {
  const height = Math.max(1, Math.round(SIGNATURE_WIDTH * canvas.height / canvas.width));
  scratch.width = SIGNATURE_WIDTH;
  scratch.height = height;
  const ctx = scratch.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(canvas, 0, 0, SIGNATURE_WIDTH, height);
  return frameSignature(ctx.getImageData(0, 0, SIGNATURE_WIDTH, height).data, SIGNATURE_WIDTH, height);
}

/** Reads people from one captured frame. Keeps two canvases and nothing else between frames. */
class FrameReader {
  private readonly work = document.createElement("canvas");
  private readonly scratch = document.createElement("canvas");
  readonly stats = new StatsCounter();
  width = 0;
  height = 0;
  constructor(private readonly detector: PeopleDetector) {}
  read(frame: VideoFrame, tMs: number): FrameDetections {
    if (!this.width) { this.width = frame.displayWidth; this.height = frame.displayHeight; }
    drawTabFrame(frame, this.work, MAX_SIDE);
    const began = performance.now();
    const people = this.detector.detect(this.work, tMs);
    this.stats.count(performance.now() - began);
    return { tMs, people, signature: signatureOf(this.work, this.scratch) };
  }
}

/** Evens the grabbed frames to 15 a second and runs the clip side on them, as prepareClip does for a file. */
async function finishGrab(
  grabbed: FrameDetections[], startMs: number, endMs: number, reader: FrameReader,
  key: string, warnings: string[],
): Promise<GrabResult> {
  if (endMs - startMs < MIN_GRAB_MS || grabbed.length === 0) return { data: null, error: TOO_SHORT, stats: null };
  const { frames, stretched } = evenFrames(grabbed, startMs, endMs, SAMPLE_HZ);
  const source: ClipSource = { width: reader.width, height: reader.height, durationMs: endMs - startMs, sampleHz: SAMPLE_HZ };
  const cuts = findCuts(frames.map((f) => f.signature));
  // Live grabs split one fast mover into pieces more often than files do; join them back.
  const linked = linkTracks(frames, cuts);
  const tracks = stitchTracks(linked);
  const stats = reader.stats.finish(Math.round((endMs - startMs) / 100) / 10, stretched, linked.length, tracks.length);
  const ranked = rankCandidates(tracks, { sampleHz: SAMPLE_HZ, frameCount: frames.length });
  const confirmFrame = pickConfirmFrame(ranked, tracks);
  const candidates = withConfirmBoxes(ranked, tracks, confirmFrame);
  const verdict = checkClip({ durationMs: source.durationMs, cuts, candidates });
  if (verdict.refuse !== null) return { data: null, error: verdict.refuse, stats };
  const prepared: Prepared = {
    fingerprint: key, source, frames, cuts, tracks, candidates, confirmFrame,
    confirmTMs: frames[confirmFrame]?.tMs ?? startMs,
    warnings: [...warnings, ...(stretched > frames.length / 5 ? [JUMPY] : []), ...verdict.warnings],
    decoder: TAB_CAPTURE, fromSaved: false,
  };
  await savePrepared(prepared);
  return { data: prepared, error: null, stats };
}

async function makeDetector(): Promise<Result<PeopleDetector>> {
  return createPeopleDetector();
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Flow A: plays the embedded YouTube player from `startMs` to `endMs` while `capture` (this tab,
 * cropped to the player) is read. Each frame is stamped with the player's own time, less the
 * frame's age. Stops the capture and pauses the player at the end. Progress runs 0 to 1.
 */
export async function grabFromPlayer(
  capture: TabCapture, player: YtPlayer, range: { startMs: number; endMs: number }, key: string,
  onProgress: (share: number) => void,
): Promise<GrabResult> {
  const detector = await makeDetector();
  if (detector.error !== null) { capture.stop(); return { data: null, error: detector.error, stats: null }; }
  const reader = new FrameReader(detector.data);
  const { startMs, endMs } = range;
  const grabbed: FrameDetections[] = [];
  try {
    player.mute();
    player.seekTo(startMs / 1000, true);
    player.playVideo();
    const startedWaiting = performance.now();
    while (!(player.getPlayerState() === STATE.PLAYING && Math.abs(player.getCurrentTime() * 1000 - startMs) < 1500)) {
      if (performance.now() - startedWaiting > 15000) { capture.stop(); return { data: null, error: NOT_PLAYING, stats: null }; }
      await pause(100);
    }

    let lastT = -Infinity;
    let reachedEnd = false;
    // Frames stop coming if the tab stops changing; this makes sure the grab still ends.
    const watchdog = setInterval(() => {
      if (player.getCurrentTime() * 1000 >= endMs || player.getPlayerState() === STATE.ENDED) { reachedEnd = true; capture.stop(); }
    }, 250);
    try {
      await capture.read(STEP_MS, ({ frame, ageMs }) => {
        if (player.getPlayerState() !== STATE.PLAYING) return;
        const t = player.getCurrentTime() * 1000 - ageMs;
        // A frame from before the seek, a stall, or an ad: the clip's time is not moving forward.
        if (t < startMs - STEP_MS || t <= lastT + 5) return;
        if (t >= endMs) { reachedEnd = true; capture.stop(); return; }
        grabbed.push(reader.read(frame, t));
        lastT = t;
        onProgress(Math.min(1, (t - startMs) / (endMs - startMs)));
      });
    } finally {
      clearInterval(watchdog);
    }
    capture.stop();
    player.pauseVideo();
    if (grabbed.length === 0) return { data: null, error: NOTHING_GRABBED, stats: null };
    const lastMs = reachedEnd ? endMs : Math.min(endMs, lastT + STEP_MS);
    onProgress(1);
    return await finishGrab(grabbed, startMs, lastMs, reader, key, reachedEnd ? [] : [CUT_SHORT]);
  } finally {
    capture.stop();
    detector.data.close();
  }
}

/** Flow B, while it runs: the live view is drawn, and Start and Stop control what is kept. */
export interface OtherTabGrab {
  /** Starts keeping the moves; the clock starts now. */
  start(): void;
  /** Stops sharing and finishes the grab. */
  stop(): void;
  /** Settles once sharing has stopped: the analysis, or the sentence why not. */
  done: Promise<GrabResult>;
}

/**
 * Flow B: another tab, any site. `live` shows the tab while it is shared. Nothing is kept until
 * `start()`; then frames are stamped with the time since Start, for at most 30 seconds.
 * `onTick` gets the seconds kept so far (null before Start). The analysis is saved under
 * `keyFor(lengthMs)`.
 */
export async function grabFromOtherTab(
  capture: TabCapture, live: HTMLCanvasElement, keyFor: (lengthMs: number) => string,
  onTick: (seconds: number | null) => void,
): Promise<Result<OtherTabGrab>> {
  const detector = await makeDetector();
  if (detector.error !== null) { capture.stop(); return { data: null, error: detector.error }; }
  const reader = new FrameReader(detector.data);
  const grabbed: FrameDetections[] = [];
  let startedAt: number | null = null;
  let lastT = 0;
  let limit: ReturnType<typeof setTimeout> | null = null;

  const reading = capture.read(STEP_MS, ({ frame, arrivedAt, ageMs }) => {
    if (startedAt === null) {
      drawTabFrame(frame, live, 640);
      onTick(null);
      return;
    }
    const t = arrivedAt - ageMs - startedAt;
    if (t < 0) return;
    if (t >= MAX_GRAB_MS) { capture.stop(); return; }
    grabbed.push(reader.read(frame, t));
    lastT = t;
    onTick(t / 1000);
  });

  const done = (async (): Promise<GrabResult> => {
    try {
      await reading;
    } catch {
      // Reading ended with the track; what was grabbed is still used.
    } finally {
      if (limit) clearTimeout(limit);
      capture.stop();
      detector.data.close();
    }
    if (startedAt === null || grabbed.length === 0) return { data: null, error: NOTHING_GRABBED, stats: null };
    const lengthMs = Math.min(MAX_GRAB_MS, Math.round(lastT + STEP_MS));
    return finishGrab(grabbed, 0, lengthMs, reader, keyFor(lengthMs), []);
  })();

  return {
    error: null,
    data: {
      start() {
        if (startedAt !== null) return;
        startedAt = performance.now();
        onTick(0);
        limit = setTimeout(() => capture.stop(), MAX_GRAB_MS + 500);
      },
      stop: () => capture.stop(),
      done,
    },
  };
}

const POINTER_PREFIX = "jester.grab.";

/** Remembers the last grab for a link, so the next visit can offer it. Best effort. */
export function rememberGrab(linkKey: string, fingerprint: string) {
  try { localStorage.setItem(POINTER_PREFIX + linkKey, fingerprint); } catch { /* not remembered */ }
}

/** The saved analysis of the last grab for this link, if there is one. */
export async function lastGrab(linkKey: string): Promise<Prepared | null> {
  let fingerprint: string | null = null;
  try { fingerprint = localStorage.getItem(POINTER_PREFIX + linkKey); } catch { return null; }
  return fingerprint ? loadPrepared(fingerprint) : null;
}
