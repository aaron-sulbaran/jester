// Jester app shell, Version 1: one clip, one player, one score.
// Clip side: ./clip.ts (stand-in). Player side: Lisa's tracker. Score: ../engine.

import { BODY_PARTS, comparePoses, LIMBS, type BodyPart, type Landmarks, type LandmarkObject, type PoseRoundResult, type TrajectoryRoundResult } from "../../engine/src/index.ts";
import { sampleAt } from "../../spikes/pose-match/synthetic.mjs";
import { analyzeVideo, starterClip, type Clip } from "./clip.ts";
import { cameraPlayer, playObjectRound, playRound, simulatedPlayer, type Player } from "./round.ts";
import { drawFrame, drawObject, fitCanvas } from "./draw.ts";
import { OBJECT_NAMES, objectClip, simulatedObjectPlayer, type ObjectClip } from "./objectClips.ts";
import { cutFrame, recordReveal, type Cutout } from "./cutout.ts";
import { initGame } from "./ui/game.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const clipVideo = $<HTMLVideoElement>("clip");
const cam = $<HTMLVideoElement>("cam");
const clipCanvas = $<HTMLCanvasElement>("clipCanvas");
const playerCanvas = $<HTMLCanvasElement>("playerCanvas");
const params = new URLSearchParams(location.search);

let clip: Clip | null = null;
/** Set instead of `clip` when the player copies an object. */
let objClip: ObjectClip | null = null;
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
  objClip = null;
  $("partRow").classList.add("hidden");
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

// The body-part picker: chosen before the round starts, shown only for object clips.
for (const [key, part] of Object.entries(BODY_PARTS)) {
  const opt = document.createElement("option");
  opt.value = key;
  opt.textContent = part.label.toLowerCase() + (key.endsWith("Foot") ? " (keep your feet in view)" : "");
  $("bodyPart").appendChild(opt);
}
const chosenPart = () => $<HTMLSelectElement>("bodyPart").value as BodyPart;

for (const name of OBJECT_NAMES) {
  const b = document.createElement("button");
  b.textContent = name[0]!.toUpperCase() + name.slice(1);
  b.addEventListener("click", () => {
    clip = null;
    objClip = objectClip(name);
    clipVideo.removeAttribute("src");
    fitCanvas(clipCanvas, objClip.width / objClip.height);
    $<HTMLProgressElement>("progress").value = 1;
    $("partRow").classList.remove("hidden");
    setStatus(`Object clip: ${name}, ${objClip.durationMs / 1000} s. Pick what plays the ${name}, then start.`);
    $<HTMLButtonElement>("start").disabled = false;
  });
  $("objectButtons").appendChild(b);
}

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
  if (simMode()) return simulatedPlayer(c, noise, params.has("seated"));
  return getCamera();
}

async function startObjectRound(o: ObjectClip) {
  $<HTMLButtonElement>("start").disabled = true;
  $("results").classList.add("hidden");
  let player: Player;
  try {
    // In simulated mode the wobble slider stands for effort: 0 is a full copy, 40 is a fifth of the movement.
    player = simMode() ? simulatedObjectPlayer(o, () => 1 - noise() / 50, chosenPart()) : await getCamera();
  } catch (err) {
    setStatus("Camera did not start: " + (err as Error).message + ". Tick 'Simulated player' to try without one.");
    $<HTMLButtonElement>("start").disabled = false;
    return;
  }
  const part = chosenPart();
  const partName = BODY_PARTS[part].label.toLowerCase();
  setStatus(part === "body" ? o.hint : `Move your ${partName} like the ${o.name}.`);
  await countdown(3);
  playing = true;
  // Keep a cutout of the chosen part from every frame, for the replay.
  const cutouts: Cutout[] = [];
  player.setCapture?.((f) => {
    const image = cutFrame(f.source, f.width, f.height, f.landmarks, part, f.mask);
    if (image) cutouts.push({ clipMs: f.clipMs, image });
  });
  const round = await playObjectRound(o, player, (f) => {
    lastPlayer = { pose: f.player, aspect: f.playerAspect };
    clipNowMs = Math.max(0, f.clipMs);
  }, part);
  player.setCapture?.(null);
  playing = false;
  (window as any).__jesterLastRound = { result: round.result, frameCount: round.frames.length, cutouts: cutouts.length };
  showObjectResults(round.result, o);
  await showReveal(o, cutouts, round.result.lagMs, partName);
  $<HTMLButtonElement>("start").disabled = false;
}

