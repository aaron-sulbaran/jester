// Link lab: paste a link, grab the moves from the playing clip through tab capture, pick a person,
// and check the guide by eye. Flow A embeds a YouTube player in this tab; Flow B grabs from any
// other tab. Only the people analysis is saved. URL option: ?link=<pasted link> opens it at once.
// After each grab, window.__linkLab holds a summary.

import type { Box, Guide } from "../../clip/src/index.ts";
import { finishClip, subjectGuides, type Prepared } from "./clipside/analyze.ts";
import { blindView, drawBlind, guideFrameAt, traceOutline, type Look } from "./clipside/blind.ts";
import { canCaptureTab, captureTab, NO_TAB_CAPTURE } from "./clipside/capture.ts";
import {
  grabFromOtherTab, grabFromPlayer, lastGrab, loadPrepared, MAX_GRAB_MS, MIN_GRAB_MS, rememberGrab, TOO_SHORT,
  type GrabResult, type GrabStats, type OtherTabGrab,
} from "./clipside/grab.ts";
import { grabKey, parseLink, type ParsedLink } from "./clipside/link.ts";
import { createPlayer, EMBED_OFF, STATE, type YtPlayer } from "./clipside/youtube.ts";
import type { View } from "../../clip/src/index.ts";

type Flow = "player" | "tab";

interface LabSummary {
  link: string | null;
  flow: Flow;
  key: string;
  frames: number;
  candidates: { number: number; trackId: number; label: string; score: number }[];
  cuts: number[];
  seconds: number | null;
  saved: "saved" | "fresh";
  warnings: string[];
  roles: { guides: string[]; skipped: { number: number; reason: string }[] };
  guide: { label: string; range: Guide["range"]; pace: Guide["pace"]; timelineFrames: number; outlineFrames: number } | null;
  error: string | null;
}

declare global { interface Window { __linkLab?: LabSummary } }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const linkInput = $<HTMLInputElement>("link");
const status = $("status");
const ytSection = $("yt");
const playerBox = $("player-box");
const playerHost = $("player-host");
const overlay = $<HTMLCanvasElement>("overlay");
const playButton = $<HTMLButtonElement>("play");
const startInput = $<HTMLInputElement>("start");
const lengthInput = $<HTMLInputElement>("length");
const grabButton = $<HTMLButtonElement>("grab");
const openTab = $<HTMLAnchorElement>("open-tab");
const useSavedButton = $<HTMLButtonElement>("use-saved");
const grabOtherButton = $<HTMLButtonElement>("grab-other");
const embedSection = $("embed");
const embedBox = $("embed-box");
const embedFrame = $<HTMLIFrameElement>("embed-frame");
const grabEmbedButton = $<HTMLButtonElement>("grab-embed");
const recRow = $("rec");
const startOtherButton = $<HTMLButtonElement>("start-other");
const stopOtherButton = $<HTMLButtonElement>("stop-other");
const timer = $("timer");
const live = $<HTMLCanvasElement>("live");
const progress = $<HTMLProgressElement>("progress");
const confirmCanvas = $<HTMLCanvasElement>("confirm");
const people = $("people");
const blindCanvas = $<HTMLCanvasElement>("blind");
const facts = $<HTMLTableElement>("facts");

const STEP_MS = 1000 / 15;
const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]] as const;
const CHOSEN = "#f5c542";
const OTHERS = "#4fc3f7";

let link: ParsedLink | null = null;
let player: YtPlayer | null = null;
let busy = false;
let other: OtherTabGrab | null = null;
let prepared: Prepared | null = null;
let flow: Flow = "player";
let summary: LabSummary | null = null;
let playing: Guide | null = null;
let view: View | null = null;
let clockStart = 0;
let lastSeekAt = 0;
let look: Look = "outline";

function setStatus(...lines: string[]) { status.textContent = lines.filter(Boolean).join(" "); }
function show(el: HTMLElement, visible: boolean) { el.classList.toggle("hidden", !visible); }
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

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

// ---- Drawing ----

type Points = readonly (readonly number[])[];

