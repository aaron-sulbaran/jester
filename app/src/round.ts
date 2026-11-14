// One round: play the clip, collect the player's frames on the clip's clock, score with the engine.
//
// Wiring note: every frame is tagged with `clipTimeMs`, the clip's own playback time when the frame
// arrived. The engine's webcam adapter prefers that over `trackerTimeAtClipStartMs`, and it stays right
// even if the video stalls. Frames before the clip starts are tagged -1 and dropped by the adapter.

import { fromWebcamFrames, scorePoseRound, type PoseRoundResult, type WebcamFrame, type LandmarkObject } from "../../engine/src/index.ts";
import { createWebcamTracker as createTrackerJs } from "../../spikes/pose-match/webcam.mjs";
import { simulatedPlayerPose } from "../../spikes/pose-match/synthetic.mjs";
import type { Clip } from "./clip.ts";

// webcam.mjs is plain JS; TypeScript infers its options from the `= {}` default, so give it the real shape.
interface Tracker { start(): void; stop(): void; stats: { fps: number; model: string; delegate: string } }
const createWebcamTracker = createTrackerJs as unknown as (o: { video: HTMLVideoElement; onFrame: (f: any) => void; model?: string; minFps?: number }) => Promise<Tracker>;

export interface LiveFrame {
  clipMs: number;
  player: LandmarkObject[] | null;
  playerAspect: number;
}

export interface Player {
  /** Starts sending frames; each one goes to `onFrame`. */
  start(onFrame: (f: WebcamFrame) => void, clipClockMs: () => number): void;
  stop(): void;
}

/** The real camera, through Lisa's tracker (smoothed pose). */
export async function cameraPlayer(cam: HTMLVideoElement): Promise<Player> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
  cam.srcObject = stream;
  await cam.play();
  let sink: ((f: WebcamFrame) => void) | null = null;
  let clock: () => number = () => -1;
  const tracker = await createWebcamTracker({
    video: cam,
    model: "full",
    // Drop the mask and outline: the pose channel does not use them, and a minute of masks is a lot of memory.
    onFrame: (f: any) => sink?.({ t: f.t, landmarks: f.landmarks, aspect: f.aspect, mirrored: f.mirrored, clipTimeMs: clock() }),
  });
  tracker.start();
  return {
    start(onFrame, clipClockMs) { sink = onFrame; clock = clipClockMs; },
    stop() { sink = null; },
  };
}

/** A stand-in performer that copies the clip with some wobble and 150 ms lag. For testing without a camera. */
export function simulatedPlayer(clip: Clip, noiseDegrees: () => number): Player {
  let timer = 0;
  const aspect = clip.width / clip.height;
  return {
    // A 30 Hz timer, not requestAnimationFrame, so it keeps running in a background tab.
    start(onFrame, clipClockMs) {
      const loop = () => {
        const ms = clipClockMs();
        const landmarks = ms >= 0 ? simulatedPlayerPose(clip.samples, ms / 1000, { noiseDegrees: noiseDegrees(), aspect }) : null;
        onFrame({ t: performance.now(), landmarks, aspect, mirrored: false, clipTimeMs: ms });
      };
      timer = window.setInterval(loop, 1000 / 30);
    },
    stop() { clearInterval(timer); },
  };
}

export interface RoundResult {
  result: PoseRoundResult;
  frames: WebcamFrame[];
}

/**
 * Play the clip once while collecting frames. `video` is the clip's video element, or null for the
 * starter clip (then the clock is wall time from the start).
 */
export function playRound(clip: Clip, video: HTMLVideoElement | null, player: Player, onLive: (f: LiveFrame) => void): Promise<RoundResult> {
  return new Promise((resolve) => {
    const frames: WebcamFrame[] = [];
    const started = performance.now();
    const clock = video
      ? () => (video.paused && video.currentTime === 0 ? -1 : video.currentTime * 1000)
      : () => performance.now() - started;

    const finish = () => {
      player.stop();
      const playerTimeline = fromWebcamFrames(frames);
      resolve({ result: scorePoseRound(clip.timeline, playerTimeline), frames });
    };

    player.start((f) => {
      frames.push(f);
      onLive({ clipMs: f.clipTimeMs ?? -1, player: (f.landmarks as LandmarkObject[] | null) ?? null, playerAspect: f.aspect });
      if (!video && (f.clipTimeMs ?? 0) >= clip.durationMs) finish();
    }, clock);

    if (video) {
      video.currentTime = 0;
      video.addEventListener("ended", finish, { once: true });
      void video.play();
    }
  });
}
