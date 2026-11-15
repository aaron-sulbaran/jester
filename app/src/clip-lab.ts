// Clip lab: run the clip side on one video and check the result by eye.
// URL options: ?clip=<file in /_clips/> runs that file as if picked, ?pick=<number> chooses that
// person, ?fresh=1 ignores the saved analysis, ?model=lite|heavy times another pose model (not saved),
// ?overlay=skeleton|outline|both, ?look=outline|stick and ?place=fit|exact set the switches.
// After each run, window.__clipLab holds a summary.

import { linkTracks, pointNearFrame, type Box, type Guide, type Placement, type View } from "../../clip/src/index.ts";
import type { LandmarkObject } from "../../engine/src/index.ts";
import { finishClip, prepareClip, subjectGuides, type Prepared, type PrepareResult } from "./clipside/analyze.ts";
import { blindView, drawBlind, guideFrameAt, traceOutline, type Look } from "./clipside/blind.ts";
import type { PoseModel } from "./clipside/detect.ts";
import { drawFrame, fitCanvas } from "./draw.ts";

interface LabSummary {
  file: string;
  decoder: Prepared["decoder"] | null;
  frames: number;
  candidates: { number: number; trackId: number; label: string; score: number }[];
  model: PoseModel;
  /** Tracks from linking alone, before people split into pieces were joined back. */
  piecesBeforeJoining: number;
  tracks: number;
  cuts: number[];
  seconds: number;
  saved: "saved" | "fresh" | null;
  warnings: string[];
  /** What blind mode would get from subjectGuides: one guide per playable person. */
  roles: { guides: string[]; skipped: { number: number; reason: string }[] } | null;
  error: string | null;
  guide: { label: string; range: Guide["range"]; channel: Guide["channel"]; pace: Guide["pace"]; keyMoments: number; timelineFrames: number; outlineFrames: number } | null;
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
const blindCanvas = $<HTMLCanvasElement>("blind");
const params = new URLSearchParams(location.search);

type Overlay = "skeleton" | "outline" | "both";

/** A radio group whose value is one of `values`; starts from the URL option, else `fallback`. */
function radioGroup<T extends string>(name: string, values: readonly T[], fallback: T, onChange: () => void): () => T {
  const asked = params.get(name) as T | null;
  let value: T = asked && values.includes(asked) ? asked : fallback;
  for (const input of document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)) {
    input.checked = input.value === value;
    input.addEventListener("change", () => {
      if (input.checked) { value = input.value as T; onChange(); }
    });
  }
  return () => value;
}

let view: View | null = null;
const resetView = () => { view = null; };
const overlayMode = radioGroup<Overlay>("overlay", ["skeleton", "outline", "both"], "both", () => {});
const look = radioGroup<Look>("look", ["outline", "stick"], "outline", () => {});
const place = radioGroup<Placement>("place", ["fit", "exact"], "fit", resetView);
const askedModel = params.get("model");
const poseModel: PoseModel = askedModel === "lite" || askedModel === "heavy" ? askedModel : "full";

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

function strokeBox(canvas: HTMLCanvasElement, box: Box, label: string, color: string, dashed = false) {
  const ctx = canvas.getContext("2d")!;
  const { width: w, height: h } = canvas;
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.setLineDash(dashed ? [10, 8] : []);
  ctx.strokeRect((box.cx - box.w / 2) * w, (box.cy - box.h / 2) * h, box.w * w, box.h * h);
  ctx.setLineDash([]);
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
    const color = c.number === chosen ? "#f5c542" : "#4fc3f7";
    if (c.boxAtConfirm) {
      strokeBox(confirmCanvas, c.boxAtConfirm, String(c.number), color);
      continue;
    }
    // Not in this frame: show them where they are nearest to it, dashed, so nobody is missing from the choice.
    const track = p.tracks.find((t) => t.id === c.trackId);
    const near = track ? pointNearFrame(track, p.confirmFrame) : null;
    if (near) strokeBox(confirmCanvas, near.box, String(c.number), color, true);
  }
}

const DASHED_NOTE = "A dashed box is someone who is not in this frame, shown where they are closest to it.";

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
    outlineFrames: guide.outlines.filter((o) => o !== null).length,
  };
  const outlined = summary.guide.outlineFrames;
  const outlineNote = `Outline in ${outlined} of ${guide.outlines.length} frames.`;
  setStatus([`Playing ${guide.subject.label}.`, outlineNote, ...guide.warnings]);
  fitCanvas(overlay, p.source.width / p.source.height);
  resetView();
  show("play", true);
  video.currentTime = guide.range.startMs / 1000;
  void video.play();
}

