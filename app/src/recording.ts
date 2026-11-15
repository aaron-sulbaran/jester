// Records the player's performance during a round without touching round.ts: wrap the Player.
//   const rec = recordingPlayer(await cameraPlayer(cam));
//   await playRound(clip, video, rec, onLive);
//   const timeline = rec.finish();   // pose data in clip time; no video, no mask
// Send serializeTimeline(timeline) to the room for the reveal.

import { PerformanceRecorder } from "../../spikes/pose-match/recorder.mjs";
import { serializeTimeline } from "../../spikes/pose-match/serialize.mjs";
import type { Player } from "./round.ts";

export interface RecordingPlayer extends Player {
  /** The finished recording, with the clip's length if known. */
  finish(durationMs?: number): ReturnType<PerformanceRecorder["finish"]>;
  /** The same recording in the compact form for sending to other devices. */
  compact(durationMs?: number): ReturnType<typeof serializeTimeline>;
}

export function recordingPlayer(inner: Player): RecordingPlayer {
  const recorder = new PerformanceRecorder();
  let aspect = 4 / 3;
  return {
    start(onFrame, clipClockMs) {
      recorder.reset();
      inner.start((f) => {
        aspect = f.aspect;
        recorder.add({ landmarks: f.landmarks as never, outline: null }, f.clipTimeMs ?? -1);
        onFrame(f);
      }, clipClockMs);
    },
    stop() { inner.stop(); },
    setCapture: inner.setCapture ? (fn) => inner.setCapture!(fn) : undefined,
    finish: (durationMs) => recorder.finish({ durationMs, aspect } as never),
    compact(durationMs) { return serializeTimeline(recorder.finish({ durationMs, aspect } as never), { every: 2 }); },
  };
}
