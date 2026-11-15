// Things lab: run the blind mode path (people and things together) on one video and check it by eye.
// URL options: ?clip=<file in /_clips/> runs that file as if picked, ?pick=<number in the list>
// chooses that subject, ?fresh=1 ignores the saved analysis. After each run, window.__thingsLab
// holds a summary.

import { boxPolygon } from "../../clip/src/index.ts";
import type { Box, Guide, View } from "../../clip/src/index.ts";
import { blindView, drawBlind, guideFrameAt } from "./clipside/blind.ts";
import type { PrepareResult, Prepared } from "./clipside/analyze.ts";
import { prepareVideo, subjectGuides, thingObjectClip } from "./clip.ts";

interface SubjectPoint { box: Box; detected: boolean }

interface Subject {
  /** Place in the list, from 1. */
  index: number;
  kind: "person" | "thing";
  label: string;
  score: number;
  color: string;
  points: Map<number, SubjectPoint>;
  guide: Guide | null;
  reason: string | null;
}

interface LabSummary {
  file: string;
  decoder: string | null;
  frames: number;
  objectFinderFrames: number;
  sightings: number;
  seconds: number;
  saved: "saved" | "fresh" | null;
  cuts: number[];
  subjects: { index: number; kind: string; label: string; score: number; ready: boolean; reason: string | null; hint: string | null }[];
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
const subjectList = $("things");
const facts = $<HTMLTableElement>("facts");
const params = new URLSearchParams(location.search);

let prepared: Prepared | null = null;
let subjects: Subject[] = [];
let chosen: Subject | null = null;
/** Where the chosen subject's guide sits on the blind canvas, worked out once per pick. */
let chosenView: View | null = null;
let busy = false;

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
  ctx.font = "bold 18px system-ui, sans-serif";
  const textWidth = ctx.measureText(label).width;
  const labelTop = Math.max(0, top - 24);
  ctx.fillStyle = color;
  ctx.fillRect(left, labelTop, textWidth + 10, 24);
  ctx.fillStyle = "#111";
  ctx.fillText(label, left + 5, labelTop + 18);
}

function fillBox(ctx: CanvasRenderingContext2D, box: Box, color: string) {
  const { width: w, height: h } = ctx.canvas;
  ctx.beginPath();
  boxPolygon(box).forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x * w, y * h) : ctx.lineTo(x * w, y * h)));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function showSubjects() {
  subjectList.replaceChildren(...subjects.map((s) => {
    const button = document.createElement("button");
    button.setAttribute("aria-pressed", String(chosen === s));
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = s.color;
    const seconds = Math.round((s.points.size / (prepared?.source.sampleHz ?? 15)) * 10) / 10;
    button.append(swatch, `${s.index}. ${s.label} (${s.kind}, score ${s.score.toFixed(2)}, on screen ${seconds} s)`);
    if (s.reason) {
      const why = document.createElement("span");
      why.className = "why";
      why.textContent = ` ${s.reason}`;
      button.append(why);
    }
    button.addEventListener("click", () => choose(s.index));
    return button;
  }));
}

function choose(index: number) {
  const subject = subjects.find((s) => s.index === index);
  if (!subject) return;
  chosen = subject;
  chosenView = subject.guide ? blindView(subject.guide, blind, "fit") : null;
  showSubjects();
  if (subject.reason) blindTitle.textContent = `${subject.label}: left out. ${subject.reason}`;
  else if (subject.kind === "thing" && subject.guide) blindTitle.textContent = `${subject.label}, as its player sees it. Hint: ${thingObjectClip(subject.guide).hint}`;
  else blindTitle.textContent = `${subject.label}, as its player sees it.`;
  show("blindView", true);
}