function strokeSkeleton(ctx: CanvasRenderingContext2D, landmarks: Points, w: number, h: number, color: string) {
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2, w / 200);
  ctx.lineCap = "round";
  for (const [a, b] of BONES) {
    const p = landmarks[a], q = landmarks[b];
    if (!p || !q || (p[2] ?? 1) < 0.5 || (q[2] ?? 1) < 0.5) continue;
    ctx.beginPath();
    ctx.moveTo(p[0]! * w, p[1]! * h);
    ctx.lineTo(q[0]! * w, q[1]! * h);
    ctx.stroke();
  }
  const nose = landmarks[0];
  if (nose && (nose[2] ?? 1) >= 0.5) {
    ctx.beginPath();
    ctx.arc(nose[0]! * w, nose[1]! * h, h * 0.03, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function strokeBox(ctx: CanvasRenderingContext2D, box: Box, label: string, w: number, h: number, color: string) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.strokeRect((box.cx - box.w / 2) * w, (box.cy - box.h / 2) * h, box.w * w, box.h * h);
  if (!label) return;
  ctx.fillStyle = color;
  ctx.font = "bold 22px system-ui, sans-serif";
  ctx.fillText(label, (box.cx - box.w / 2) * w + 6, (box.cy - box.h / 2) * h + 24);
}

/** Sizes the overlay to the player box in device pixels and clears it. */
function overlayContext(): CanvasRenderingContext2D {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round(playerBox.clientWidth * ratio);
  const height = Math.round(playerBox.clientHeight * ratio);
  if (overlay.width !== width) overlay.width = width;
  if (overlay.height !== height) overlay.height = height;
  const ctx = overlay.getContext("2d")!;
  ctx.clearRect(0, 0, width, height);
  return ctx;
}

/** A plain canvas in the clip's shape: wide clips 640 across, tall ones 360. */
function sizeView(canvas: HTMLCanvasElement, p: Prepared): CanvasRenderingContext2D {
  const aspect = p.source.width / p.source.height;
  canvas.width = aspect >= 1 ? 640 : 360;
  canvas.height = Math.round(canvas.width / aspect);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#16161d";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return ctx;
}

/** Every candidate at the confirm frame, numbered; on the player too when it is there. */
function drawConfirm(p: Prepared, chosen: number) {
  const ctx = sizeView(confirmCanvas, p);
  const { width: w, height: h } = confirmCanvas;
  const overlayCtx = flow === "player" && player ? overlayContext() : null;
  for (const c of p.candidates) {
    const color = c.number === chosen ? CHOSEN : OTHERS;
    const point = p.tracks.find((t) => t.id === c.trackId)?.points.find((pt) => pt.frame === p.confirmFrame);
    if (point) strokeSkeleton(ctx, point.landmarks, w, h, color);
    if (c.boxAtConfirm) {
      strokeBox(ctx, c.boxAtConfirm, String(c.number), w, h, color);
      if (overlayCtx) strokeBox(overlayCtx, c.boxAtConfirm, String(c.number), overlay.width, overlay.height, color);
    }
  }
}

function drawGuideFrame(ctx: CanvasRenderingContext2D, guide: Guide, index: number, w: number, h: number) {
  const outline = guide.outlines[index];
  if (outline) {
    traceOutline(ctx, outline, (x, y) => [x * w, y * h]);
    ctx.strokeStyle = OTHERS;
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.stroke();
  }
  const landmarks = guide.timeline?.frames[index]?.landmarks;
  if (landmarks) strokeSkeleton(ctx, landmarks, w, h, CHOSEN);
}

// ---- Preview of the chosen person ----

function stopPreview() {
  playing = null;
  view = null;
  show(overlay, false);
}

function startPreview(guide: Guide) {
  playing = guide;
  view = null;
  show($("preview"), true);
  if (flow === "player" && player) {
    show(overlay, true);
    player.seekTo(guide.range.startMs / 1000, true);
    player.playVideo();
    lastSeekAt = performance.now();
  } else {
    clockStart = performance.now();
  }
}

function tick() {
  requestAnimationFrame(tick);
  const guide = playing;
  if (!guide || !prepared) return;
  const { startMs, endMs } = guide.range;
  let mediaMs: number;
  if (flow === "player" && player) {
    mediaMs = player.getCurrentTime() * 1000;
    const outside = mediaMs > endMs + STEP_MS || mediaMs < startMs - 500 || player.getPlayerState() === STATE.ENDED;
    if (outside && performance.now() - lastSeekAt > 600) {
      player.seekTo(startMs / 1000, true);
      player.playVideo();
      lastSeekAt = performance.now();
    }
    const ctx = overlayContext();
    drawGuideFrame(ctx, guide, guideFrameAt(guide, mediaMs), overlay.width, overlay.height);
  } else {
    const loopMs = endMs - startMs + STEP_MS;
    mediaMs = startMs + ((performance.now() - clockStart) % loopMs);
    const ctx = sizeView(confirmCanvas, prepared);
    drawGuideFrame(ctx, guide, guideFrameAt(guide, mediaMs), confirmCanvas.width, confirmCanvas.height);
  }
  view ??= blindView(guide, blindCanvas, "fit");
  drawBlind(blindCanvas, guide, guideFrameAt(guide, mediaMs), look, view);
}

// ---- Results ----

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
  const p = prepared;
  if (!p || !summary) return;
  const candidate = p.candidates.find((c) => c.number === number);
  if (!candidate) return;
  showPeople(p, number);
  stopPreview();
  drawConfirm(p, number);
  const result = finishClip(p, candidate.trackId);
  if (result.error !== null) {
    summary.guide = null;
    summary.error = result.error;
    setStatus(result.error, ...p.warnings);
    return;
  }
  const guide = result.data;
  summary.error = null;
  summary.guide = {
    label: guide.subject.label, range: guide.range, pace: guide.pace,
    timelineFrames: guide.timeline?.frames.length ?? 0, outlineFrames: guide.outlines.filter((o) => o !== null).length,
  };
  setStatus(`Following ${guide.subject.label}.`, `Outline in ${summary.guide.outlineFrames} of ${guide.outlines.length} frames.`, ...guide.warnings);
  startPreview(guide);
}

