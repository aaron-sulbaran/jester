// Calibration and placement hints for the live player. Pure functions, no DOM.
// Landmarks are the raw (unmirrored) MediaPipe landmarks the webcam tracker emits.

export const KEY_JOINTS = { leftShoulder: 11, rightShoulder: 12, leftHip: 23, rightHip: 24, leftKnee: 25, rightKnee: 26, leftAnkle: 27, rightAnkle: 28 };
export const MIN_VISIBILITY = 0.5;
export const HOLD_FRAMES = 20;   // consecutive good frames to pass (about 0.7 s at 30 fps)
export const MIN_FPS = 18;

const inFrame = (lm) => lm && (lm.visibility ?? 1) >= MIN_VISIBILITY && lm.x >= 0 && lm.x <= 1 && lm.y >= 0 && lm.y <= 1;

// Which key joints are missing, and one plain instruction for the player.
export function checkFraming(landmarks) {
  if (!landmarks) return { ok: false, missing: Object.keys(KEY_JOINTS), message: "I can't see you. Step into the picture." };
  const missing = Object.entries(KEY_JOINTS).filter(([, i]) => !inFrame(landmarks[i])).map(([name]) => name);
  if (missing.length === 0) return { ok: true, missing, message: "Good. Hold still." };
  const legs = missing.filter((n) => /Knee|Ankle/.test(n)).length;
  const upper = missing.filter((n) => /Shoulder|Hip/.test(n)).length;
  const message = legs && !upper ? "Step back until your knees and ankles are in view." : upper && !legs ? "Step back so your shoulders and hips are in view." : "Step back so your whole body is in view.";
  return { ok: false, missing, message };
}

// Feed frames one at a time; passes after HOLD_FRAMES good frames in a row.
export class Calibrator {
  constructor({ holdFrames = HOLD_FRAMES, minFps = MIN_FPS } = {}) { this.holdFrames = holdFrames; this.minFps = minFps; this.reset(); }
  reset() { this.good = 0; this.passed = false; }
  update(landmarks, fps = 30) {
    const framing = checkFraming(landmarks);
    this.good = framing.ok ? this.good + 1 : 0;
    if (this.good >= this.holdFrames) this.passed = true;
    return { ...framing, progress: Math.min(1, this.good / this.holdFrames), passed: this.passed, lowFps: fps < this.minFps, model: fps < this.minFps ? "lite" : "full" };
  }
}

// Where the player stands: hip centre and torso length, in image fractions (raw, unmirrored).
export function playerStance(landmarks) {
  if (!landmarks) return null;
  const [lh, rh, ls, rs] = [23, 24, 11, 12].map((i) => landmarks[i]);
  const hip = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };
  const shoulder = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  return { x: hip.x, y: hip.y, torso: Math.hypot(shoulder.x - hip.x, shoulder.y - hip.y) };
}

// Hint to match the clip's subject position and size. The player view is a mirror, so the
// player's x is flipped (1 - x) to compare with the clip; "left" and "right" are the player's own.
// Returns { hint, dx, scale } where hint is one of "ok", "move left", "move right", "step back", "step closer".
export function placementHint(player, reference, { tolerance = 0.08, sizeTolerance = 0.25 } = {}) {
  if (!player || !reference) return { hint: "ok", dx: 0, scale: 1 };
  const dx = reference.x - (1 - player.x);      // positive: clip subject is further right on screen
  const scale = player.torso / reference.torso; // above 1: player looks bigger than the clip subject
  if (scale > 1 + sizeTolerance) return { hint: "step back", dx, scale };
  if (scale < 1 - sizeTolerance) return { hint: "step closer", dx, scale };
  if (dx > tolerance) return { hint: "move right", dx, scale };
  if (dx < -tolerance) return { hint: "move left", dx, scale };
  return { hint: "ok", dx, scale };
}
