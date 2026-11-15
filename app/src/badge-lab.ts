// Badge lab: try the arcade style face badge with your own camera. The pose tracker finds your face, the
// crop is levelled and dropped into the jester's cap and collar in every player colourway. Nothing leaves
// this device.

import { cameraPlayer, type Player } from "./round.ts";
import { cropFace, drawBadge, loadBadgeFrames, type FacePoint } from "./ui/faceBadge.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>("cam");
const status = (text: string) => { $("status").textContent = text; };

interface Latest { source: CanvasImageSource; width: number; height: number; landmarks: FacePoint[] }

const { meta, frames } = await loadBadgeFrames("look/jester/");
const slots = Object.keys(meta.variants).map((name) => {
  const figure = document.createElement("figure");
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const caption = document.createElement("figcaption");
  caption.textContent = name;
  figure.append(canvas, caption);
  $("badges").append(figure);
  return { name, canvas };
});

let latest: Latest | null = null;
let frozen: HTMLCanvasElement | null = null;
let face: HTMLCanvasElement | null = null;

function paint() {
  for (const slot of slots) {
    const badge = drawBadge(frozen ?? face, frames[slot.name]!, meta, 256);
    const ctx = slot.canvas.getContext("2d")!;
    ctx.clearRect(0, 0, 256, 256);
    ctx.drawImage(badge, 0, 0);
  }
}
paint();

let player: Player | null = null;
$("start").addEventListener("click", async () => {
  if (player) return;
  status("Starting the camera and pose tracker...");
  try {
    player = await cameraPlayer(video);
  } catch (err) {
    status("Camera did not start: " + (err as Error).message);
    return;
  }
  player.setCapture?.((f) => {
    if (f.source) latest = { source: f.source, width: f.width, height: f.height, landmarks: f.landmarks };
  });
  // The capture hook only fires while a clock is running, so give it a clock that is always at zero.
  player.start(() => {}, () => 0);
  status("Look at the camera. Your face shows up in every badge.");
  $<HTMLButtonElement>("snap").disabled = false;
  window.setInterval(() => {
    if (!latest || frozen) return;
    face = cropFace(latest.source, latest.width, latest.height, latest.landmarks, 256);
    status(face ? "Found your face." : "Turn toward the camera so your eyes and nose are in view.");
    paint();
  }, 100);
});

$("snap").addEventListener("click", () => {
  if (frozen) {
    frozen = null;
    $("snap").textContent = "Take the photo";
  } else if (face) {
    frozen = face;
    $("snap").textContent = "Retake";
  }
  paint();
});
