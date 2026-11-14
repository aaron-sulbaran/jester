// Synthetic stick figures and a simulated performer. Pure functions, no DOM.
// Used by the unit tests and by the ?demo=1 and ?nocam=1 modes of the page.
import { LANDMARK as L, mirrorPose } from "./score.mjs";

// Limb angles are in degrees in image space: 0 points straight down, 90 points
// toward image +x (the figure's own left side when it faces the camera), 180 up.
export const POSES = {
  rest: { leftUpperArm: 15, leftForearm: 10, rightUpperArm: -15, rightForearm: -10, leftThigh: 5, leftShin: 0, rightThigh: -5, rightShin: 0, lean: 0 },
  armsUp: { leftUpperArm: 160, leftForearm: 170, rightUpperArm: -160, rightForearm: -170, leftThigh: 5, leftShin: 0, rightThigh: -5, rightShin: 0, lean: 0 },
  tPose: { leftUpperArm: 90, leftForearm: 90, rightUpperArm: -90, rightForearm: -90, leftThigh: 8, leftShin: 0, rightThigh: -8, rightShin: 0, lean: 0 },
  leftArmUp: { leftUpperArm: 170, leftForearm: 175, rightUpperArm: -10, rightForearm: -5, leftThigh: 5, leftShin: 0, rightThigh: -5, rightShin: 0, lean: 0 },
  squat: { leftUpperArm: 80, leftForearm: 60, rightUpperArm: -80, rightForearm: -60, leftThigh: 70, leftShin: -10, rightThigh: -70, rightShin: 10, lean: 0 },
  leanRight: { leftUpperArm: 140, leftForearm: 150, rightUpperArm: -40, rightForearm: -30, leftThigh: 5, leftShin: 0, rightThigh: -15, rightShin: -5, lean: -25 },
};

export const DEMO_SEQUENCE = ["rest", "armsUp", "tPose", "leftArmUp", "squat", "leanRight", "tPose", "armsUp", "squat", "rest"];

const SEGMENT = { torso: 0.3, shoulderHalf: 0.11, hipHalf: 0.07, upperArm: 0.15, forearm: 0.14, thigh: 0.21, shin: 0.21, head: 0.09 };

function direction(degrees) {
  const r = (degrees * Math.PI) / 180;
  return { x: Math.sin(r), y: Math.cos(r) };
}
function step(from, degrees, length) {
  const d = direction(degrees);
  return { x: from.x + d.x * length, y: from.y + d.y * length };
}

/**
 * Build 33 landmarks from limb angles.
 * Layout is computed in image-height units, then x is divided by the aspect ratio
 * so the output is in normalized image coordinates like MediaPipe produces.
 * options: {centerX (0..1 normalized), groundY, scale, aspect}
 */
export function makeStickPose(spec, options = {}) {
  const { centerX = 0.5, groundY = 0.92, scale = 1, aspect = 1 } = options;
  const s = scale;
  const hipMid = { x: 0, y: 0 };
  const torsoAngle = 180 + (spec.lean || 0);
  const shoulderMid = step(hipMid, torsoAngle, SEGMENT.torso * s);
  const across = 90 + (spec.lean || 0); // perpendicular to the torso, toward the figure's left
  const p = new Array(33);
  p[L.leftShoulder] = step(shoulderMid, across, SEGMENT.shoulderHalf * s);
  p[L.rightShoulder] = step(shoulderMid, across + 180, SEGMENT.shoulderHalf * s);
  p[L.leftHip] = step(hipMid, across, SEGMENT.hipHalf * s);
  p[L.rightHip] = step(hipMid, across + 180, SEGMENT.hipHalf * s);
  p[L.leftElbow] = step(p[L.leftShoulder], spec.leftUpperArm, SEGMENT.upperArm * s);
  p[L.leftWrist] = step(p[L.leftElbow], spec.leftForearm, SEGMENT.forearm * s);
  p[L.rightElbow] = step(p[L.rightShoulder], spec.rightUpperArm, SEGMENT.upperArm * s);
  p[L.rightWrist] = step(p[L.rightElbow], spec.rightForearm, SEGMENT.forearm * s);
  p[L.leftKnee] = step(p[L.leftHip], spec.leftThigh, SEGMENT.thigh * s);
  p[L.leftAnkle] = step(p[L.leftKnee], spec.leftShin, SEGMENT.shin * s);
  p[L.rightKnee] = step(p[L.rightHip], spec.rightThigh, SEGMENT.thigh * s);
  p[L.rightAnkle] = step(p[L.rightKnee], spec.rightShin, SEGMENT.shin * s);
  const headCenter = step(shoulderMid, torsoAngle, SEGMENT.head * s);
  for (let i = 0; i <= 10; i++) p[i] = { x: headCenter.x + (i % 2 ? 0.01 : -0.01) * s, y: headCenter.y };
  // Hands and feet sit just past wrists and ankles.
  for (const [side, wrist] of [[0, L.leftWrist], [1, L.rightWrist]]) for (const i of [17, 19, 21]) p[i + side] = { ...p[wrist] };
  for (const [side, ankle] of [[0, L.leftAnkle], [1, L.rightAnkle]]) for (const i of [29, 31]) p[i + side] = { x: p[ankle].x, y: p[ankle].y + 0.01 * s };
  // Stand the figure on the ground line.
  const lowest = Math.max(p[L.leftAnkle].y, p[L.rightAnkle].y);
  const offsetY = groundY - lowest - 0.02;
  return p.map((pt) => ({ x: centerX + pt.x / aspect, y: pt.y + offsetY, z: 0, visibility: 1 }));
}

