// Link lab, step 0: proves tab capture gives readable frames of an embedded YouTube player and
// that the pose tracker finds the person in them. Nothing is saved.

import type { LandmarkObject } from "../../engine/src/index.ts";
import { canCaptureTab, canCropToElement, captureTab, drawTabFrame, NO_TAB_CAPTURE, type TabCapture } from "./clipside/capture.ts";
import { createPeopleDetector, type PeopleDetector } from "./clipside/detect.ts";
import { createPlayer, type YtPlayer } from "./clipside/youtube.ts";
import { drawFrame, fitCanvas } from "./draw.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const linkInput = $<HTMLInputElement>("link");
const loadButton = $<HTMLButtonElement>("load");
const grabButton = $<HTMLButtonElement>("grab");
const stopButton = $<HTMLButtonElement>("stop");
const status = $("status");
const preview = $<HTMLCanvasElement>("preview");
const facts = $<HTMLTableElement>("facts");
const playerBox = $("player-box");

let player: YtPlayer | null = null;
let capture: TabCapture | null = null;
let detector: PeopleDetector | null = null;

const stats = { frames: 0, withPerson: 0, black: 0, lastDetectMs: 0, size: "", cropped: "", brightness: 0, playerSeconds: 0, ageMs: 0 };

function showFacts() {
  const rows: [string, string][] = [
    ["Tab capture in this browser", canCaptureTab() ? "yes" : "no"],
    ["Region Capture (crop to player)", canCropToElement() ? "yes" : "no"],
    ["Cropped", stats.cropped || "not started"],
    ["Captured frame size", stats.size || "none yet"],
    ["Frames analysed", String(stats.frames)],
    ["Frames with a person", String(stats.withPerson)],
    ["Black frames", String(stats.black)],
    ["Brightness of last frame (0 to 255)", String(Math.round(stats.brightness))],
    ["Tracker ms per frame", String(Math.round(stats.lastDetectMs))],
    ["Frame age ms", String(Math.round(stats.ageMs))],
    ["Player time (s)", stats.playerSeconds.toFixed(2)],
  ];
  facts.replaceChildren(...rows.map(([name, value]) => {
    const tr = document.createElement("tr");
    for (const text of [name, value]) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }
    return tr;
  }));
}

function videoIdOf(text: string): string | null {
  const match = text.trim().match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{11})/) ?? text.trim().match(/^([A-Za-z0-9_-]{11})$/);
  return match?.[1] ?? null;
}

const tiny = document.createElement("canvas");
function brightnessOf(canvas: HTMLCanvasElement): number {
  tiny.width = 32;
  tiny.height = 18;
  const ctx = tiny.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(canvas, 0, 0, 32, 18);
  const data = ctx.getImageData(0, 0, 32, 18).data;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
  return sum / (data.length / 4);
}

async function load() {
  const id = videoIdOf(linkInput.value);
  if (!id) {
    status.textContent = "That does not look like a YouTube link.";
    return;
  }
  status.textContent = "Loading the player...";
  const result = await createPlayer(playerBox, id, 0, {
    onError: (sentence, code) => { status.textContent = `${sentence} (code ${code})`; },
  });
  if (result.error !== null) {
    status.textContent = result.error;
    return;
  }
  player = result.data;
  player.mute();
  status.textContent = "Press play on the video, then press Grab this tab.";
}

const work = document.createElement("canvas");

async function grab() {
  if (capture) return;
  if (!canCaptureTab()) {
    status.textContent = NO_TAB_CAPTURE;
    return;
  }
  // The picker must open inside the click, so the tracker loads after.
  const result = await captureTab("this", playerBox);
  if (result.error !== null) {
    status.textContent = result.error;
    return;
  }
  capture = result.data;
  stats.cropped = capture.cropped ? "yes" : "no (whole tab)";
  stopButton.disabled = false;
  grabButton.disabled = true;
  capture.onEnded(() => {
    capture = null;
    stopButton.disabled = true;
    grabButton.disabled = false;
    status.textContent = `Stopped. ${stats.withPerson} of ${stats.frames} frames had a person; ${stats.black} were black.`;
    showFacts();
  });
  status.textContent = "Loading the pose tracker...";
  if (!detector) {
    const made = await createPeopleDetector();
    if (made.error !== null) {
      status.textContent = made.error;
      capture.stop();
      return;
    }
    detector = made.data;
  }
  status.textContent = "Reading frames. Watch for the skeleton below.";
  const active = capture;
  void active.read(1000 / 15, ({ frame, arrivedAt, ageMs }) => {
    if (!detector) return;
    drawTabFrame(frame, work, 720);
    stats.size = `${frame.displayWidth} x ${frame.displayHeight}`;
    stats.brightness = brightnessOf(work);
    if (stats.brightness < 4) stats.black++;
    const began = performance.now();
    const people = detector.detect(work, arrivedAt - ageMs);
    stats.lastDetectMs = performance.now() - began;
    stats.ageMs = ageMs;
    stats.frames++;
    if (people.length) stats.withPerson++;
    stats.playerSeconds = player?.getCurrentTime() ?? 0;
    fitCanvas(preview, work.width / work.height);
    const first = people[0];
    const pose: LandmarkObject[] | null = first ? first.landmarks.map(([x, y, visibility]) => ({ x, y, z: 0, visibility })) : null;
    drawFrame(preview, work, pose);
    const ctx = preview.getContext("2d")!;
    ctx.fillStyle = "#f5c542";
    ctx.font = "bold 20px system-ui, sans-serif";
    ctx.fillText(`${people.length} ${people.length === 1 ? "person" : "people"}`, 10, 26);
    if (stats.frames % 5 === 0) showFacts();
  }).catch((error: unknown) => {
    status.textContent = `Reading frames stopped: ${(error as Error).message}`;
    active.stop();
  });
}

loadButton.addEventListener("click", () => void load());
grabButton.addEventListener("click", () => void grab());
stopButton.addEventListener("click", () => capture?.stop());
if (!canCaptureTab()) status.textContent = NO_TAB_CAPTURE;
showFacts();
void load();