function statsRows(stats: GrabStats | null): [string, string][] {
  if (!stats) return [];
  return [
    ["Clip seconds grabbed", String(stats.seconds)],
    ["Frames the tracker read", `${stats.read} (${stats.seconds ? (stats.read / stats.seconds).toFixed(1) : "0"} a second; 15 is the aim)`],
    ["Tracker ms per frame", String(stats.trackerMs)],
    ["This page hidden while grabbing", `${stats.hiddenSeconds} s`],
    ["Slots filled from a far frame", String(stats.stretched)],
    ["Tracks before and after joining", `${stats.tracksBeforeJoining} then ${stats.tracksAfterJoining}`],
  ];
}

function showPrepared(p: Prepared, from: Flow, seconds: number | null, stats: GrabStats | null = null) {
  prepared = p;
  flow = from;
  const roles = subjectGuides(p);
  summary = {
    link: link?.url ?? null, flow: from, key: p.fingerprint, frames: p.frames.length,
    candidates: p.candidates.map((c) => ({ number: c.number, trackId: c.trackId, label: c.label, score: Math.round(c.score * 1000) / 1000 })),
    cuts: p.cuts, seconds, saved: p.fromSaved ? "saved" : "fresh", warnings: p.warnings,
    roles: { guides: roles.guides.map((g) => g.subject.label), skipped: roles.skipped }, guide: null, error: null,
  };
  window.__linkLab = summary;
  showFacts([
    ["Link", summary.link ?? "none"],
    ["Grabbed from", from === "player" ? "the player on this page" : "another tab"],
    ["Saved as", p.fingerprint],
    ["Frames analysed", String(p.frames.length)],
    ["People found", String(p.candidates.length)],
    ["Cuts", String(p.cuts.length)],
    ["Blind mode roles", [`${roles.guides.length}`, ...roles.skipped.map((s) => `Person ${s.number} skipped: ${s.reason}`)].join("; ")],
    ["Seconds taken", seconds === null ? "not timed" : String(seconds)],
    ["Result", summary.saved],
    ...statsRows(stats),
  ]);
  const top = p.candidates[0]!.number;
  show($("choose"), true);
  if (from === "player" && player) {
    player.pauseVideo();
    player.seekTo(p.confirmTMs / 1000, true);
    show(overlay, true);
  }
  showPeople(p, top);
  drawConfirm(p, top);
  const found = p.candidates.length === 1 ? "1 person" : `${p.candidates.length} people`;
  setStatus(`Found ${found}. Pick who to follow.`, p.fromSaved ? "These moves were grabbed before." : "", ...p.warnings);
}

function handleResult(result: GrabResult, from: Flow, linkKey: string | null, began: number) {
  progress.value = 0;
  if (result.error !== null) {
    setStatus(result.error);
    showFacts(statsRows(result.stats));
    return;
  }
  if (linkKey) rememberGrab(linkKey, result.data.fingerprint);
  showPrepared(result.data, from, Math.round((performance.now() - began) / 100) / 10, result.stats);
}

