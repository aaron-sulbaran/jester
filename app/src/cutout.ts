// Cutouts of the player and the overlay replay.
//
// During a round, each camera frame gives a small crop around the body part that plays the object (or the
// whole body), with the background removed by the tracker's person mask and flipped to the mirror view the
// player saw. After the round, the replay draws the clip again and puts the player's cutout where the object
// was, shifted by the player's measured lag so it lands on the object instead of trailing it. The replay is
// recorded in the browser as a video file; nothing is uploaded. Blind mode's reveal reuses this.

import type { BodyPart, LandmarkObject } from "../../engine/src/index.ts";

/** A binary person mask, as Lisa's tracker gives it: 0/1 per cell over the whole camera image. */
export interface PersonMask { width: number; height: number; data: Uint8Array }

export interface Cutout {
  /** Clip time when this frame was captured. */
  clipMs: number;
  image: HTMLCanvasElement;
}

const SIDE = 160; // pixels of the stored square crop

type P = { x: number; y: number };
const pt = (l: LandmarkObject | undefined, aspect: number): P | null => (l && (l.visibility ?? 1) >= 0.5 ? { x: l.x * aspect, y: l.y } : null);
const mid = (ps: (P | null)[]): P | null => { const ok = ps.filter((p): p is P => !!p); return ok.length ? { x: ok.reduce((s, p) => s + p.x, 0) / ok.length, y: ok.reduce((s, p) => s + p.y, 0) / ok.length } : null; };
const dist = (a: P | null, b: P | null) => (a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0);

/** The square region (center and side, in image-height units with x scaled by aspect) around the part. */
export function partRegion(lms: readonly LandmarkObject[], part: BodyPart, aspect: number): { cx: number; cy: number; side: number } | null {
  const p = (i: number) => pt(lms[i], aspect);
  const shoulderW = dist(p(11), p(12));
  let c: P | null, side: number;
  switch (part) {
    case "rightHand": c = mid([p(16), p(18), p(20)]); side = Math.max(2.2 * dist(p(14), p(16)), 0.6 * shoulderW); break;
    case "leftHand": c = mid([p(15), p(17), p(19)]); side = Math.max(2.2 * dist(p(13), p(15)), 0.6 * shoulderW); break;
    case "head": c = mid([p(0), p(7), p(8)]); side = Math.max(1.3 * shoulderW, 3 * dist(p(7), p(8))); break;
    case "rightFoot": c = mid([p(28), p(30), p(32)]); side = Math.max(1.4 * dist(p(26), p(28)), 0.5 * shoulderW); break;
    case "leftFoot": c = mid([p(27), p(29), p(31)]); side = Math.max(1.4 * dist(p(25), p(27)), 0.5 * shoulderW); break;
    default: {
      const vis = lms.map((_, i) => p(i)).filter((q): q is P => !!q);
      if (vis.length < 5) return null;
      const xs = vis.map((q) => q.x), ys = vis.map((q) => q.y);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      c = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
      side = 1.25 * Math.max(x1 - x0, y1 - y0);
    }
  }
  if (!c || !(side > 0.02)) return null;
  return { cx: c.x, cy: c.y, side };
}

/**
 * Crop one frame. `source` is the camera image (or null for the simulated player, which is drawn as a
 * stick figure instead). Returns a square canvas, mirrored, with the background transparent where the
 * person mask says there is no person.
 */
