// Arcade style face badges: a still of a player's face inside the jester's cap and collar, like the
// photo badges on Mario Kart arcade results. The face is cropped from one camera frame using the pose
// tracker's face points (nose, eyes, ears), levelled, and drawn under a frame rendered in Blender
// (art/jester/jester.py --badge). Nothing here uploads or saves it; only an online room shares a face, live, with
// the players in that room.

/** A pose landmark in image coordinates from 0 to 1 (MediaPipe pose order: 0 nose, 2 left eye, 5 right eye, 7 left ear, 8 right ear). */
export interface FacePoint { x: number; y: number; visibility?: number }

export interface BadgeMeta {
  /** Size of the rendered frame image in pixels (square). */
  size: number;
  /** Where the face goes in the frame image, in its pixels. */
  face: { cx: number; cy: number; rx: number; ry: number };
  variants: Record<string, { file: string; colors: string[] }>;
}

const NOSE = 0, LEFT_EYE = 2, RIGHT_EYE = 5, LEFT_EAR = 7, RIGHT_EAR = 8;
const seen = (p: FacePoint | undefined, min: number): p is FacePoint => !!p && (p.visibility ?? 1) >= min;

/**
 * Crops a square, levelled picture of the face from one frame. Returns null when the face points are not
 * clear enough (turned away, out of frame). `mirror` flips it to match the mirror view players saw.
 */
export function cropFace(
  source: CanvasImageSource,
  width: number,
  height: number,
  landmarks: readonly FacePoint[],
  size = 256,
  mirror = true,
): HTMLCanvasElement | null {
  const nose = landmarks[NOSE], left = landmarks[LEFT_EYE], right = landmarks[RIGHT_EYE];
  if (!seen(nose, 0.5) || !seen(left, 0.5) || !seen(right, 0.5)) return null;
  const px = (p: FacePoint) => ({ x: p.x * width, y: p.y * height });
  const L = px(left), R = px(right), N = px(nose);
  const eyeGap = Math.hypot(L.x - R.x, L.y - R.y);
  if (eyeGap < 4) return null;
  // The subject's right eye is on the image's left in the raw camera frame, so this runs left to right.
  const angle = Math.atan2(L.y - R.y, L.x - R.x);
  const earL = landmarks[LEFT_EAR], earR = landmarks[RIGHT_EAR];
  const faceWidth = seen(earL, 0.4) && seen(earR, 0.4)
    ? Math.max(Math.hypot((earL.x - earR.x) * width, (earL.y - earR.y) * height), eyeGap * 1.8)
    : eyeGap * 2.3;
  const span = faceWidth * 1.3;
  // Centre a little below the eye line, so the eyes sit about 40 percent down and the chin fits.
  const eyes = { x: (L.x + R.x) / 2, y: (L.y + R.y) / 2 };
  const down = { x: -Math.sin(angle), y: Math.cos(angle) };
  const towardNose = Math.max(0, (N.x - eyes.x) * down.x + (N.y - eyes.y) * down.y);
  const drop = Math.max(span * 0.1, towardNose * 0.6);
  const centre = { x: eyes.x + down.x * drop, y: eyes.y + down.y * drop };

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.translate(size / 2, size / 2);
  if (mirror) ctx.scale(-1, 1);
  ctx.scale(size / span, size / span);
  ctx.rotate(-angle);
  ctx.translate(-centre.x, -centre.y);
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

/** The jester's own painted face, used when no photo could be taken. */
function drawStandInFace(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.fillStyle = "#F6D9BE";
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#1A1626";
  for (const side of [-1, 1]) {
    ctx.beginPath(); ctx.ellipse(cx + side * r * 0.34, cy + r * 0.12, r * 0.09, r * 0.14, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = "#D4243A";
  for (const side of [-1, 1]) {
    const x = cx + side * r * 0.34, y = cy + r * 0.42, d = r * 0.09;
    ctx.beginPath(); ctx.moveTo(x, y - d * 1.3); ctx.lineTo(x + d, y); ctx.lineTo(x, y + d * 1.3); ctx.lineTo(x - d, y); ctx.closePath(); ctx.fill();
  }
  ctx.strokeStyle = "#1A1626"; ctx.lineWidth = Math.max(2, r * 0.05); ctx.lineCap = "round";
  ctx.beginPath(); ctx.arc(cx, cy + r * 0.35, r * 0.28, 0.2 * Math.PI, 0.8 * Math.PI); ctx.stroke();
}

/**
 * Draws a badge: the face (or the jester's own face when `face` is null) inside the cap and collar frame.
 * Returns a square transparent canvas of `size` pixels.
 */
export function drawBadge(face: HTMLCanvasElement | null, frame: HTMLImageElement, meta: BadgeMeta, size = 256): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const k = size / meta.size;
  const { cx, cy, rx } = meta.face;
  // A touch larger than the opening, so no gap shows at the cap's brim or the collar.
  const r = rx * k * 1.04;
  if (face) {
    ctx.save();
    ctx.beginPath(); ctx.arc(cx * k, cy * k, r, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(face, cx * k - r, cy * k - r, r * 2, r * 2);
    ctx.restore();
  } else {
    drawStandInFace(ctx, cx * k, cy * k, r);
  }
  ctx.drawImage(frame, 0, 0, size, size);
  return canvas;
}

/** Loads the badge metadata and every frame image from `base` (for example "look/jester/"). */
export async function loadBadgeFrames(base: string): Promise<{ meta: BadgeMeta; frames: Record<string, HTMLImageElement> }> {
  const meta = (await (await fetch(base + "badge.json")).json()) as BadgeMeta;
  const entries = await Promise.all(Object.entries(meta.variants).map(async ([name, v]) => {
    const img = new Image();
    img.src = base + v.file;
    await img.decode();
    return [name, img] as const;
  }));
  return { meta, frames: Object.fromEntries(entries) };
}
