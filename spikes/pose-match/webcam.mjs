// Webcam extraction: smoothed pose, person mask and outline for one player.
// Pure helpers (no DOM) are exported for tests; createWebcamTracker needs a browser.
//
// Output frame (what the accuracy engine consumes):
//   { t, landmarks, aspect, mirrored: false, mask, outline }
//   landmarks: 33 MediaPipe landmarks {x, y, z, visibility}, normalized image coords,
//              NOT mirrored (comparePoses in score.mjs does the mirroring), or null.
//   mask:      { width, height, data: Uint8Array of 0/1 } or null
//   outline:   array of [x, y] in 0..1 image coords (closed polygon, no repeat of first point) or null
//   t:         ms from tracker start, strictly increasing

// ---- One Euro Filter (Casiez et al.) ----
export const FILTER_DEFAULTS = { minCutoff: 1.0, beta: 0.02, dCutoff: 1.0 };
const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff) / dt);

export class OneEuroFilter {
  constructor({ minCutoff, beta, dCutoff } = {}) {
    Object.assign(this, FILTER_DEFAULTS, stripUndefined({ minCutoff, beta, dCutoff }));
    this.x = null; this.dx = 0; this.t = null;
  }
  filter(value, tMs) {
    if (this.x === null) { this.x = value; this.t = tMs; return value; }
    const dt = Math.max((tMs - this.t) / 1000, 1e-3);
    const rawDx = (value - this.x) / dt;
    const aD = alpha(this.dCutoff, dt);
    this.dx = aD * rawDx + (1 - aD) * this.dx;
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    const a = alpha(cutoff, dt);
    this.x = a * value + (1 - a) * this.x;
    this.t = tMs;
    return this.x;
  }
}
function stripUndefined(o) { return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)); }

// Smooths x and y of every landmark. A low-visibility landmark keeps its last smoothed value
// for up to HOLD_MS, then passes through raw so the scorer can see it is unreliable.
export const HOLD_MS = 150;
export const LOW_VISIBILITY = 0.5;

export class PoseSmoother {
  constructor(options = {}) {
    this.options = options;
    this.filters = null;
    this.lastGood = null;
  }
  reset() { this.filters = null; this.lastGood = null; }
  smooth(landmarks, tMs) {
    if (!landmarks) return null;
    if (!this.filters) {
      this.filters = landmarks.map(() => ({ x: new OneEuroFilter(this.options), y: new OneEuroFilter(this.options) }));
      this.lastGood = landmarks.map(() => null);
    }
    return landmarks.map((lm, i) => {
      const visibility = lm.visibility ?? 1;
      if (visibility >= LOW_VISIBILITY) {
        const out = { ...lm, x: this.filters[i].x.filter(lm.x, tMs), y: this.filters[i].y.filter(lm.y, tMs) };
        this.lastGood[i] = { x: out.x, y: out.y, t: tMs };
        return out;
      }
      const good = this.lastGood[i];
      if (good && tMs - good.t <= HOLD_MS) return { ...lm, x: good.x, y: good.y };
      return { ...lm };
    });
  }
}

// ---- Mask and outline ----
// Turn a float confidence mask (0..1) into a binary Uint8Array of 0/1.
export function binarizeMask(values, width, height, threshold = 0.5) {
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = values[i] >= threshold ? 1 : 0;
  return { width, height, data };
}

// Shrink a binary mask by an integer factor (any covered cell wins). Keeps outlines cheap.
export function downsampleMask(mask, factor) {
  if (factor <= 1) return mask;
  const width = Math.ceil(mask.width / factor), height = Math.ceil(mask.height / factor);
  const data = new Uint8Array(width * height);
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if (mask.data[y * mask.width + x]) data[Math.floor(y / factor) * width + Math.floor(x / factor)] = 1;
    }
  }
  return { width, height, data };
}

// Intersection over union of two binary masks of the same size: 1 = identical shape, 0 = no overlap.
export function maskIoU(a, b) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return 0;
  let inter = 0, union = 0;
  for (let i = 0; i < a.data.length; i++) {
    const x = a.data[i], y = b.data[i];
    if (x && y) inter++;
    if (x || y) union++;
  }
  return union === 0 ? 0 : inter / union;
}

