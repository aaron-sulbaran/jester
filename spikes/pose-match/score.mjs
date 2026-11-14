// Pose similarity scoring. Pure functions: no DOM, no MediaPipe.
// Poses are arrays of 33 MediaPipe landmarks {x, y, z, visibility} in normalized
// image coordinates (x by image width, y by image height, y grows downward).

// ---- Tunable constants ----
export const RATING_THRESHOLDS = { Perfect: 0.98, Great: 0.95, OK: 0.88 };
export const RATING_POINTS = { Perfect: 100, Great: 80, OK: 50, Miss: 0 };
export const MIN_LIMB_VISIBILITY = 0.5;
export const MIN_USED_LIMBS = 4;
// Feedback: vertical difference of unit directions beyond this reads as "low" or "high".
export const VERTICAL_FEEDBACK_MARGIN = 0.25;

export const LANDMARK = {
  nose: 0,
  leftShoulder: 11, rightShoulder: 12,
  leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16,
  leftHip: 23, rightHip: 24,
  leftKnee: 25, rightKnee: 26,
  leftAnkle: 27, rightAnkle: 28,
};

// Each limb is a direction from one point to another. A point is a landmark index
// or a list of indices whose midpoint is used.
const L = LANDMARK;
export const LIMBS = {
  leftUpperArm: [L.leftShoulder, L.leftElbow],
  leftForearm: [L.leftElbow, L.leftWrist],
  rightUpperArm: [L.rightShoulder, L.rightElbow],
  rightForearm: [L.rightElbow, L.rightWrist],
  leftThigh: [L.leftHip, L.leftKnee],
  leftShin: [L.leftKnee, L.leftAnkle],
  rightThigh: [L.rightHip, L.rightKnee],
  rightShin: [L.rightKnee, L.rightAnkle],
  shoulderLine: [L.leftShoulder, L.rightShoulder],
  hipLine: [L.leftHip, L.rightHip],
  torso: [[L.leftHip, L.rightHip], [L.leftShoulder, L.rightShoulder]],
};

export const LIMB_LABELS = {
  leftUpperArm: "left upper arm", leftForearm: "left forearm",
  rightUpperArm: "right upper arm", rightForearm: "right forearm",
  leftThigh: "left thigh", leftShin: "left shin",
  rightThigh: "right thigh", rightShin: "right shin",
  shoulderLine: "shoulder line", hipLine: "hip line", torso: "torso",
};

// Left and right landmark pairs, used to relabel a horizontally flipped pose.
const MIRROR_PAIRS = [
  [1, 4], [2, 5], [3, 6], [7, 8], [9, 10],
  [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22],
  [23, 24], [25, 26], [27, 28], [29, 30], [31, 32],
];
const MIRROR_INDEX = (() => {
  const map = Array.from({ length: 33 }, (_, i) => i);
  for (const [a, b] of MIRROR_PAIRS) { map[a] = b; map[b] = a; }
  return map;
})();

// Horizontal flip: x becomes 1 - x, and left and right landmarks swap labels,
// so the result is the pose as it would look in a mirror.
export function mirrorPose(pose) {
  return pose.map((_, i) => {
    const source = pose[MIRROR_INDEX[i]];
    return { ...source, x: 1 - source.x };
  });
}

function pointOf(pose, spec, aspect) {
  const indices = Array.isArray(spec) ? spec : [spec];
  let x = 0, y = 0, visibility = 1;
  for (const i of indices) {
    const lm = pose[i];
    x += lm.x; y += lm.y;
    visibility = Math.min(visibility, lm.visibility ?? 1);
  }
  // Multiply x by width / height so both axes are in "image height" units.
  return { x: (x / indices.length) * aspect, y: y / indices.length, visibility };
}

// Unit direction of a limb in image-height units, plus its visibility
// (the lower of its two endpoints). Returns null for a zero-length limb.
export function limbDirection(pose, limbName, aspect = 1) {
  const [fromSpec, toSpec] = LIMBS[limbName];
  const from = pointOf(pose, fromSpec, aspect);
  const to = pointOf(pose, toSpec, aspect);
  const dx = to.x - from.x, dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return null;
  return { x: dx / length, y: dy / length, visibility: Math.min(from.visibility, to.visibility) };
}

