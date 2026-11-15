// Things lab: run the object detector path on one video and check the result by eye.
// URL options: ?clip=<file in /_clips/> runs that file as if picked, ?pick=<number> chooses that
// thing. After each run, window.__thingsLab holds a summary.

import { boxPolygon } from "../../clip/src/index.ts";
import type { Box, Guide, ThingCandidate, ThingPoint, View } from "../../clip/src/index.ts";
import { blindView, drawBlind, guideFrameAt } from "./clipside/blind.ts";
import { preparedThingGuides, prepareThings, type PreparedThings, type PrepareThingsResult } from "./clipside/things.ts";

interface LabSummary {
  file: string;
  decoder: string | null;
  frames: number;
  detectedFrames: number;
  sightings: number;
  tracks: number;
  cuts: number[];
  seconds: number;
  candidates: { number: number; label: string; score: number; moves: boolean }[];
  skipped: { number: number; label: string; reason: string }[];
  error: string | null;
}

declare global { interface Window { __thingsLab?: LabSummary } }

const COLORS = ["#f5c542", "#4fc3f7", "#ef5350", "#66bb6a", "#ab47bc", "#ff7043", "#26c6da", "#d4e157"];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fileInput = $<HTMLInputElement>("file");
const progress = $<HTMLProgressElement>("progress");
const status = $("status");
const video = $<HTMLVideoElement>("video");
const overlay = $<HTMLCanvasElement>("overlay");
const blind = $<HTMLCanvasElement>("blind");
const blindTitle = $("blindTitle");
const thingList = $("things");
const facts = $<HTMLTableElement>("facts");
const params = new URLSearchParams(location.search);

interface Shown {
  prepared: PreparedThings;
  /** Each candidate's points by analysed frame. */
  pointsByTrack: Map<number, Map<number, ThingPoint>>;
  guideByTrack: Map<number, Guide>;
  reasonByTrack: Map<number, string>;
  colorByTrack: Map<number, string>;
}

let shown: Shown | null = null;
let chosen: ThingCandidate | null = null;
/** Where the chosen thing's guide sits on the blind canvas, worked out once per pick. */
let chosenView: View | null = null;
let busy = false;
let videoUrl: string | null = null;

function show(id: string, visible: boolean) { $(id).classList.toggle("hidden", !visible); }
function setStatus(lines: string[]) { status.textContent = lines.join(" "); }

function fitCanvas(canvas: HTMLCanvasElement, aspect: number) {
  const h = Math.round(canvas.width / aspect);
  if (canvas.height !== h) canvas.height = h;
}

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

function strokeBox(ctx: CanvasRenderingContext2D, box: Box, label: string, color: string, dashed: boolean) {
  const { width: w, height: h } = ctx.canvas;
  const left = (box.cx - box.w / 2) * w;
  const top = (box.cy - box.h / 2) * h;
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.setLineDash(dashed ? [8, 6] : []);
  ctx.strokeRect(left, top, box.w * w, box.h * h);
  ctx.setLineDash([]);
  if (!label) return;
  ctx.font = "bold 18px system-ui, sans-serif";
  const textWidth = ctx.measureText(label).width;
  const labelTop = Math.max(0, top - 24);
  ctx.fillStyle = color;
  ctx.fillRect(left, labelTop, textWidth + 10, 24);
  ctx.fillStyle = "#111";
  ctx.fillText(label, left + 5, labelTop + 18);
}

function fillPolygon(ctx: CanvasRenderingContext2D, points: readonly (readonly [number, number])[], color: string) {
  const { width: w, height: h } = ctx.canvas;
  ctx.beginPath();
  points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x * w, y * h) : ctx.lineTo(x * w, y * h)));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.85;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = "#111";
  ctx.lineWidth = 3;
  ctx.stroke();
}

function showThings(s: Shown) {
  const { candidates } = s.prepared;
  thingList.replaceChildren(...candidates.map((c) => {
    const button = document.createElement("button");
    button.setAttribute("aria-pressed", String(chosen?.trackId === c.trackId));
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = s.colorByTrack.get(c.trackId) ?? "#999";
    const points = s.pointsByTrack.get(c.trackId)?.size ?? 0;
    const seconds = Math.round((points / s.prepared.source.sampleHz) * 10) / 10;
    button.append(swatch, `${c.number}. ${c.label} (score ${c.score.toFixed(2)}, on screen ${seconds} s)`);
    const reason = s.reasonByTrack.get(c.trackId);
    if (reason) {
      const why = document.createElement("span");
      why.className = "why";
      why.textContent = ` ${reason}`;
      button.append(why);
    }
    button.addEventListener("click", () => choose(c.number));
    return button;
  }));
}

function choose(number: number) {
  if (!shown) return;
  const candidate = shown.prepared.candidates.find((c) => c.number === number);
  if (!candidate) return;
  chosen = candidate;
  const guide = shown.guideByTrack.get(candidate.trackId);
  chosenView = guide ? blindView(guide, blind, "fit") : null;
  showThings(shown);
  const reason = shown.reasonByTrack.get(candidate.trackId);
  blindTitle.textContent = reason
    ? `${candidate.label}: refused. ${reason}`
    : `What the player who is ${candidate.label} sees`;
  show("blindView", true);
}

