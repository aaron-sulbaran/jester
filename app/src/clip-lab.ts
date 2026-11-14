// Clip lab: run the clip side on one video and check the result by eye.
// URL options: ?clip=<file in /_clips/> runs that file as if picked, ?pick=<number> chooses that
// person, ?fresh=1 ignores the saved analysis. After each run, window.__clipLab holds a summary.

import type { Box, Guide } from "../../clip/src/index.ts";
import type { LandmarkObject } from "../../engine/src/index.ts";
import { finishClip, prepareClip, type Prepared } from "./clipside/analyze.ts";
import { drawFrame, fitCanvas } from "./draw.ts";

interface LabSummary {
  file: string;
  decoder: Prepared["decoder"] | null;
  frames: number;
  candidates: { number: number; trackId: number; label: string; score: number }[];
  cuts: number[];
  seconds: number;
  saved: "saved" | "fresh" | null;
  warnings: string[];
  error: string | null;
  guide: { label: string; range: Guide["range"]; channel: Guide["channel"]; pace: Guide["pace"]; keyMoments: number; timelineFrames: number } | null;
}

declare global { interface Window { __clipLab?: LabSummary } }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fileInput = $<HTMLInputElement>("file");
const progress = $<HTMLProgressElement>("progress");
const status = $("status");
const video = $<HTMLVideoElement>("video");
const confirmCanvas = $<HTMLCanvasElement>("confirm");
const overlay = $<HTMLCanvasElement>("overlay");
const people = $("people");
const facts = $<HTMLTableElement>("facts");
const params = new URLSearchParams(location.search);

let prepared: Prepared | null = null;
let summary: LabSummary | null = null;
let playing: Guide | null = null;
let busy = false;

function show(id: string, visible: boolean) { $(id).classList.toggle("hidden", !visible); }

function setStatus(lines: string[]) { status.textContent = lines.join(" "); }

function showFacts(rows: [string, string][]) {
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

function toObjects(landmarks: readonly (readonly [number, number, number])[] | null): LandmarkObject[] | null {
  return landmarks ? landmarks.map(([x, y, visibility]) => ({ x, y, z: 0, visibility })) : null;
}

function strokeBox(canvas: HTMLCanvasElement, box: Box, label: string, color: string) {
  const ctx = canvas.getContext("2d")!;
  const { width: w, height: h } = canvas;
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.strokeRect((box.cx - box.w / 2) * w, (box.cy - box.h / 2) * h, box.w * w, box.h * h);
  if (!label) return;
  ctx.fillStyle = color;
  ctx.font = "bold 22px system-ui, sans-serif";
  ctx.fillText(label, (box.cx - box.w / 2) * w + 6, (box.cy - box.h / 2) * h + 24);
}

function seek(seconds: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); video.removeEventListener("seeked", done); resolve(); };
    const timer = setTimeout(done, 3000);
    video.addEventListener("seeked", done);
    video.currentTime = seconds;
  });
}

async function drawConfirm(p: Prepared, chosen: number) {
  fitCanvas(confirmCanvas, p.source.width / p.source.height);
  if (video.readyState < HTMLMediaElement.HAVE_METADATA) await new Promise((r) => video.addEventListener("loadedmetadata", r, { once: true }));
  await seek(p.confirmTMs / 1000);
  drawFrame(confirmCanvas, video, null);
  for (const c of p.candidates) {
    if (c.boxAtConfirm) strokeBox(confirmCanvas, c.boxAtConfirm, String(c.number), c.number === chosen ? "#f5c542" : "#4fc3f7");
  }
}

function showPeople(p: Prepared, chosen: number) {
  people.replaceChildren(...p.candidates.map((c) => {
    const button = document.createElement("button");
    button.textContent = `${c.number}: ${c.label}`;
    button.setAttribute("aria-pressed", String(c.number === chosen));
    button.addEventListener("click", () => choose(c.number));
    return button;
  }));
}

function choose(number: number) {
  if (!prepared || !summary) return;
  const candidate = prepared.candidates.find((c) => c.number === number);
  if (!candidate) return;
  showPeople(prepared, number);
  void drawConfirm(prepared, number).then(() => start(prepared!, candidate.trackId));
}