function tick() {
  requestAnimationFrame(tick);
  const p = prepared;
  if (!p || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  const frameMs = 1000 / p.source.sampleHz;
  const nowMs = video.currentTime * 1000;
  const frame = Math.min(p.frames.length - 1, Math.max(0, Math.round(nowMs / frameMs)));

  const ctx = overlay.getContext("2d")!;
  ctx.drawImage(video, 0, 0, overlay.width, overlay.height);
  for (const s of subjects) {
    const point = s.points.get(frame);
    if (point) strokeBox(ctx, point.box, `${s.index} ${s.label}`, s.color, !point.detected);
  }

  const s = chosen;
  if (!s) return;
  if (s.guide && chosenView) {
    // The game's own blind drawing: outline for a thing, stick figure for a person.
    drawBlind(blind, s.guide, guideFrameAt(s.guide, nowMs), s.kind === "thing" ? "outline" : "stick", chosenView, { background: "#16161d", color: s.color });
    return;
  }
  // A subject left out has no guide; show its raw box where it is in the frame.
  const bctx = blind.getContext("2d")!;
  bctx.fillStyle = "#f2efe8";
  bctx.fillRect(0, 0, blind.width, blind.height);
  const point = s.points.get(frame);
  if (point) fillBox(bctx, point.box, s.color);
}

/** People first, then things, each with its guide or the reason it was left out. */
function collectSubjects(p: Prepared): Subject[] {
  const { guides, skipped } = subjectGuides(p);
  const guideByLabel = new Map(guides.map((g) => [g.subject.label, g]));
  const list: Subject[] = [];
  for (const c of p.candidates) {
    const track = p.tracks.find((t) => t.id === c.trackId)!;
    list.push({
      index: list.length + 1, kind: "person", label: c.label, score: c.score, color: "",
      points: new Map(track.points.map((pt) => [pt.frame, { box: pt.box, detected: true }])),
      guide: guideByLabel.get(c.label) ?? null,
      reason: skipped.find((s) => s.label === undefined && s.number === c.number)?.reason ?? null,
    });
  }
  for (const c of p.things?.candidates ?? []) {
    const track = p.things!.tracks.find((t) => t.id === c.trackId)!;
    list.push({
      index: list.length + 1, kind: "thing", label: c.label, score: c.score, color: "",
      points: new Map(track.points.map((pt) => [pt.frame, { box: pt.box, detected: pt.detected }])),
      guide: guideByLabel.get(c.label) ?? null,
      reason: skipped.find((s) => s.label === c.label)?.reason ?? null,
    });
  }
  list.forEach((s, i) => { s.color = COLORS[i % COLORS.length]!; });
  return list;
}

async function run(file: File) {
  if (busy) return;
  busy = true;
  prepared = null;
  subjects = [];
  chosen = null;
  chosenView = null;
  video.pause();
  show("play", false);
  show("blindView", false);
  progress.value = 0;
  setStatus(["Loading the pose tracker and the object finder, then reading the clip..."]);
  const began = performance.now();
  let result: PrepareResult;
  try {
    result = await prepareVideo(file, video, (share) => { progress.value = share; }, { things: true, ignoreSaved: params.get("fresh") === "1" });
  } catch (error) {
    result = { data: null, error: `Something went wrong reading the clip: ${(error as Error).message}`, facts: { decoder: null, frames: 0 } };
  }
  const seconds = Math.round((performance.now() - began) / 100) / 10;
  busy = false;
  fileInput.value = "";

  if (result.error !== null) {
    window.__thingsLab = {
      file: file.name, decoder: result.facts.decoder, frames: result.facts.frames, objectFinderFrames: 0, sightings: 0,
      seconds, saved: null, cuts: [], subjects: [], error: result.error,
    };
    showFacts([["File", file.name], ["Frames analysed", String(result.facts.frames)], ["Seconds taken", String(seconds)]]);
    setStatus([result.error]);
    return;
  }

  const p = result.data;
  prepared = p;
  subjects = collectSubjects(p);
  const thingFrames = p.things?.frames ?? [];
  const sightings = thingFrames.reduce((n, f) => n + (f.things?.length ?? 0), 0);
  const kinds = [...new Set(thingFrames.flatMap((f) => f.things?.map((t) => t.category) ?? []))];
  const ready = subjects.filter((s) => s.guide).length;
  window.__thingsLab = {
    file: file.name, decoder: p.decoder, frames: p.frames.length,
    objectFinderFrames: thingFrames.filter((f) => f.things !== null).length, sightings, seconds,
    saved: p.fromSaved ? "saved" : "fresh", cuts: p.cuts,
    subjects: subjects.map((s) => ({
      index: s.index, kind: s.kind, label: s.label, score: Math.round(s.score * 1000) / 1000, ready: s.guide !== null, reason: s.reason,
      hint: s.kind === "thing" && s.guide ? thingObjectClip(s.guide).hint : null,
    })),
    error: null,
  };
  showFacts([
    ["File", file.name],
    ["Decoder", p.decoder],
    ["Frames analysed", String(p.frames.length)],
    ["Frames the object finder looked at", String(window.__thingsLab.objectFinderFrames)],
    ["Thing boxes seen in all", String(sightings)],
    ["Kinds of thing seen", kinds.length ? kinds.join(", ") : "none"],
    ["People offered", String(p.candidates.length)],
    ["Things offered (on screen 1 second or more)", String(p.things?.candidates.length ?? 0)],
    ["Roles ready for blind mode", String(ready)],
    ["Cuts", String(p.cuts.length)],
    ["Seconds taken", String(seconds)],
    ["Result", p.fromSaved ? "saved (add ?fresh=1 to time a fresh run)" : "fresh"],
  ]);

  fitCanvas(overlay, p.source.width / p.source.height);
  fitCanvas(blind, p.source.width / p.source.height);
  show("play", true);
  showSubjects();
  void video.play();
  if (subjects.length === 0) {
    setStatus(["Nothing found that stays on screen for a second.", ...p.warnings]);
    return;
  }
  setStatus([`${ready} of ${subjects.length} could be a blind mode role. Pick one to see what its player sees.`, ...p.warnings]);
  const pick = Number(params.get("pick"));
  const firstThing = subjects.find((s) => s.kind === "thing");
  choose(pick && subjects.some((s) => s.index === pick) ? pick : (firstThing ?? subjects[0]!).index);
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