/**
 * Compare a reference pose with a player pose.
 * options.mirror (default true): flip the player pose first, because the player
 *   faces the screen like a mirror.
 * options.referenceAspect, options.playerAspect: width / height of each source.
 * Returns {score: 0..1 or null, perLimb: {name: {similarity, weight, verticalDelta}}, usedLimbs}.
 */
export function comparePoses(referencePose, playerPose, options = {}) {
  const { mirror = true, referenceAspect = 1, playerAspect = 1 } = options;
  if (!referencePose || !playerPose) return { score: null, perLimb: {}, usedLimbs: 0 };
  const player = mirror ? mirrorPose(playerPose) : playerPose;
  const perLimb = {};
  let weightedSum = 0, weightTotal = 0, usedLimbs = 0;
  for (const limbName of Object.keys(LIMBS)) {
    const refDir = limbDirection(referencePose, limbName, referenceAspect);
    const playerDir = limbDirection(player, limbName, playerAspect);
    if (!refDir || !playerDir) continue;
    const weight = Math.min(refDir.visibility, playerDir.visibility);
    if (weight < MIN_LIMB_VISIBILITY) continue;
    const cosine = refDir.x * playerDir.x + refDir.y * playerDir.y;
    const similarity = (cosine + 1) / 2;
    perLimb[limbName] = { similarity, weight, verticalDelta: playerDir.y - refDir.y };
    weightedSum += similarity * weight;
    weightTotal += weight;
    usedLimbs++;
  }
  if (usedLimbs < MIN_USED_LIMBS) return { score: null, perLimb, usedLimbs };
  return { score: weightedSum / weightTotal, perLimb, usedLimbs };
}

export function rate(score) {
  if (score == null) return "Miss";
  if (score >= RATING_THRESHOLDS.Perfect) return "Perfect";
  if (score >= RATING_THRESHOLDS.Great) return "Great";
  if (score >= RATING_THRESHOLDS.OK) return "OK";
  return "Miss";
}

// Name of the limb with the lowest similarity in one comparison result.
export function weakestLimb(result) {
  let worstName = null, worstSimilarity = Infinity;
  for (const [name, limb] of Object.entries(result.perLimb)) {
    if (limb.similarity < worstSimilarity) { worstSimilarity = limb.similarity; worstName = name; }
  }
  return worstName;
}

// Round total out of 100: average rating points over all key moments.
export function totalScore(ratings) {
  if (ratings.length === 0) return 0;
  const points = ratings.reduce((sum, r) => sum + RATING_POINTS[r], 0);
  return Math.round(points / ratings.length);
}

// One line of feedback from several comparison results (one per key moment):
// finds the limb with the lowest average similarity and whether it was low or high.
export function feedbackLine(results) {
  const totals = {};
  for (const result of results) {
    if (!result) continue;
    for (const [name, limb] of Object.entries(result.perLimb)) {
      const t = (totals[name] ||= { similarity: 0, verticalDelta: 0, count: 0 });
      t.similarity += limb.similarity; t.verticalDelta += limb.verticalDelta; t.count++;
    }
  }
  let worstName = null, worst = null;
  for (const [name, t] of Object.entries(totals)) {
    const mean = t.similarity / t.count;
    if (!worst || mean < worst.mean) { worstName = name; worst = { mean, verticalDelta: t.verticalDelta / t.count }; }
  }
  if (!worstName) return "No body was tracked, so there is no feedback yet.";
  const label = LIMB_LABELS[worstName];
  if (worst.mean >= RATING_THRESHOLDS.Perfect) return "Clean round; even your weakest part, the " + label + ", was on point.";
  if (worst.verticalDelta > VERTICAL_FEEDBACK_MARGIN) return "Your " + label + " was low.";
  if (worst.verticalDelta < -VERTICAL_FEEDBACK_MARGIN) return "Your " + label + " was high.";
  return "Your " + label + " was at the wrong angle.";
}