/** Sends playback back to the start of the guide's range when it leaves it. True when it did. */
function keepInRange(): boolean {
  const guide = playing;
  if (!guide) return false;
  const { startMs, endMs } = guide.range;
  const frameMs = 1000 / guide.source.sampleHz;
  const nowMs = video.currentTime * 1000;
  if (nowMs < endMs + frameMs && nowMs >= startMs - frameMs && !video.ended) return false;
  video.currentTime = startMs / 1000;
  if (video.paused) void video.play();
  return true;
}

// Animation frames stop while the page is hidden; these keep the loop going regardless.
video.addEventListener("timeupdate", keepInRange);
video.addEventListener("ended", keepInRange);

function tick() {
  requestAnimationFrame(tick);
  const guide = playing;
  if (!guide || !guide.timeline || keepInRange()) return;
  const { startMs } = guide.range;
  const frameMs = 1000 / guide.source.sampleHz;
  const nowMs = video.currentTime * 1000;
  const frames = guide.timeline.frames;
  const index = Math.min(frames.length - 1, Math.max(0, Math.round((nowMs - startMs) / frameMs)));
  const mode = overlayMode();
  drawFrame(overlay, video, mode === "outline" ? null : toObjects(frames[index]?.landmarks ?? null));
  const outline = guide.outlines[index];
  if (mode !== "skeleton" && outline) {
    const ctx = overlay.getContext("2d")!;
    traceOutline(ctx, outline, (x, y) => [x * overlay.width, y * overlay.height]);
    ctx.strokeStyle = "#4fc3f7";
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.stroke();
  }
  const box = guide.boxTrack.frames[index]?.box;
  if (box && mode === "skeleton") strokeBox(overlay, box, "", "#f5c542");

  view ??= blindView(guide, blindCanvas, place());
  drawBlind(blindCanvas, guide, guideFrameAt(guide, nowMs), look(), view);
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
  let result: PrepareResult;
  try {
    result = await prepareClip(file, video, (share) => { progress.value = share; }, { ignoreSaved: params.get("fresh") === "1", model: poseModel });
  } catch (error) {
    result = { data: null, error: `Something went wrong reading the clip: ${(error as Error).message}`, facts: { decoder: null, frames: 0 } };
  }
  const seconds = Math.round((performance.now() - began) / 100) / 10;
  prepared = result.data;
  summary = {
    file: file.name,
    decoder: result.data ? result.data.decoder : result.facts.decoder,
    frames: result.data ? result.data.frames.length : result.facts.frames,
    candidates: result.data?.candidates.map((c) => ({ number: c.number, trackId: c.trackId, label: c.label, score: Math.round(c.score * 1000) / 1000 })) ?? [],
    model: poseModel,
    piecesBeforeJoining: result.data ? linkTracks(result.data.frames, result.data.cuts, { maxGap: result.data.source.sampleHz }).length : 0,
    tracks: result.data?.tracks.length ?? 0,
    cuts: result.data?.cuts ?? [],
    seconds,
    saved: result.data ? (result.data.fromSaved ? "saved" : "fresh") : null,
    warnings: result.data?.warnings ?? [],
    roles: null,
    error: result.error,
    guide: null,
  };
  if (result.data) {
    const roles = subjectGuides(result.data);
    summary.roles = { guides: roles.guides.map((g) => g.subject.label), skipped: roles.skipped };
  }
  window.__clipLab = summary;
  const roleText = summary.roles
    ? [`${summary.roles.guides.length}`, ...summary.roles.skipped.map((s) => `Person ${s.number} skipped: ${s.reason}`)].join("; ")
    : "none";
  showFacts([
    ["File", file.name],
    ["Decoder", summary.decoder ?? "not known"],
    ["Frames analysed", String(summary.frames)],
    ["Pose model", summary.model],
    ["People found", String(summary.candidates.length)],
    ["Tracks", `${summary.piecesBeforeJoining} pieces joined into ${summary.tracks}`],
    ["Cuts", String(summary.cuts.length)],
    ["Blind mode roles", roleText],
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
  const dashed = p.candidates.some((c) => c.boxAtConfirm === null);
  setStatus([`Found ${p.candidates.length === 1 ? "1 person" : `${p.candidates.length} people`}. Pick who to follow.`, ...(dashed ? [DASHED_NOTE] : []), ...p.warnings]);
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
