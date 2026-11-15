// The eval lab (dev server only): play one tagged round at a time against a bank clip or the starter dance.
// The round log (app/round-log-plugin.ts) saves every round; this page only picks the clip and the tag,
// plays, and shows the score and the record id.

import { sampleAt } from "../../spikes/pose-match/synthetic.mjs";
import type { LandmarkObject, PoseRoundResult, TrajectoryRoundResult } from "../../engine/src/index.ts";
import type { Guide } from "../../clip/src/index.ts";
import { DEV_TAGS, isDevTag, type DevTag } from "../../eval/src/record.ts";
import { starterClip, thingObjectClip, type Clip } from "./clip.ts";
import { listBank, loadBankGuides, type BankClip } from "./bank.ts";
import { bankSoloClip } from "./bankRound.ts";
import { cameraPlayer, playObjectRound, playRound, simulatedPlayer, type LiveFrame, type Player } from "./round.ts";
import { simulatedObjectPlayer, type ObjectClip } from "./objectClips.ts";
import { drawFrame, drawObject, fitCanvas } from "./draw.ts";
import { TAG_HINTS, setNextTag } from "./dev/devPanel.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const clipSelect = $<HTMLSelectElement>("clip");
const subjectSelect = $<HTMLSelectElement>("subject");
const clipVideo = $<HTMLVideoElement>("clipVideo");
const cam = $<HTMLVideoElement>("cam");
const clipCanvas = $<HTMLCanvasElement>("clipCanvas");
const playerCanvas = $<HTMLCanvasElement>("playerCanvas");
const status = (t: string) => { $("status").textContent = t; };
const simulated = () => $<HTMLInputElement>("sim").checked;

const starter = starterClip();
let bank: BankClip[] = [];
let guides: Guide[] = [];
let camera: Player | null = null;
let playing = false;
let lastPose: LandmarkObject[] | null = null;
const pendingRows: HTMLTableCellElement[] = [];

// ---- Tags ----

$("tags").innerHTML = [`<label><input type="radio" name="tag" value="" checked /> nothing special</label>`, ...DEV_TAGS.map((t) => `<label><input type="radio" name="tag" value="${t}" /> ${t}</label>`)].join("");
const chosenTag = (): DevTag | null => {
  const v = document.querySelector<HTMLInputElement>('input[name="tag"]:checked')?.value;
  return isDevTag(v) ? v : null;
};
const showHint = () => {
  const t = chosenTag();
  $("tagHint").textContent = t ? `On purpose: ${TAG_HINTS[t]}.` : "Pick what you will do on purpose, so this round becomes a test case.";
};
$("tags").addEventListener("change", showHint);
showHint();
$("sim").addEventListener("change", () => $("simSeatedWrap").classList.toggle("hidden", !simulated()));

// ---- Clips ----

async function loadBank() {
  const listed = await listBank();
  if (listed.error !== null) { $("bankNote").textContent = listed.error + " The starter dance works without it."; return; }
  bank = listed.data;
  for (const c of bank) clipSelect.add(new Option(`${c.title} (${Math.round(c.durationMs / 1000)} s)`, c.id));
  $("bankNote").textContent = bank.length ? `${bank.length} bank clips.` : "The bank has no clips yet (add some in /bank-lab.html). The starter dance works now.";
}

async function pickClip() {
  subjectSelect.innerHTML = "";
  guides = [];
  const c = bank.find((b) => b.id === clipSelect.value);
  if (!c) {
    subjectSelect.add(new Option("the dancer", "0"));
    showStill();
    return;
  }
  status("Loading the moves for this clip...");
  const loaded = await loadBankGuides(c);
  if (loaded.error !== null) { status(loaded.error); return; }
  guides = loaded.data;
  guides.forEach((g, i) => subjectSelect.add(new Option(`${g.subject.label} (${g.subject.kind})`, String(i))));
  status("");
  showStill();
}

function showStill() {
  const g = guides[Number(subjectSelect.value)];
  clipVideo.classList.add("hidden");
  clipCanvas.classList.remove("hidden");
  if (!g) {
    fitCanvas(clipCanvas, starter.width / starter.height);
    drawFrame(clipCanvas, null, (sampleAt(starter.samples, 0)?.landmarks ?? null) as LandmarkObject[] | null);
    return;
  }
  fitCanvas(clipCanvas, g.source.width / g.source.height);
  if (g.subject.kind === "thing") drawObject(clipCanvas, g.boxTrack.frames.find((f) => f.box)?.box ?? null, g.subject.label);
  else drawFrame(clipCanvas, null, (g.timeline?.frames.find((f) => f.landmarks)?.landmarks?.map(([x, y, visibility]) => ({ x, y, visibility })) ?? null));
}

clipSelect.addEventListener("change", () => void pickClip());
subjectSelect.addEventListener("change", showStill);

// ---- Playing ----

async function getCamera(): Promise<Player> {
  if (!camera) {
    status("Starting the camera and pose tracker...");
    camera = await cameraPlayer(cam);
    const preview = () => {
      if (!playing) drawFrame(playerCanvas, cam, null, { mirror: true });
      requestAnimationFrame(preview);
    };
    preview();
  }
  return camera;
}