// Boundary of the first (topmost, then leftmost) blob, by Moore neighbour tracing.
// Returns [x, y] in 0..1 image coordinates (pixel centres), or null if the mask is empty.
export function extractOutline(mask, maxPoints = 120) {
  if (!mask) return null;
  const { width: w, height: h, data } = mask;
  const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h ? data[y * w + x] : 0);
  let sx = -1, sy = -1;
  for (let y = 0; y < h && sy < 0; y++) for (let x = 0; x < w; x++) if (at(x, y)) { sx = x; sy = y; break; }
  if (sy < 0) return null;
  // 8 neighbours clockwise starting west.
  const dirs = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];
  const path = [[sx, sy]];
  let cx = sx, cy = sy, back = 0; // we entered the start from the west (empty)
  const limit = w * h * 4;
  for (let guard = 0; guard < limit; guard++) {
    let moved = false;
    for (let k = 1; k <= 8; k++) {
      const d = (back + k) % 8;
      const nx = cx + dirs[d][0], ny = cy + dirs[d][1];
      if (at(nx, ny)) {
        back = (d + 4) % 8; // next scan starts just after the cell we came from
        cx = nx; cy = ny; moved = true;
        break;
      }
    }
    if (!moved) break; // single pixel
    if (cx === sx && cy === sy) break;
    path.push([cx, cy]);
  }
  const stride = Math.max(1, Math.ceil(path.length / maxPoints));
  const points = [];
  for (let i = 0; i < path.length; i += stride) points.push([(path[i][0] + 0.5) / w, (path[i][1] + 0.5) / h]);
  return points;
}

// ---- Frame building ----
export function buildFrame({ t, landmarks, aspect, maskValues, maskWidth, maskHeight, outlineScale = 4 }) {
  let mask = null, outline = null;
  if (maskValues) {
    mask = binarizeMask(maskValues, maskWidth, maskHeight);
    outline = extractOutline(downsampleMask(mask, outlineScale));
  }
  return { t, landmarks: landmarks || null, aspect, mirrored: false, mask, outline };
}

// ---- Browser tracker ----
export const MP_BUNDLE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
export const MP_WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
export const MODEL_URLS = {
  heavy: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task",
  full: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
  lite: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
};

// Own landmarker (mask always on), so clip analysis elsewhere stays untouched.
// Single player: numPoses is 1. Downgrades full to lite when fps stays under minFps.
export async function createWebcamTracker({ video, onFrame, model = new URLSearchParams(globalThis.location?.search ?? "").get("model") || "full", minFps = 18, filter } = {}) {
  const mp = await import(MP_BUNDLE);
  const vision = await mp.FilesetResolver.forVisionTasks(MP_WASM);
  const make = async (name, delegate) => mp.PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL_URLS[name], delegate },
    runningMode: "VIDEO", numPoses: 1, outputSegmentationMasks: true,
  });
  let delegate = "GPU", modelName = model, landmarker;
  try { landmarker = await make(modelName, "GPU"); } catch { delegate = "CPU"; landmarker = await make(modelName, "CPU"); }

  const smoother = new PoseSmoother(filter);
  const stats = { fps: 0, model: modelName, delegate };
  let running = false, busy = false, last = -1, startPerf = 0, lastTs = 0, frames = 0, windowStart = 0, slowWindows = 0;

  function tick() {
    if (!running) return;
    requestAnimationFrame(tick);
    if (busy || video.readyState < 2 || video.currentTime === last) return;
    busy = true; last = video.currentTime;
    const ts = Math.max(lastTs + 1, performance.now());
    lastTs = ts;
    try {
      const result = landmarker.detectForVideo(video, ts);
      const t = ts - startPerf;
      const first = result.landmarks && result.landmarks[0];
      const raw = first ? first.map((l) => ({ x: l.x, y: l.y, z: l.z, visibility: l.visibility ?? 1 })) : null;
      let maskValues = null, mw = 0, mh = 0;
      const m = result.segmentationMasks && result.segmentationMasks[0];
      if (m) { maskValues = m.getAsFloat32Array(); mw = m.width; mh = m.height; }
      const aspect = video.videoWidth / video.videoHeight || 4 / 3;
      if (!raw) smoother.reset();
      onFrame(buildFrame({ t, landmarks: smoother.smooth(raw, t), aspect, maskValues, maskWidth: mw, maskHeight: mh }));
      if (m) m.close();
    } finally { busy = false; }
    frames++;
    const now = performance.now();
    if (now - windowStart >= 1000) {
      stats.fps = (frames * 1000) / (now - windowStart); frames = 0; windowStart = now;
      slowWindows = stats.fps < minFps ? slowWindows + 1 : 0;
      if (slowWindows >= 3 && modelName !== "lite") {
        const next = modelName === "heavy" ? "full" : "lite";
        slowWindows = 0; modelName = next; stats.model = next;
        make(next, delegate).then((next) => { const old = landmarker; landmarker = next; old.close(); }).catch(() => {});
      }
    }
  }

  return {
    stats,
    start() { if (running) return; running = true; startPerf = performance.now(); windowStart = startPerf; smoother.reset(); requestAnimationFrame(tick); },
    stop() { running = false; },
  };
}
