// Size matching: scale the reference figure to how big the player looks on screen, so it stays the same size
// whether they stand close or far. Pure functions, no DOM.
// A landmark is {x, y, visibility} (webcam) or [x, y, visibility] (clip guide), normalized to its image.

const at = (lm, i) => (Array.isArray(lm) ? lm[i] : [lm.x, lm.y, lm.visibility ?? 1][i]);
const MIN_VIS = 0.5;

function mid(landmarks, a, b) {
  const p = landmarks[a], q = landmarks[b];
  if (!p || !q || at(p, 2) < MIN_VIS || at(q, 2) < MIN_VIS) return null;
  return { x: (at(p, 0) + at(q, 0)) / 2, y: (at(p, 1) + at(q, 1)) / 2 };
}

/** Hip centre and torso length in pixels of an image `width` by `height`, or null if shoulders or hips are not visible. */
export function stance(landmarks, width, height) {
  if (!landmarks) return null;
  const hip = mid(landmarks, 23, 24), shoulder = mid(landmarks, 11, 12);
  if (!hip || !shoulder) return null;
  const dx = (shoulder.x - hip.x) * width, dy = (shoulder.y - hip.y) * height;
  return { hipX: hip.x * width, hipY: hip.y * height, torso: Math.hypot(dx, dy) };
}

/** Displayed height of a canvas picture inside a CSS box, for object-fit "contain" (default) or "cover". */
export function displayedHeight(boxW, boxH, canvasW, canvasH, fit = "contain") {
  const aspect = canvasW / canvasH;
  return fit === "cover" ? Math.max(boxH, boxW / aspect) : Math.min(boxH, boxW / aspect);
}

/** Moves a view's scale by k about the point (ax, ay), so the figure grows or shrinks in place. */
export function scaleView(view, k, ax, ay) {
  return { ...view, scale: view.scale * k, offsetX: ax - (ax - view.offsetX) * k, offsetY: ay - (ay - view.offsetY) * k };
}

/** Smooths the wanted scale over time (the player breathes and sways) and keeps it in a sane range. */
export class SizeMatcher {
  constructor({ alpha = 0.08, min = 0.4, max = 2.5 } = {}) { this.alpha = alpha; this.min = min; this.max = max; this.k = 1; }
  reset() { this.k = 1; }
  /**
   * playerPx: the player's torso length as drawn on screen. guidePx: the guide's torso length on screen at its
   * BASE scale (before any matching). Returns the scale to apply to the guide.
   */
  update(playerPx, guidePx) {
    if (!(playerPx > 0) || !(guidePx > 0)) return this.k;
    const want = Math.min(this.max, Math.max(this.min, playerPx / guidePx));
    this.k += (want - this.k) * this.alpha;
    return this.k;
  }
}