/** Replay the clip with the player's cutout where the object was, recorded to a downloadable video. */
async function showReveal(o: ObjectClip, cutouts: Cutout[], lagMs: number, partName: string) {
  const canvas = $<HTMLCanvasElement>("revealCanvas");
  const video = $<HTMLVideoElement>("revealVideo");
  const link = $<HTMLAnchorElement>("revealDownload");
  if (cutouts.length === 0) { $("reveal").classList.add("hidden"); return; }
  $("reveal").classList.remove("hidden");
  $("revealTitle").textContent = `Replay: your ${partName} as the ${o.name}`;
  canvas.height = Math.round(canvas.width * (o.height / o.width));
  canvas.classList.remove("hidden"); video.classList.add("hidden"); link.classList.add("hidden");
  setStatus("Making your replay...");
  const ctx = canvas.getContext("2d")!;
  const url = await recordReveal({
    canvas, durationMs: o.durationMs, layers: [{ cutouts, lagMs, boxAt: o.boxAt, kind: "thing" }],
    // The clip without the player: here a drawn scene with a faint ghost of the object so the match shows.
    drawBackground: (_ctx, ms) => {
      ctx.globalAlpha = 1; drawObject(canvas, null, o.name);
      ctx.globalAlpha = 0.3; drawObject(canvas, o.boxAt(ms), o.name);
      ctx.globalAlpha = 1;
    },
  });
  (window as any).__jesterLastReveal = url;
  if (url) {
    video.src = url; video.classList.remove("hidden"); canvas.classList.add("hidden");
    // Recorded WebM has no length in its header, so the seek bar is dead until the browser scans to the
    // end once. Jump far ahead, then back to the start.
    video.addEventListener("loadedmetadata", () => {
      if (video.duration !== Infinity) return;
      video.currentTime = 1e9;
      video.addEventListener("timeupdate", () => { video.currentTime = 0; }, { once: true });
    }, { once: true });
    link.href = url; link.classList.remove("hidden");
    setStatus("Replay ready.");
  } else {
    setStatus("Replay shown; this browser cannot record it to a file.");
  }
}

async function getCamera(): Promise<Player> {
  if (!camera) {
    setStatus("Starting the camera and pose tracker...");
    camera = await cameraPlayer(cam);
  }
  return camera;
}