export function blendSpecs(a, b, amount) {
  const out = {};
  for (const key of Object.keys(a)) out[key] = a[key] + ((b[key] ?? 0) - a[key]) * amount;
  return out;
}

const smoothstep = (u) => u * u * (3 - 2 * u);

/**
 * Timeline of {t, landmarks} that holds each named pose, then moves to the next.
 * Small idle motion during holds keeps it alive without breaking "low motion".
 */
export function makeSequenceTimeline(names, { holdSeconds = 1.6, moveSeconds = 0.7, stepSeconds = 1 / 12, aspect = 1, idleDegrees = 0 } = {}) {
  const segment = holdSeconds + moveSeconds;
  const duration = names.length * segment;
  const timeline = [];
  for (let t = 0; t < duration - 1e-9; t += stepSeconds) {
    const index = Math.min(names.length - 1, Math.floor(t / segment));
    const within = t - index * segment;
    const current = POSES[names[index]];
    const next = POSES[names[Math.min(names.length - 1, index + 1)]];
    let spec = within < holdSeconds ? current : blendSpecs(current, next, smoothstep((within - holdSeconds) / moveSeconds));
    if (idleDegrees) spec = { ...spec, leftForearm: spec.leftForearm + idleDegrees * Math.sin(t * 5), rightForearm: spec.rightForearm - idleDegrees * Math.sin(t * 5) };
    timeline.push({ t: Math.round(t * 1000) / 1000, landmarks: makeStickPose(spec, { aspect }) });
  }
  return timeline;
}

export function sampleAt(timeline, t) {
  if (timeline.length === 0) return null;
  let lo = 0, hi = timeline.length - 1;
  if (t <= timeline[0].t) return timeline[0];
  if (t >= timeline[hi].t) return timeline[hi];
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (timeline[mid].t <= t) lo = mid; else hi = mid; }
  return t - timeline[lo].t < timeline[hi].t - t ? timeline[lo] : timeline[hi];
}

function rotateAround(point, pivot, degrees, aspect) {
  const r = (degrees * Math.PI) / 180;
  const dx = (point.x - pivot.x) * aspect, dy = point.y - pivot.y;
  return { ...point, x: pivot.x + (dx * Math.cos(r) - dy * Math.sin(r)) / aspect, y: pivot.y + dx * Math.sin(r) + dy * Math.cos(r) };
}

const LIMB_CHAINS = [
  [L.leftShoulder, L.leftElbow, L.leftWrist],
  [L.rightShoulder, L.rightElbow, L.rightWrist],
  [L.leftHip, L.leftKnee, L.leftAnkle],
  [L.rightHip, L.rightKnee, L.rightAnkle],
];

/**
 * Rotate each limb chain by smooth pseudo random angles that drift with time,
 * so a "noisy" performer wobbles instead of jittering frame to frame.
 */
export function perturbPose(pose, noiseDegrees, t, aspect = 1, seed = 1) {
  if (!noiseDegrees) return pose;
  const out = pose.map((lm) => ({ ...lm }));
  LIMB_CHAINS.forEach(([root, middle, end], chainIndex) => {
    const phase = seed * 1.7 + chainIndex * 2.3;
    const upper = noiseDegrees * Math.sin(t * 1.3 + phase);
    const lower = noiseDegrees * 0.8 * Math.sin(t * 1.9 + phase * 1.5);
    out[middle] = rotateAround(out[middle], out[root], upper, aspect);
    out[end] = rotateAround(out[end], out[root], upper, aspect);
    out[end] = rotateAround(out[end], out[middle], lower, aspect);
  });
  return out;
}

/**
 * The simulated player at clip time t: the reference pose from lagSeconds ago,
 * wobbled by noise, then mirrored because a real player is a mirror image.
 */
export function simulatedPlayerPose(timeline, t, { lagSeconds = 0.15, noiseDegrees = 0, aspect = 1 } = {}) {
  const sample = sampleAt(timeline, t - lagSeconds);
  if (!sample) return null;
  return mirrorPose(perturbPose(sample.landmarks, noiseDegrees, t, aspect));
}