function start(p: Prepared, trackId: number) {
  if (!summary) return;
  const result = finishClip(p, trackId);
  if (result.error !== null) {
    playing = null;
    show("play", false);
    summary.guide = null;
    summary.error = result.error;
    setStatus([result.error, ...p.warnings]);
    return;
  }
  const guide = result.data;
  playing = guide;
  summary.error = null;
  summary.guide = {
    label: guide.subject.label, range: guide.range, channel: guide.channel, pace: guide.pace,
    keyMoments: guide.keyMoments.length, timelineFrames: guide.timeline?.frames.length ?? 0,
  };
  setStatus([`Playing ${guide.subject.label}.`, ...guide.warnings]);
  fitCanvas(overlay, p.source.width / p.source.height);
  show("play", true);
  video.currentTime = guide.range.startMs / 1000;
  void video.play();
}

function tick() {
  requestAnimationFrame(tick);
  const guide = playing;
  if (!guide || !guide.timeline) return;
  const { startMs, endMs } = guide.range;
  const frameMs = 1000 / guide.source.sampleHz;
  const nowMs = video.currentTime * 1000;
  if (nowMs >= endMs + frameMs || nowMs < startMs - frameMs || video.ended) {
    video.currentTime = startMs / 1000;
    if (video.paused) void video.play();
    return;
  }
  const frames = guide.timeline.frames;
  const index = Math.min(frames.length - 1, Math.max(0, Math.round((nowMs - startMs) / frameMs)));
  drawFrame(overlay, video, toObjects(frames[index]?.landmarks ?? null));
  const box = guide.boxTrack.frames[index]?.box;
  if (box) strokeBox(overlay, box, "", "#f5c542");
}

async function run(file: File) {
  if (busy) return;
  busy = true;
  playing = null;
  video.pause();
  show("choose", false);
  show("play", false);
  progress.value = 0;
  setStatus(["Loading the pose tracker and reading the clip..."]);
  const began = performance.now();
  let result: Awaited<ReturnType<typeof prepareClip>>;
  try {
    result = await prepareClip(file, video, (share) => { progress.value = share; }, { ignoreSaved: params.get("fresh") === "1" });
  } catch (error) {
    result = { data: null, error: `Something went wrong reading the clip: ${(error as Error).message}` };
  }
  const seconds = Math.round((performance.now() - began) / 100) / 10;
  prepared = result.data;
  summary = {
    file: file.name,
    decoder: result.data?.decoder ?? null,
    frames: result.data?.frames.length ?? 0,
    candidates: result.data?.candidates.map((c) => ({ number: c.number, trackId: c.trackId, label: c.label, score: Math.round(c.score * 1000) / 1000 })) ?? [],
    cuts: result.data?.cuts ?? [],
    seconds,
    saved: result.data ? (result.data.fromSaved ? "saved" : "fresh") : null,
    warnings: result.data?.warnings ?? [],
    error: result.error,
    guide: null,
  };
  window.__clipLab = summary;
  showFacts([
    ["File", file.name],
    ["Decoder", summary.decoder ?? "none"],
    ["Frames analysed", String(summary.frames)],
    ["People found", String(summary.candidates.length)],
    ["Cuts", String(summary.cuts.length)],
    ["Seconds taken", String(seconds)],
    ["Result", summary.saved ?? "not saved"],
  ]);
  busy = false;
  fileInput.value = "";
  if (result.error !== null) {
    setStatus([result.error]);
    return;
  }
  const p = result.data;
  setStatus([`Found ${p.candidates.length === 1 ? "1 person" : `${p.candidates.length} people`}. Pick who to follow.`, ...p.warnings]);
  show("choose", true);
  const top = p.candidates[0]!.number;
  showPeople(p, top);
  await drawConfirm(p, top);
  const pick = Number(params.get("pick"));
  if (pick && p.candidates.some((c) => c.number === pick)) choose(pick);
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void run(file);
});

async function runFromUrl(name: string) {
  setStatus([`Fetching ${name}...`]);
  const response = await fetch(`/_clips/${encodeURIComponent(name)}`);
  if (!response.ok) {
    setStatus([`Could not fetch ${name}.`]);
    return;
  }
  const blob = await response.blob();
  await run(new File([blob], name, { type: blob.type }));
}

requestAnimationFrame(tick);
const clipName = params.get("clip");
if (clipName) void runFromUrl(clipName);
