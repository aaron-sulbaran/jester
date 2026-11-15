// One round: play the clip, collect the player's frames on the clip's clock, score with the engine.
//
// Wiring note: every frame is tagged with `clipTimeMs`, the clip's own playback time when the frame
// arrived. The engine's webcam adapter prefers that over `trackerTimeAtClipStartMs`, and it stays right
// even if the video stalls. Frames before the clip starts are tagged -1 and dropped by the adapter.

import { fromWebcamFrames, scorePoseRound, scoreTrajectoryRound, type BodyPart, type PoseRoundResult, type TrajectoryRoundResult, type WebcamFrame, type LandmarkObject } from "../../engine/src/index.ts";
import { createWebcamTracker as createTrackerJs } from "../../spikes/pose-match/webcam.mjs";
import { simulatedPlayerPose } from "../../spikes/pose-match/synthetic.mjs";
import type { Clip } from "./clip.ts";
import { live } from "./liveHands.ts";
import { stampAt } from "./stamp.ts";
import { preloadModels } from "./preload.ts";

// Warm the browser cache with the tracking models a moment after the page opens, so the first round starts sooner.
if (typeof window !== "undefined") window.setTimeout(preloadModels, 1500);
import type { ObjectClip } from "./objectClips.ts";
import type { PersonMask } from "./cutout.ts";

// webcam.mjs is plain JS; TypeScript infers its options from the `= {}` default, so give it the real shape.
interface Tracker { start(): void; stop(): void; stats: { fps: number; model: string; delegate: string } }
const createWebcamTracker = createTrackerJs as unknown as (o: { video: HTMLVideoElement; onFrame: (f: any) => void; model?: string; minFps?: number }) => Promise<Tracker>;

export interface LiveFrame {
  clipMs: number;
  player: LandmarkObject[] | null;
  playerAspect: number;
}

/** Gets each frame's image, landmarks and person mask, for cutouts. `source` is null for a simulated player. */
export type CaptureFn = (f: { landmarks: LandmarkObject[]; mask: PersonMask | null; source: CanvasImageSource | null; width: number; height: number; clipMs: number }) => void;

export interface Player {
  /** Starts sending frames; each one goes to `onFrame`. */
  start(onFrame: (f: WebcamFrame) => void, clipClockMs: () => number): void;
  stop(): void;
  /** Optional: also hand each frame's image and mask to `fn` while a round runs (null turns it off). */
  setCapture?(fn: CaptureFn | null): void;
}

/** The real camera, through Lisa's tracker (smoothed pose). */
export async function cameraPlayer(cam: HTMLVideoElement): Promise<Player> {
  let sink: ((f: WebcamFrame) => void) | null = null;
  let clock: () => number = () => -1;
  let capture: CaptureFn | null = null;
  let shotAt = -1;
  // The camera permission prompt and the tracker's models load at the same time, not one after the other.
  const streamPromise = navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  streamPromise.catch(() => {}); // a refusal is reported below; this keeps it from also being reported as unhandled
  const tracker = await createWebcamTracker({
    video: cam,
    model: new URLSearchParams(location.search).get("model") ?? "full", // add ?model=heavy to the page address for the most accurate (slower) tracker
    // Drop the mask and outline: the pose channel does not use them, and a minute of masks is a lot of memory.
    onFrame: (f: any) => {
      live.hands = f.hands ?? []; live.at = performance.now(); // fingers, drawn by draw.ts
      if (!sink) return;
      const clipMs = stampAt(clock(), performance.now(), shotAt);
      sink({ t: f.t, landmarks: f.landmarks, aspect: f.aspect, mirrored: f.mirrored, clipTimeMs: clipMs });
      // The camera element still shows the frame just tracked, so the crop matches these landmarks.
      if (capture && f.landmarks && clipMs >= 0) capture({ landmarks: f.landmarks, mask: f.mask ?? null, source: cam, width: cam.videoWidth, height: cam.videoHeight, clipMs });
    },
  });
  cam.srcObject = await streamPromise;
  // When the camera frame now showing was taken (or, failing that, shown), so each pose is stamped with the
  // moment it happened rather than when tracking it finished. The browser calls this just before the
  // tracker's next look, so it is the frame the tracker reads.
  if (typeof cam.requestVideoFrameCallback === "function") {
    const watch = (_now: number, meta: VideoFrameCallbackMetadata) => { shotAt = meta.captureTime ?? meta.presentationTime; cam.requestVideoFrameCallback(watch); };
    cam.requestVideoFrameCallback(watch);
  }
  await cam.play();
  tracker.start();
  return {
    start(onFrame, clipClockMs) { sink = onFrame; clock = clipClockMs; },
    stop() { sink = null; capture = null; },
    setCapture(fn) { capture = fn; },
  };
}

