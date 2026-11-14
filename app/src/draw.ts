// Plain canvas drawing for Version 1. Aaron's look replaces this.

import type { LandmarkObject } from "../../engine/src/index.ts";

const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];

/** Fit the canvas to the source aspect, keeping its width. */
export function fitCanvas(canvas: HTMLCanvasElement, aspect: number) {
  const h = Math.round(canvas.width / aspect);
  if (canvas.height !== h) canvas.height = h;
}

export function drawFrame(
  canvas: HTMLCanvasElement,
  source: CanvasImageSource | null,
  pose: readonly LandmarkObject[] | null,
  { mirror = false, color = "#f5c542" } = {},
) {
  const ctx = canvas.getContext("2d")!;
  const { width: w, height: h } = canvas;
  ctx.save();
  if (mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  if (source) ctx.drawImage(source, 0, 0, w, h);
  if (pose) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    for (const [a, b] of BONES) {
      const p = pose[a], q = pose[b];
      if (!p || !q || (p.visibility ?? 1) < 0.5 || (q.visibility ?? 1) < 0.5) continue;
      ctx.beginPath();
      ctx.moveTo(p.x * w, p.y * h);
      ctx.lineTo(q.x * w, q.y * h);
      ctx.stroke();
    }
    const nose = pose[0];
    if (nose && (nose.visibility ?? 1) >= 0.5) {
      ctx.beginPath();
      ctx.arc(nose.x * w, nose.y * h, h * 0.04, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();
}
