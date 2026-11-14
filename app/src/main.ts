// Jester app shell, Version 1: one clip, one player, one score.
// Clip side: ./clip.ts (stand-in). Player side: Lisa's tracker. Score: ../engine.

import { comparePoses, type Landmarks, type LandmarkObject, type PoseRoundResult } from "../../engine/src/index.ts";
import { sampleAt } from "../../spikes/pose-match/synthetic.mjs";
import { analyzeVideo, starterClip, type Clip } from "./clip.ts";
import { cameraPlayer, playRound, simulatedPlayer, type Player } from "./round.ts";
import { drawFrame, fitCanvas } from "./draw.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const clipVideo = $<HTMLVideoElement>("clip");
const cam = $<HTMLVideoElement>("cam");
const clipCanvas = $<HTMLCanvasElement>("clipCanvas");
const playerCanvas = $<HTMLCanvasElement>("playerCanvas");
const params = new URLSearchParams(location.search);

let clip: Clip | null = null;
let camera: Player | null = null;
let playing = false;
let clipNowMs = 0;
let lastPlayer: { pose: LandmarkObject[] | null; aspect: number } = { pose: null, aspect: 4 / 3 };

const setStatus = (text: string) => { $("status").textContent = text; };
const simMode = () => $<HTMLInputElement>("simPlayer").checked;
const noise = () => Number($<HTMLInputElement>("noise").value);

if (params.has("nocam")) $<HTMLInputElement>("simPlayer").checked = true;
syncSimUi();

function syncSimUi() {
  $("noiseWrap").classList.toggle("hidden", !simMode());
}

function toTuples(lms: readonly LandmarkObject[] | null): Landmarks {
  return lms && lms.length >= 33 ? lms.map((l) => [l.x, l.y, l.visibility ?? 1] as const) : null;
}

function clipPoseAt(ms: number): LandmarkObject[] | null {
  if (!clip) return null;
  return (sampleAt(clip.samples, Math.max(0, ms) / 1000)?.landmarks as LandmarkObject[] | null) ?? null;
}

// ---- Clip choice ----

function clipReady(c: Clip, label: string) {
  clip = c;
  fitCanvas(clipCanvas, c.width / c.height);
  const found = c.samples.filter((s) => s.landmarks).length;
  setStatus(`${label}: ${(c.durationMs / 1000).toFixed(1)} s, person found in ${found} of ${c.samples.length} samples.`);
  $<HTMLButtonElement>("start").disabled = false;
  drawFrame(clipCanvas, c.videoUrl ? clipVideo : null, clipPoseAt(0));
}

$("demoClip").addEventListener("click", () => {
  clipVideo.removeAttribute("src");
  $<HTMLProgressElement>("progress").value = 1;
  clipReady(starterClip(), "Starter clip");
});

$("clipFile").addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  $<HTMLButtonElement>("start").disabled = true;
  setStatus("Loading the pose tracker and reading the clip...");
  try {
    const c = await analyzeVideo(file, clipVideo, (share) => { $<HTMLProgressElement>("progress").value = share; });
    clipReady(c, file.name);
  } catch (err) {
    setStatus("Could not read the clip: " + (err as Error).message);
  }
});

$("simPlayer").addEventListener("change", syncSimUi);
$("noise").addEventListener("input", () => { $("noiseVal").textContent = String(noise()); });

// ---- Round ----

async function countdown(seconds: number) {
  const el = $("countdown");
  el.classList.remove("hidden");
  for (let s = seconds; s > 0; s--) {
    el.textContent = String(s);
    await new Promise((r) => setTimeout(r, 1000));
  }
  el.classList.add("hidden");
}

async function getPlayer(c: Clip): Promise<Player> {
  if (simMode()) return simulatedPlayer(c, noise);
  if (!camera) {
    setStatus("Starting the camera and pose tracker...");
    camera = await cameraPlayer(cam);
  }
  return camera;
}

$("start").addEventListener("click", async () => {
  if (!clip || playing) return;
  const c = clip;
  $<HTMLButtonElement>("start").disabled = true;
  $("results").classList.add("hidden");
  let player: Player;
  try { player = await getPlayer(c); }
  catch (err) {
    setStatus("Camera did not start: " + (err as Error).message + ". Tick 'Simulated player' to try without one.");
    $<HTMLButtonElement>("start").disabled = false;
    return;
  }
  setStatus("Get ready. Copy the clip as if it were a mirror.");
  await countdown(3);
  playing = true;
  setStatus("Go!");
  const round = await playRound(c, c.videoUrl ? clipVideo : null, player, (f) => {
    lastPlayer = { pose: f.player, aspect: f.playerAspect };
    clipNowMs = Math.max(0, f.clipMs);
    if (f.clipMs < 0) return;
    const ref = clipPoseAt(f.clipMs);
    const live = comparePoses(toTuples(ref), toTuples(f.player), { referenceAspect: c.width / c.height, playerAspect: f.playerAspect });
    $("live").textContent = live.credit == null ? "" : `match ${Math.round(live.credit * 100)}%`;
  });
  playing = false;
  (window as any).__jesterLastRound = { result: round.result, frameCount: round.frames.length };
  showResults(round.result);
  $<HTMLButtonElement>("start").disabled = false;
});

$("again").addEventListener("click", () => $("start").click());

function showResults(r: PoseRoundResult) {
  $("results").classList.remove("hidden");
  $("live").textContent = "";
  if (r.score == null) {
    $("score").textContent = "No score";
    $("tier").textContent = "";
    $("summary").textContent = r.failure === "low-tracking"
      ? "The camera lost you for too much of the round. Step back so your whole upper body is in view, and try again."
      : "The clip has no person to copy.";
    $("limbs").innerHTML = "";
    setStatus("Round over.");
    return;
  }
  $("score").textContent = String(r.score);
  $("tier").textContent = r.tier ?? "";
  const lag = r.lagMs > 0 ? `${Math.round(r.lagMs)} ms behind` : r.lagMs < 0 ? `${Math.round(-r.lagMs)} ms ahead` : "right on time";
  const worst = r.worstLimb ? ` Work on ${r.worstLimb.label}: mostly ${r.worstLimb.direction === "angle" ? "at the wrong angle" : "too " + r.worstLimb.direction}.` : "";
  $("summary").textContent = `You were ${lag}.${worst}`;
  const rows = Object.entries(r.perLimb)
    .sort((a, b) => a[1].credit - b[1].credit)
    .map(([name, l]) => `<tr><td>${name}</td><td><span class="bar" style="width:${Math.round(l.credit * 120)}px"></span></td><td>${Math.round(l.credit * 100)}%</td></tr>`);
  $("limbs").innerHTML = rows.join("");
  setStatus(`Round over. Scorer ${r.scorerVersion}.`);
}

// ---- Render loop ----

function render() {
  requestAnimationFrame(render);
  if (clip) {
    const ms = clip.videoUrl ? clipVideo.currentTime * 1000 : playing ? clipNowMs : 0;
    drawFrame(clipCanvas, clip.videoUrl ? clipVideo : null, clipPoseAt(ms));
  }
  fitCanvas(playerCanvas, lastPlayer.aspect);
  // The player sees themself as in a mirror.
  drawFrame(playerCanvas, simMode() ? null : cam, lastPlayer.pose, { mirror: true, color: "#6fd3ff" });
}
requestAnimationFrame(render);