function tick() {
  requestAnimationFrame(tick);
  const s = shown;
  if (!s || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  const frameMs = 1000 / s.prepared.source.sampleHz;
  const nowMs = video.currentTime * 1000;
  const frame = Math.min(s.prepared.frames.length - 1, Math.max(0, Math.round(nowMs / frameMs)));

  const ctx = overlay.getContext("2d")!;
  ctx.drawImage(video, 0, 0, overlay.width, overlay.height);
  for (const c of s.prepared.candidates) {
    const point = s.pointsByTrack.get(c.trackId)?.get(frame);
    if (point) strokeBox(ctx, point.box, `${c.number} ${c.label}`, s.colorByTrack.get(c.trackId)!, !point.detected);
  }

  if (!chosen) return;
  const color = s.colorByTrack.get(chosen.trackId)!;
  const guide = s.guideByTrack.get(chosen.trackId);
  if (guide && chosenView) {
    // The game's own blind drawing, placed to fill the canvas as a player would see it.
    drawBlind(blind, guide, guideFrameAt(guide, nowMs), "outline", chosenView, { background: "#16161d", color });
    return;
  }
  // A refused thing has no guide; show its raw box where it is in the frame.
  const bctx = blind.getContext("2d")!;
  bctx.fillStyle = "#f2efe8";
  bctx.fillRect(0, 0, blind.width, blind.height);
  const point = s.pointsByTrack.get(chosen.trackId)?.get(frame);
  if (point) fillPolygon(bctx, boxPolygon(point.box), color);
}

async function run(file: File) {
  if (busy) return;
  busy = true;
  shown = null;
  chosen = null;
  chosenView = null;
  video.pause();
  show("play", false);
  show("blindView", false);
  progress.value = 0;
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  videoUrl = URL.createObjectURL(file);
  video.src = videoUrl;
  setStatus(["Loading the object finder and reading the clip..."]);
  const began = performance.now();
  let result: PrepareThingsResult;
  try {
    result = await prepareThings(file, video, (share) => { progress.value = share; });
  } catch (error) {
    result = { data: null, error: `Something went wrong reading the clip: ${(error as Error).message}`, facts: { decoder: null, frames: 0 } };
  }
  const seconds = Math.round((performance.now() - began) / 100) / 10;
  busy = false;
  fileInput.value = "";

  if (result.error !== null) {
    window.__thingsLab = {
      file: file.name, decoder: result.facts.decoder, frames: result.facts.frames, detectedFrames: 0, sightings: 0,
      tracks: 0, cuts: [], seconds, candidates: [], skipped: [], error: result.error,
    };
    showFacts([["File", file.name], ["Frames analysed", String(result.facts.frames)], ["Seconds taken", String(seconds)]]);
    setStatus([result.error]);
    return;
  }

  const p = result.data;
  const { guides, skipped } = preparedThingGuides(p);
  const pointsByTrack = new Map<number, Map<number, ThingPoint>>();
  const colorByTrack = new Map<number, string>();
  p.candidates.forEach((c, i) => {
    const track = p.tracks.find((t) => t.id === c.trackId)!;
    pointsByTrack.set(c.trackId, new Map(track.points.map((pt) => [pt.frame, pt])));
    colorByTrack.set(c.trackId, COLORS[i % COLORS.length]!);
  });
  const guideByTrack = new Map<number, Guide>();
  const labelToTrack = new Map(p.candidates.map((c) => [c.label, c.trackId]));
  for (const g of guides) guideByTrack.set(labelToTrack.get(g.subject.label)!, g);
  const reasonByTrack = new Map<number, string>();
  for (const s of skipped) reasonByTrack.set(labelToTrack.get(s.label)!, s.reason);
  shown = { prepared: p, pointsByTrack, guideByTrack, reasonByTrack, colorByTrack };

  const sightings = p.frames.reduce((n, f) => n + (f.things?.length ?? 0), 0);
  const categories = [...new Set(p.frames.flatMap((f) => f.things?.map((t) => t.category) ?? []))];
  window.__thingsLab = {
    file: file.name, decoder: p.decoder, frames: p.frames.length, detectedFrames: p.detectedFrames, sightings,
    tracks: p.tracks.length, cuts: p.cuts, seconds,
    candidates: p.candidates.map((c) => ({ number: c.number, label: c.label, score: Math.round(c.score * 1000) / 1000, moves: c.moves })),
    skipped, error: null,
  };
  showFacts([
    ["File", file.name],
    ["Decoder", p.decoder],
    ["Frames analysed", String(p.frames.length)],
    ["Frames the object finder looked at", String(p.detectedFrames)],
    ["Boxes seen in all", String(sightings)],
    ["Kinds seen", categories.length ? categories.join(", ") : "none"],
    ["Tracks (before the 1 second rule)", String(p.tracks.length)],
    ["Things offered", String(p.candidates.length)],
    ["Ready as guides", String(guides.length)],
    ["Cuts", String(p.cuts.length)],
    ["Seconds taken", String(seconds)],
  ]);

  fitCanvas(overlay, p.source.width / p.source.height);
  fitCanvas(blind, p.source.width / p.source.height);
  show("play", true);
  showThings(shown);
  void video.play();
  if (p.candidates.length === 0) {
    setStatus([`No things found that stay on screen for a second.${sightings ? ` The finder saw ${sightings} boxes (${categories.join(", ")}), all too brief.` : ""}`, ...p.warnings]);
    return;
  }
  setStatus([`Found ${p.candidates.length === 1 ? "1 thing" : `${p.candidates.length} things`}. Pick one to see its outline alone.`, ...p.warnings]);
  const pick = Number(params.get("pick"));
  choose(pick && p.candidates.some((c) => c.number === pick) ? pick : p.candidates[0]!.number);
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