function clearResult() {
  stopPreview();
  prepared = null;
  summary = null;
  show($("choose"), false);
  show($("preview"), false);
  facts.replaceChildren();
}

// ---- Flow A: YouTube in this tab ----

function duration(): number {
  return player?.getDuration() ?? 0;
}

function currentRange(): { startMs: number; endMs: number } {
  const startMs = Number(startInput.value) * 1000;
  let endMs = startMs + Math.min(MAX_GRAB_MS, Number(lengthInput.value) * 1000);
  const total = duration() * 1000;
  if (total > 0) endMs = Math.min(endMs, Math.floor(total));
  return { startMs, endMs };
}

function updateLabels() {
  const total = duration();
  if (total > 0) startInput.max = String(Math.max(0, Math.floor(total) - 3));
  $("start-label").textContent = clock(Number(startInput.value));
  $("length-label").textContent = `${lengthInput.value} s`;
  const { startMs, endMs } = currentRange();
  $("range-label").textContent = `Grabs ${clock(startMs / 1000)} to ${clock(endMs / 1000)}`;
  playButton.textContent = player?.getPlayerState() === STATE.PLAYING ? "Pause" : "Play";
}

async function openYoutube(parsed: Extract<ParsedLink, { site: "youtube" }>) {
  show(ytSection, true);
  playerBox.classList.toggle("tall", parsed.short);
  setStatus("Loading the player...");
  player = null;
  const made = await createPlayer(playerHost, parsed.videoId, parsed.startSeconds, {
    onState: () => updateLabels(),
    onError: (sentence) => {
      setStatus(sentence);
      if (sentence === EMBED_OFF) show(ytSection, false);
    },
  });
  if (made.error !== null) {
    setStatus(made.error);
    if (made.error === EMBED_OFF) show(ytSection, false);
    return;
  }
  player = made.data;
  player.mute();
  startInput.value = String(parsed.startSeconds);
  updateLabels();
  const { startMs, endMs } = currentRange();
  const saved = await loadPrepared(grabKey(parsed.key, startMs, endMs));
  setStatus(saved
    ? "The moves for this stretch were grabbed before. Press Grab the moves to use them."
    : "Pick where to start and how long, then press Grab the moves.");
}

async function grabFromThisTab() {
  if (busy || !player || link?.site !== "youtube") return;
  if (!canCaptureTab()) return setStatus(NO_TAB_CAPTURE);
  const range = currentRange();
  if (range.endMs - range.startMs < MIN_GRAB_MS) return setStatus(TOO_SHORT);
  const key = grabKey(link.key, range.startMs, range.endMs);
  const began = performance.now();
  // Reading the saved analysis is quick, so the click still counts when the picker opens.
  const saved = await loadPrepared(key);
  if (saved) {
    clearResult();
    showPrepared(saved, "player", 0);
    return;
  }
  busy = true;
  clearResult();
  playerBox.scrollIntoView({ block: "nearest" });
  const capture = await captureTab("this", playerBox);
  if (capture.error !== null) {
    busy = false;
    setStatus(capture.error);
    return;
  }
  setStatus(capture.data.cropped
    ? "Grabbing the moves. Keep this tab open until it finishes."
    : "Grabbing the moves (this browser could not crop to the player, so the whole tab is read).");
  progress.value = 0;
  const result = await grabFromPlayer(capture.data, player, range, key, (share) => { progress.value = share; });
  busy = false;
  handleResult(result, "player", link.key, began);
}

// ---- Flow B: any other tab ----

function resetOther() {
  other = null;
  busy = false;
  grabOtherButton.disabled = !canCaptureTab();
  grabEmbedButton.disabled = !canCaptureTab();
  startOtherButton.disabled = true;
  stopOtherButton.disabled = true;
  show(live, false);
  show(recRow, false);
  timer.textContent = "";
}