$("start").addEventListener("click", async () => {
  if (objClip && !playing) return startObjectRound(objClip);
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

$("again-solo").addEventListener("click", () => $("start").click());

function playerSideLabel(limb: string): string {
  const label = LIMBS[limb]?.label ?? limb;
  return label.replace(/\b(left|right)\b/g, (m) => (m === "left" ? "right" : "left"));
}

function placementText(r: PoseRoundResult): string {
  const pl = r.placement;
  const missed = { sideways: "the clip's sideways steps", "up-down": "the clip's dips and rises", distance: "the clip's moves toward and away from the camera" } as const;
  const moves = pl.used
    ? `Moving with the clip: ${Math.round(pl.gain * 100)} (counts 25%).${pl.gain < 0.8 && pl.worst ? ` Follow ${missed[pl.worst]}.` : ""}`
    : "Moving with the clip: not scored (this clip stays in place).";
  if (pl.outlineFit === null) return moves;
  const hints = [
    pl.outlineHints.distance === "closer" ? "step closer" : pl.outlineHints.distance === "back" ? "step back" : "",
    pl.outlineHints.side ? `move to your ${pl.outlineHints.side}` : "",
  ].filter(Boolean);
  return `${moves} Outline fit: ${pl.outlineFit} (not scored)${hints.length ? `: ${hints.join(" and ")} to line up with the clip` : ""}.`;
}

/** "left thigh, right thigh and left shin", from the player's own side; all four leg parts read as "legs". */
function listLabels(limbs: string[]): string {
  const legs = ["leftThigh", "rightThigh", "leftShin", "rightShin"];
  if (legs.every((l) => limbs.includes(l)) && limbs.every((l) => legs.includes(l))) return "legs";
  const labels = limbs.map(playerSideLabel);
  return labels.length < 2 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

const EVENT_WORDS: Record<string, [string, string]> = {
  jump: ["jump", "jumps"], crouch: ["duck", "ducks"], moveLeft: ["move left", "moves left"], moveRight: ["move right", "moves right"],
};

function showObjectResults(r: TrajectoryRoundResult, o: ObjectClip) {
  $("results").classList.remove("hidden");
  $("live").textContent = "";
  $("limbs").innerHTML = "";
  $("placement").textContent = "";
  if (r.score == null) {
    $("score").textContent = "No score";
    $("tier").textContent = "";
    $("summary").textContent = r.failure === "low-tracking"
      ? "The camera lost you for too much of the round. Step back so your upper body is in view, and try again."
      : `The ${o.name} hardly moves, so there is nothing to copy.`;
    setStatus("Round over.");
    return;
  }
  $("score").textContent = String(r.score);
  $("tier").textContent = r.tier ?? "";
  // Which of the object's moves the player caught, by kind.
  const byType = new Map<string, { hit: number; all: number }>();
  for (const m of r.matches) {
    const e = byType.get(m.type) ?? { hit: 0, all: 0 };
    e.all++; if (m.playerFrame !== null) e.hit++;
    byType.set(m.type, e);
  }
  const caught = [...byType].map(([t, e]) => `${e.hit} of ${e.all} ${EVENT_WORDS[t]![e.all === 1 ? 0 : 1]}`);
  const parts = [
    caught.length ? `You caught ${caught.join(", ")}.` : "",
    r.activity < 0.6 ? "Move bigger: step and bounce with your whole body, not just your arms." : "",
    r.score >= 35 ? (r.lagMs > 0 ? `You were ${Math.round(r.lagMs)} ms behind.` : "You were right on time.") : "",
  ].filter(Boolean);
  $("summary").textContent = `Copying the ${o.name}. ${parts.join(" ")}`;
  setStatus(`Round over. Scorer ${r.scorerVersion}.`);
}

function showResults(r: PoseRoundResult) {
  $("reveal").classList.add("hidden");
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
  // Below this score the player barely followed the clip, so the measured lag means nothing.
  const lagMeaningful = r.score >= 35;
  const lag = !lagMeaningful ? "" : r.lagMs > 0 ? `You were ${Math.round(r.lagMs)} ms behind.` : r.lagMs < 0 ? `You were ${Math.round(-r.lagMs)} ms ahead.` : "You were right on time.";
  const how = (d: string) => (d === "angle" ? "at the wrong angle" : "too " + d);
  const worst = !r.worstLimb ? ""
    : r.worstLimb.direction === "unseen"
      ? ` The camera could not see your ${r.worstLimb.label} while the clip moved it, so those moves counted as misses. Step back so your whole body is in view.`
      : ` Work on ${r.worstLimb.label}: mostly ${how(r.worstLimb.direction)}.`;
  $("placement").textContent = placementText(r);
  const capped = r.hiddenLimbs.length > 0
    ? `Capped at 50: the camera could not see your ${listLabels(r.hiddenLimbs)} for most of the moves that used them. Step back so your whole body is in view. `
    : "";
  $("summary").textContent = `${capped}${lag}${capped ? "" : worst}`.trim();
  const rows = Object.entries(r.perLimb)
    .sort((a, b) => a[1].credit - b[1].credit)
    // Limb keys use the performer's sides; the player copies as a mirror, so name rows from the player's own side.
    .map(([name, l]) => {
      const notSeen = l.unseenShare >= 0.1 ? ` <small>(not in view ${Math.round(l.unseenShare * 100)}% of the time)</small>` : "";
      return `<tr><td>${playerSideLabel(name)}</td><td><span class="bar" style="width:${Math.round(l.credit * 120)}px"></span></td><td>${Math.round(l.credit * 100)}%${notSeen}</td></tr>`;
    });
  $("limbs").innerHTML = rows.join("");
  setStatus(`Round over. Scorer ${r.scorerVersion}.`);
}

// ---- Render loop ----

function render() {
  requestAnimationFrame(render);
  // Solo practice draws its own two canvases only while it is open; the game draws its own screens.
  if (!document.body.classList.contains("solo")) return;
  if (objClip) drawObject(clipCanvas, objClip.boxAt(playing ? clipNowMs : 0), objClip.name);
  else if (clip) {
    const ms = clip.videoUrl ? clipVideo.currentTime * 1000 : playing ? clipNowMs : 0;
    drawFrame(clipCanvas, clip.videoUrl ? clipVideo : null, clipPoseAt(ms));
  }
  fitCanvas(playerCanvas, lastPlayer.aspect);
  // The player sees themself as in a mirror.
  drawFrame(playerCanvas, simMode() ? null : cam, lastPlayer.pose, { mirror: true, color: "#6fd3ff" });
}
requestAnimationFrame(render);

// ---- The game ----

// The game (blind mode, app/src/ui/game.ts on Alex's blind.ts) is the main path; solo practice above sits
// behind "Practice alone" on the start screen.
initGame({ simMode, noise, getCamera, clipVideo, cam });
