// Grabbing the moves from a playing clip through tab capture, then the same analysis the file path
// builds (cuts, tracks, ranked candidates), saved under a key made from the link and the range.
// Frames are read, searched for people and dropped at once: no frame or video is kept, saved or sent.

import {
  checkClip, findCuts, frameSignature, linkThings, linkTracks, pickConfirmFrame, rankCandidates, rankThings,
  rejoinTracks, withConfirmBoxes, withoutPeople,
} from "../../../clip/src/index.ts";
import type { Candidate, ClipSource, FrameDetections, ThingDetection, ThingFrame } from "../../../clip/src/index.ts";
import type { Prepared, PreparedThings } from "./analyze.ts";
import { drawTabFrame, type TabCapture } from "./capture.ts";
import { createPeopleDetector, type PeopleDetector } from "./detect.ts";
import { createThingDetector, type ThingDetector } from "./things.ts";
import { evenFrames } from "./link.ts";
import { loadPrepared, savePrepared } from "./store.ts";
import { STATE, type YtPlayer } from "./youtube.ts";


export const SAMPLE_HZ = 15;
export const MAX_GRAB_MS = 30000;
export const MIN_GRAB_MS = 3000;
const MAX_SIDE = 512;
const SIGNATURE_WIDTH = 32;
const STEP_MS = 1000 / SAMPLE_HZ;
/** A person lost for up to this long is joined back into one track; same as the file path. */
const REJOIN_SECONDS = 3;
/** With things on, the object detector looks at every this many grabbed frames; same as the file path (#41). */
const THING_EVERY = 6;
const NO_PERSON = "No person found in this clip.";

export interface GrabOptions {
  /** Also find things (animals, balls, cars) with the object detector. The player chooses before grabbing. */
  things?: boolean;
}

/** A grabbed frame: its people, and its things when the object detector looked at it. */
type GrabbedFrame = FrameDetections & { things: ThingDetection[] | null };

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
  /** Things followed through the grab, or null when things were off. */
  things: number | null;
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
  finish(seconds: number, stretched: number, before: number, after: number, things: number | null): GrabStats {
    return {
      read: this.read, seconds, trackerMs: this.read ? Math.round(this.trackerTotal / this.read) : 0,
      hiddenSeconds: Math.round(this.hiddenMs / 100) / 10, stretched, tracksBeforeJoining: before, tracksAfterJoining: after, things,
    };
  }
}

/**
 * Follows each person through the frames and joins people split into pieces, with the same calls and
 * settings as the file path (analyze.ts), then ranks them. Pure and quick, so saved grabs run it again.
 */
function followPeople(frames: readonly FrameDetections[], cuts: readonly number[], source: ClipSource) {
  const linked = linkTracks(frames, cuts, { maxGap: SAMPLE_HZ });
  const tracks = rejoinTracks(linked, { maxGap: REJOIN_SECONDS * SAMPLE_HZ, aspect: source.width / source.height });
  const ranked = rankCandidates(tracks, { sampleHz: SAMPLE_HZ, frameCount: frames.length });
  const confirmFrame = pickConfirmFrame(ranked, tracks);
  const candidates = withConfirmBoxes(ranked, tracks, confirmFrame);
  const verdict = checkClip({ durationMs: source.durationMs, cuts, candidates });
  return { piecesBeforeJoining: linked.length, tracks, candidates, confirmFrame, confirmTMs: frames[confirmFrame]?.tMs ?? 0, verdict };
}

/** Follows and ranks the things, leaving out boxes that are mostly a person; same as the file path. */
function findThings(thingFrames: ThingFrame[], frames: readonly FrameDetections[], cuts: readonly number[], source: ClipSource): PreparedThings {
  const aspect = source.width / source.height;
  const kept = withoutPeople(thingFrames, frames.map((f) => f.people.map((p) => p.box)));
  const tracks = linkThings(kept, cuts, { aspect });
  const candidates = rankThings(tracks, { sampleHz: source.sampleHz, frameCount: frames.length, aspect });
  return { frames: kept, tracks, candidates };
}

/** The clip's refusal, except that with no people a moving thing still makes a role; same as the file path. */
function refusalWith(refusal: string | null, things: PreparedThings | null, source: ClipSource, cuts: readonly number[]): string | null {
  if (refusal !== NO_PERSON || !things || !things.candidates.some((c) => c.moves)) return refusal;
  const standIns: Candidate[] = things.candidates.map((c) => ({ trackId: c.trackId, number: c.number, label: c.label, score: c.score, boxAtConfirm: null }));
  return checkClip({ durationMs: source.durationMs, cuts, candidates: standIns }).refuse;
}

/**
 * The saved grab under `key`, with the people followed again by the current rules (saved grabs keep
 * the frames as read). Null when there is none, when things are wanted and it was grabbed without
 * them, or when the current rules refuse it.
 */
