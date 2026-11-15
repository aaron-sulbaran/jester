// Records one player's performance as a timeline in CLIP time (ms from the clip's start).
// Pure: the caller passes each tracker frame together with the current clip time.
// Only pose data and a small outline are kept; the camera image and the mask are never stored.

export const MAX_FRAMES = 3000; // about 100 s at 30 fps

export class PerformanceRecorder {
  constructor({ maxFrames = MAX_FRAMES } = {}) { this.maxFrames = maxFrames; this.reset(); }
  reset() { this.frames = []; this.lost = 0; this.total = 0; this.lastT = -Infinity; }

  // frame: { landmarks, outline } from the webcam tracker. clipTimeMs: where the clip is now.
  // Frames before the clip starts (countdown) and out-of-order frames are ignored.
  add(frame, clipTimeMs) {
    if (clipTimeMs < 0 || clipTimeMs <= this.lastT || this.frames.length >= this.maxFrames) return false;
    this.lastT = clipTimeMs;
    this.total++;
    if (!frame || !frame.landmarks) { this.lost++; return false; }
    this.frames.push({ t: clipTimeMs, landmarks: frame.landmarks, outline: frame.outline || null });
    return true;
  }

  // coverage: share of frames where a body was found (low means the player left the frame).
  finish({ durationMs, aspect = 4 / 3, model = "pose_landmarker" } = {}) {
    const last = this.frames.length ? this.frames[this.frames.length - 1].t : 0;
    return {
      version: 1, source: "webcam", mirrored: false, model, aspect,
      durationMs: durationMs ?? last,
      coverage: this.total ? this.frames.length / this.total : 0,
      frames: this.frames.slice(),
    };
  }
}