export function cutFrame(
  source: CanvasImageSource | null, sourceW: number, sourceH: number,
  lms: readonly LandmarkObject[], part: BodyPart, mask: PersonMask | null,
): HTMLCanvasElement | null {
  const aspect = sourceW / sourceH;
  const r = partRegion(lms, part, aspect);
  if (!r) return null;
  const out = document.createElement("canvas");
  out.width = out.height = SIDE;
  const ctx = out.getContext("2d")!;
  // Mirror, so the cutout moves the way the player saw themself move.
  ctx.translate(SIDE, 0); ctx.scale(-1, 1);
  const px = (v: number) => (v / aspect) * sourceW, py = (v: number) => v * sourceH; // region units to source pixels
  const sx = px(r.cx - r.side / 2), sy = py(r.cy - r.side / 2), sw = px(r.side), sh = py(r.side);
  if (source) {
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, SIDE, SIDE);
    if (mask) {
      const img = ctx.getImageData(0, 0, SIDE, SIDE);
      for (let y = 0; y < SIDE; y++) {
        for (let x = 0; x < SIDE; x++) {
          // Output pixel (x, y) is mirrored: it came from source column sx + (SIDE - 1 - x) / SIDE * sw.
          const nx = (sx + ((SIDE - 1 - x) / SIDE) * sw) / sourceW, ny = (sy + (y / SIDE) * sh) / sourceH;
          const mx = Math.floor(nx * mask.width), my = Math.floor(ny * mask.height);
          const on = mx >= 0 && my >= 0 && mx < mask.width && my < mask.height && mask.data[my * mask.width + mx];
          if (!on) img.data[(y * SIDE + x) * 4 + 3] = 0;
        }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.putImageData(img, 0, 0);
    }
  } else {
    // Simulated player: draw its stick figure inside the region.
    ctx.strokeStyle = "#6fd3ff"; ctx.lineWidth = 6; ctx.lineCap = "round";
    const to = (l: LandmarkObject) => [((l.x * aspect - (r.cx - r.side / 2)) / r.side) * SIDE, ((l.y - (r.cy - r.side / 2)) / r.side) * SIDE] as const;
    for (const [a, b] of [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [15, 19], [16, 20], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [27, 31], [28, 32]]) {
      const la = lms[a!], lb = lms[b!];
      if (!la || !lb) continue;
      const [x0, y0] = to(la), [x1, y1] = to(lb);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
    const [hx, hy] = to(lms[0]!);
    ctx.beginPath(); ctx.arc(hx, hy, SIDE * 0.08, 0, Math.PI * 2); ctx.stroke();
  }
  return out;
}

export interface Box { cx: number; cy: number; w: number; h: number }

export interface RevealOptions {
  canvas: HTMLCanvasElement;
  durationMs: number;
  /** The player's measured lag: their move at clip time t happened at t + lagMs. */
  lagMs: number;
  cutouts: readonly Cutout[];
  /** Draw the clip at time ms (the original video frame, or a drawn scene), without the object. */
  drawBackground: (ctx: CanvasRenderingContext2D, ms: number) => void;
  /** Where the object is at time ms, normalized like the clip. */
  boxAt: (ms: number) => Box | null;
  onProgress?: (share: number) => void;
}

/** The cutout captured nearest to clip time `ms`, if one is within 150 ms. */
function nearest(cutouts: readonly Cutout[], ms: number): Cutout | null {
  let lo = 0, hi = cutouts.length - 1;
  if (hi < 0) return null;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cutouts[m]!.clipMs <= ms) lo = m; else hi = m; }
  const best = Math.abs(cutouts[lo]!.clipMs - ms) <= Math.abs(cutouts[hi]!.clipMs - ms) ? cutouts[lo]! : cutouts[hi]!;
  return Math.abs(best.clipMs - ms) <= 150 ? best : null;
}

/** Play the overlay once on the canvas while recording it. Resolves with a video URL (or null if recording is unsupported). */
export function recordReveal(o: RevealOptions): Promise<string | null> {
  const { canvas, durationMs } = o;
  const ctx = canvas.getContext("2d")!;
  const W = canvas.width, H = canvas.height;
  const draw = (ms: number) => {
    o.drawBackground(ctx, ms);
    const b = o.boxAt(ms);
    const c = nearest(o.cutouts, ms + Math.max(0, o.lagMs));
    if (!b || !c) return;
    // Size the cutout to the object's box (at least a sixth of the frame so a small ball still shows a hand).
    const side = Math.max(b.w * W, b.h * H, H / 6) * 1.4;
    ctx.save();
    ctx.shadowColor = "#f5c542"; ctx.shadowBlur = 12;
    ctx.drawImage(c.image, b.cx * W - side / 2, b.cy * H - side / 2, side, side);
    ctx.restore();
  };
  const stream = typeof canvas.captureStream === "function" ? canvas.captureStream(30) : null;
  const type = ["video/webm;codecs=vp9", "video/webm", "video/mp4"].find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t));
  const recorder = stream && type ? new MediaRecorder(stream, { mimeType: type }) : null;
  const chunks: Blob[] = [];
  return new Promise((resolve) => {
    if (recorder) {
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      recorder.onstop = () => resolve(chunks.length ? URL.createObjectURL(new Blob(chunks, { type })) : null);
      recorder.start(250);
    }
    const started = performance.now();
    // A timer, not requestAnimationFrame, so the replay still records in a background tab.
    const timer = window.setInterval(() => {
      const ms = performance.now() - started;
      draw(Math.min(ms, durationMs));
      o.onProgress?.(Math.min(1, ms / durationMs));
      if (ms >= durationMs) {
        clearInterval(timer);
        if (recorder) recorder.stop(); else resolve(null);
      }
    }, 1000 / 30);
  });
}