export async function loadGrab(key: string, options: GrabOptions = {}): Promise<Prepared | null> {
  const saved = await loadPrepared(key);
  if (!saved || (options.things && !saved.things)) return null;
  const { verdict, piecesBeforeJoining: _pieces, ...people } = followPeople(saved.frames, saved.cuts, saved.source);
  if (refusalWith(verdict.refuse, saved.things ?? null, saved.source, saved.cuts) !== null) return null;
  const warnings = [...saved.warnings.filter((w) => w === JUMPY || w === CUT_SHORT), ...verdict.warnings];
  return { ...saved, ...people, warnings };
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

/** Reads people (and things, when on) from one captured frame. Keeps two canvases and nothing else between frames. */
class FrameReader {
  private readonly work = document.createElement("canvas");
  private readonly scratch = document.createElement("canvas");
  readonly stats = new StatsCounter();
  width = 0;
  height = 0;
  constructor(private readonly people: PeopleDetector, readonly thingDetector: ThingDetector | null) {}
  read(frame: VideoFrame, tMs: number): GrabbedFrame {
    if (!this.width) { this.width = frame.displayWidth; this.height = frame.displayHeight; }
    drawTabFrame(frame, this.work, MAX_SIDE);
    const began = performance.now();
    const people = this.people.detect(this.work, tMs);
    const things = this.thingDetector && this.stats.read % THING_EVERY === 0 ? this.thingDetector.detect(this.work, tMs) : null;
    this.stats.count(performance.now() - began);
    return { tMs, people, signature: signatureOf(this.work, this.scratch), things };
  }
  close() {
    this.people.close();
    this.thingDetector?.close();
  }
}

/** The people detector, and the things detector when asked for. */
async function makeReader(options: GrabOptions): Promise<Result<FrameReader>> {
  const people = await createPeopleDetector();
  if (people.error !== null) return people;
  if (!options.things) return { data: new FrameReader(people.data, null), error: null };
  const things = await createThingDetector();
  if (things.error !== null) {
    people.data.close();
    return things;
  }
  return { data: new FrameReader(people.data, things.data), error: null };
}

/** Evens the grabbed frames to 15 a second and runs the clip side on them, as prepareClip does for a file. */
async function finishGrab(
  grabbed: GrabbedFrame[], startMs: number, endMs: number, reader: FrameReader,
  key: string, warnings: string[],
): Promise<GrabResult> {
  if (endMs - startMs < MIN_GRAB_MS || grabbed.length === 0) return { data: null, error: TOO_SHORT, stats: null };
  const { frames, nearest, stretched } = evenFrames(grabbed, startMs, endMs, SAMPLE_HZ);
  const source: ClipSource = { width: reader.width, height: reader.height, durationMs: endMs - startMs, sampleHz: SAMPLE_HZ };
  const cuts = findCuts(frames.map((f) => f.signature));
  const { verdict, piecesBeforeJoining, ...people } = followPeople(frames, cuts, source);
  let things: PreparedThings | null = null;
  if (reader.thingDetector) {
    // A grabbed frame's things go to the first slot it fills only, so one sighting is not counted twice.
    const used = new Set<GrabbedFrame>();
    const thingFrames: ThingFrame[] = frames.map((f, k) => {
      const from = nearest[k]!;
      const first = !used.has(from);
      used.add(from);
      return { tMs: f.tMs, things: first ? from.things : null };
    });
    things = findThings(thingFrames, frames, cuts, source);
  }
  const stats = reader.stats.finish(
    Math.round((endMs - startMs) / 100) / 10, stretched, piecesBeforeJoining, people.tracks.length, things ? things.candidates.length : null,
  );
  const refusal = refusalWith(verdict.refuse, things, source, cuts);
  if (refusal !== null) return { data: null, error: refusal, stats };
  const prepared: Prepared = {
    fingerprint: key, source, frames, cuts, ...people,
    warnings: [...warnings, ...(stretched > frames.length / 5 ? [JUMPY] : []), ...verdict.warnings],
    decoder: TAB_CAPTURE, fromSaved: false,
    ...(things ? { things } : {}),
  };
  await savePrepared(prepared);
  return { data: prepared, error: null, stats };
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Flow A: plays the embedded YouTube player from `startMs` to `endMs` while `capture` (this tab,
 * cropped to the player) is read. Each frame is stamped with the player's own time, less the
 * frame's age. Stops the capture and pauses the player at the end. Progress runs 0 to 1.
 */
export async function grabFromPlayer(
  capture: TabCapture, player: YtPlayer, range: { startMs: number; endMs: number }, key: string,
  onProgress: (share: number) => void, options: GrabOptions = {},
): Promise<GrabResult> {
  const made = await makeReader(options);
  if (made.error !== null) { capture.stop(); return { data: null, error: made.error, stats: null }; }
  const reader = made.data;
  const { startMs, endMs } = range;
  const grabbed: GrabbedFrame[] = [];
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
    reader.close();
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
  onTick: (seconds: number | null) => void, options: GrabOptions = {},
): Promise<Result<OtherTabGrab>> {
  const made = await makeReader(options);
  if (made.error !== null) { capture.stop(); return { data: null, error: made.error }; }
  const reader = made.data;
  const grabbed: GrabbedFrame[] = [];
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
      reader.close();
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
  return fingerprint ? loadGrab(fingerprint) : null;
}