/** Flow B (another tab), or the same timed by the clock from an embed on this page, cropped to it. */
async function grabWithClock(where: "other" | "embed") {
  if (busy) return;
  if (!canCaptureTab()) return setStatus(NO_TAB_CAPTURE);
  busy = true;
  clearResult();
  if (where === "embed") embedBox.scrollIntoView({ block: "nearest" });
  const capture = where === "embed" ? await captureTab("this", embedBox) : await captureTab("other");
  if (capture.error !== null) {
    resetOther();
    setStatus(capture.error);
    return;
  }
  grabOtherButton.disabled = true;
  grabEmbedButton.disabled = true;
  stopOtherButton.disabled = false;
  show(recRow, true);
  setStatus("Loading the pose tracker...");
  const linkKey = link?.key ?? null;
  const baseKey = `${linkKey ?? `tab:${Date.now()}`}:${where === "embed" ? "page" : "tab"}`;
  const made = await grabFromOtherTab(capture.data, live, (lengthMs) => grabKey(baseKey, 0, lengthMs), (seconds) => {
    timer.textContent = seconds === null ? "" : `${seconds.toFixed(1)} s of ${MAX_GRAB_MS / 1000}`;
    if (seconds !== null) progress.value = seconds / (MAX_GRAB_MS / 1000);
  });
  if (made.error !== null) {
    resetOther();
    setStatus(made.error);
    return;
  }
  other = made.data;
  show(live, where === "other");
  startOtherButton.disabled = false;
  setStatus(where === "embed"
    ? "Press play on the clip, then press Start. Press Stop when the moves end (30 seconds at most)."
    : "Sharing that tab. Press play there, then press Start here. Press Stop when the moves end (30 seconds at most).");
  const began = performance.now();
  const result = await made.data.done;
  resetOther();
  handleResult(result, "tab", linkKey, began);
}

// ---- Opening a link ----

async function openLink() {
  if (busy) return;
  clearResult();
  show(useSavedButton, false);
  show(embedSection, false);
  embedFrame.removeAttribute("src");
  const result = parseLink(linkInput.value);
  if (result.error !== null) {
    link = null;
    show(ytSection, false);
    show(openTab, false);
    setStatus(result.error);
    return;
  }
  link = result.data;
  openTab.href = link.url;
  show(openTab, true);
  const before = await lastGrab(link.key);
  show(useSavedButton, before !== null);
  if (link.site === "youtube") {
    await openYoutube(link);
  } else {
    player = null;
    show(ytSection, false);
    const site = link.site === "tiktok" ? "TikTok" : "Instagram";
    if (link.embedUrl) {
      embedFrame.src = link.embedUrl;
      show(embedSection, true);
      setStatus(`The ${site} clip is below. Press Grab from this page, or open it in its own tab and use Grab from another tab.`);
    } else {
      setStatus(`${site} clips play in their own tab. Open it, then press Grab from another tab.`);
    }
  }
  if (!canCaptureTab()) setStatus(NO_TAB_CAPTURE);
}

async function useSaved() {
  if (!link || busy) return;
  const saved = await lastGrab(link.key);
  if (!saved) return setStatus("Nothing was grabbed from this link before.");
  clearResult();
  const fromPlayer = link.site === "youtube" && player !== null && !/:(tab|page):/.test(saved.fingerprint);
  showPrepared(saved, fromPlayer ? "player" : "tab", 0);
}

$("open").addEventListener("click", () => void openLink());
linkInput.addEventListener("keydown", (e) => { if (e.key === "Enter") void openLink(); });
playButton.addEventListener("click", () => {
  if (!player) return;
  stopPreview();
  if (player.getPlayerState() === STATE.PLAYING) player.pauseVideo();
  else player.playVideo();
});
startInput.addEventListener("input", updateLabels);
startInput.addEventListener("change", () => { stopPreview(); player?.seekTo(Number(startInput.value), true); });
lengthInput.addEventListener("input", updateLabels);
$("use-now").addEventListener("click", () => {
  if (!player) return;
  startInput.value = String(Math.floor(player.getCurrentTime()));
  updateLabels();
});
grabButton.addEventListener("click", () => void grabFromThisTab());
grabOtherButton.addEventListener("click", () => void grabWithClock("other"));
grabEmbedButton.addEventListener("click", () => void grabWithClock("embed"));
startOtherButton.addEventListener("click", () => {
  if (!other) return;
  other.start();
  startOtherButton.disabled = true;
  setStatus("Grabbing. Press Stop when the moves end.");
});
stopOtherButton.addEventListener("click", () => other?.stop());
useSavedButton.addEventListener("click", () => void useSaved());
for (const input of document.querySelectorAll<HTMLInputElement>('input[name="look"]')) {
  input.addEventListener("change", () => { if (input.checked) look = input.value as Look; });
}

resetOther();
if (!canCaptureTab()) {
  grabButton.disabled = true;
  setStatus(NO_TAB_CAPTURE);
}
requestAnimationFrame(tick);
const asked = new URLSearchParams(location.search).get("link");
if (asked) {
  linkInput.value = asked;
  void openLink();
}