/** A stand-in performer that copies the clip with some wobble and 150 ms lag. For testing without a camera. */
/** Knees, ankles, heels, toes: hidden when the simulated player is seated (`?seated=1`). */
const LEG_POINTS = new Set([25, 26, 27, 28, 29, 30, 31, 32]);

export function simulatedPlayer(clip: Pick<Clip, "samples" | "width" | "height">, noiseDegrees: () => number, seated = false): Player {
  let timer = 0;
  let capture: CaptureFn | null = null;
  const aspect = clip.width / clip.height;
  return {
    // A 30 Hz timer, not requestAnimationFrame, so it keeps running in a background tab.
    start(onFrame, clipClockMs) {
      const loop = () => {
        const ms = clipClockMs();
        let landmarks: LandmarkObject[] | null = ms >= 0 ? simulatedPlayerPose(clip.samples, ms / 1000, { noiseDegrees: noiseDegrees(), aspect }) : null;
        if (landmarks && seated) landmarks = landmarks.map((l, i) => (LEG_POINTS.has(i) ? { ...l, visibility: 0 } : l));
        onFrame({ t: performance.now(), landmarks, aspect, mirrored: false, clipTimeMs: ms });
        if (capture && landmarks && ms >= 0) capture({ landmarks, mask: null, source: null, width: Math.round(480 * aspect), height: 480, clipMs: ms });
      };
      timer = window.setInterval(loop, 1000 / 30);
    },
    stop() { clearInterval(timer); capture = null; },
    setCapture(fn) { capture = fn; },
  };
}

export interface RoundResult<R = PoseRoundResult> {
  result: R;
  frames: WebcamFrame[];
}

/**
 * Collect the player's frames for one play of a clip. `video` is the clip's video element, or null for a
 * clip with no video (then the clock is wall time from the start and the round lasts `durationMs`).
 */
export function collectFrames(durationMs: number, video: HTMLVideoElement | null, player: Player, onLive: (f: LiveFrame) => void): Promise<WebcamFrame[]> {
  return new Promise((resolve) => {
    const frames: WebcamFrame[] = [];
    const started = performance.now();
    const clock = video
      ? () => (video.paused && video.currentTime === 0 ? -1 : video.currentTime * 1000)
      : () => performance.now() - started;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      player.stop();
      resolve(frames);
    };
    player.start((f) => {
      if (done) return;
      frames.push(f);
      onLive({ clipMs: f.clipTimeMs ?? -1, player: (f.landmarks as LandmarkObject[] | null) ?? null, playerAspect: f.aspect });
      if (!video && (f.clipTimeMs ?? 0) >= durationMs) finish();
    }, clock);
    if (video) {
      video.currentTime = 0;
      video.addEventListener("ended", finish, { once: true });
      void video.play();
    }
  });
}

/** A person clip: limb-by-limb pose scoring. */
export async function playRound(clip: Clip, video: HTMLVideoElement | null, player: Player, onLive: (f: LiveFrame) => void): Promise<RoundResult> {
  const frames = await collectFrames(clip.durationMs, video, player, onLive);
  return { result: scorePoseRound(clip.timeline, fromWebcamFrames(frames)), frames };
}

/** An object clip: the player copies the object's movement with their whole body (trajectory channel). */
export async function playObjectRound(clip: ObjectClip, player: Player, onLive: (f: LiveFrame) => void, bodyPart: BodyPart = "body"): Promise<RoundResult<TrajectoryRoundResult>> {
  const frames = await collectFrames(clip.durationMs, null, player, onLive);
  return { result: scoreTrajectoryRound(clip.track, fromWebcamFrames(frames), { bodyPart }), frames };
}