async function countdown(n: number) {
  const el = $("countdown");
  el.classList.remove("hidden");
  for (let i = n; i > 0; i--) { el.textContent = String(i); await new Promise((r) => setTimeout(r, 1000)); }
  el.classList.add("hidden");
}

function onLive(draw: (ms: number) => void) {
  return (f: LiveFrame) => {
    lastPose = f.player;
    fitCanvas(playerCanvas, f.playerAspect);
    drawFrame(playerCanvas, simulated() ? null : cam, lastPose, { mirror: true, color: "#4cc9f0" });
    if (f.clipMs >= 0) draw(f.clipMs);
  };
}

type Played = { result: PoseRoundResult | TrajectoryRoundResult; clipName: string };

async function playOnce(): Promise<Played> {
  const bankClip = bank.find((b) => b.id === clipSelect.value) ?? null;
  const guide = bankClip ? guides[Number(subjectSelect.value)] ?? null : null;
  if (bankClip && !guide) throw new Error("Pick a subject first.");

  if (guide && guide.subject.kind === "thing") {
    const o: ObjectClip = thingObjectClip(guide);
    const player = simulated() ? simulatedObjectPlayer(o, () => 0.9) : await getCamera();
    window.__jesterRoundContext = { bankId: bankClip!.id, title: bankClip!.title, subject: guide.subject.label };
    await countdown(3);
    const round = await playObjectRound(o, player, onLive((ms) => drawObject(clipCanvas, o.boxAt(ms), o.name)));
    return { result: round.result, clipName: `${bankClip!.title}, ${guide.subject.label}` };
  }

  let clip: Clip = starter;
  let video: HTMLVideoElement | null = null;
  if (bankClip && guide) {
    status("Loading the video...");
    const solo = await bankSoloClip(bankClip, guide, clipVideo);
    if (solo.error !== null) throw new Error(solo.error);
    clip = solo.data;
    video = clipVideo;
    clipVideo.classList.remove("hidden");
    clipCanvas.classList.add("hidden");
    window.__jesterRoundContext = { bankId: bankClip.id, title: bankClip.title, subject: guide.subject.label };
  }
  const player = simulated() ? simulatedPlayer(clip, () => 8, $<HTMLInputElement>("simSeated").checked) : await getCamera();
  await countdown(3);
  const draw = (ms: number) => { if (!video) drawFrame(clipCanvas, null, (sampleAt(clip.samples, ms / 1000)?.landmarks ?? null) as LandmarkObject[] | null); };
  const round = await playRound(clip, video, player, onLive(draw));
  return { result: round.result, clipName: bankClip && guide ? `${bankClip.title}, ${guide.subject.label}` : "Starter dance" };
}

function showResult(r: PoseRoundResult | TrajectoryRoundResult) {
  $("score").textContent = r.score === null ? "No score" : String(r.score);
  const parts = [r.tier ?? (r.failure === "low-tracking" ? "low tracking" : r.failure ?? ""), `lag ${Math.round(r.lagMs)} ms`];
  if (r.channel === "pose") {
    if (r.worstLimb) parts.push(`worst: ${r.worstLimb.label} (${r.worstLimb.direction})`);
    if (r.hiddenLimbs.length) parts.push(`out of view: ${r.hiddenLimbs.join(", ")}`);
  }
  $("summary").textContent = parts.filter(Boolean).join(" · ");
}

function addHistory(n: number, clipName: string, tag: DevTag | null, r: PoseRoundResult | TrajectoryRoundResult) {
  const tr = document.createElement("tr");
  for (const text of [String(n), clipName, tag ?? "", r.score === null ? "none" : String(r.score), `${Math.round(r.lagMs)} ms`]) {
    const td = document.createElement("td"); td.textContent = text; tr.appendChild(td);
  }
  const saved = document.createElement("td");
  saved.textContent = "saving...";
  tr.appendChild(saved);
  $("history").prepend(tr);
  pendingRows.push(saved);
  setTimeout(() => {
    if (saved.textContent === "saving...") saved.textContent = "not saved: is this the dev server with the round log on?";
  }, 10000);
}

window.addEventListener("jester-round-saved", (e) => {
  const cell = pendingRows.shift();
  if (cell) cell.textContent = (e as CustomEvent<{ id: string }>).detail.id;
});

let played = 0;
$("start").addEventListener("click", async () => {
  if (playing) return;
  const tag = chosenTag();
  $<HTMLButtonElement>("start").disabled = true;
  try {
    setNextTag(tag, $<HTMLInputElement>("note").value);
    playing = true;
    status(tag ? `Go: ${TAG_HINTS[tag]}.` : "Go!");
    const { result, clipName } = await playOnce();
    playing = false;
    showResult(result);
    addHistory(++played, clipName, tag, result);
    status("Round over. Pick the next tag and press Start.");
    $<HTMLInputElement>("note").value = "";
  } catch (err) {
    setNextTag(null);
    status((err as Error).message);
  } finally {
    playing = false;
    window.__jesterRoundContext = undefined;
    showStill();
    $<HTMLButtonElement>("start").disabled = false;
  }
});

showStill();
void loadBank().then(pickClip);
