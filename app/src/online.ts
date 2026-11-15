// Room page: join by code, the host starts, everyone plays the same clip at the same moment with
// their camera, then standings and a reveal with every player in one frame.
// Uses Room (spikes/pose-match/rooms.mjs). The connection here is BroadcastChannel, so two tabs of one
// browser can play; a hosted transport (send/onMessage/close) is the only thing different laptops need.

import { Room, broadcastChannelTransport, makeRoomCode, normalizeCode } from "../../spikes/pose-match/rooms.mjs";
import { deserializeTimeline } from "../../spikes/pose-match/serialize.mjs";
import { PLAYER_COLORS } from "../../spikes/pose-match/reveal.mjs";
import { sampleAt } from "../../spikes/pose-match/synthetic.mjs";
import type { Guide } from "../../clip/src/types.ts";
import { starterClip } from "./clip.ts";
import { cameraPlayer, playRound, simulatedPlayer, type Player } from "./round.ts";
import { recordingPlayer } from "./recording.ts";
import { drawFrame, fitCanvas } from "./draw.ts";
import { drawReveal, type RevealRole } from "./composite.ts";
import { escapeHtml, safeColor } from "./escape.ts";
import { hostedTransportFromEnv } from "./supabaseTransport.ts";
import { Calibrator } from "../../spikes/pose-match/calibration.mjs";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const clip = starterClip();
const clipAspect = clip.width / clip.height;
const me = "p" + Math.random().toString(36).slice(2, 6);
const clipCanvas = $<HTMLCanvasElement>("clipCanvas"), playerCanvas = $<HTMLCanvasElement>("playerCanvas"), revealCanvas = $<HTMLCanvasElement>("revealCanvas");

type Standing = { id: string; name: string; score: number | null; timeline: unknown; sittingOut?: boolean };

let room: InstanceType<typeof Room> | null = null;
let player: Player | null = null;
let playing = false;
let revealTimer = 0;
let revealedRound = -1;
const calibrator = new Calibrator();

const simulated = () => $<HTMLInputElement>("sim").checked;
const status = (t: string) => { $("status").textContent = t; };
const clipPoseAt = (ms: number) => (sampleAt(clip.samples, Math.max(0, ms) / 1000)?.landmarks ?? null) as never;

async function getPlayer(): Promise<Player> {
  if ($<HTMLInputElement>("sim").checked) return simulatedPlayer(clip, () => 10);
  return cameraPlayer($<HTMLVideoElement>("cam"));
}

/** While waiting (not playing), run the tracker with a sink that only checks that your whole body is in frame. */
function startLobbyTracking() {
  const el = $("calib");
  if (!player) return;
  if (simulated()) { el.textContent = ""; room?.setReady(true); return; }
  calibrator.reset();
  room?.setReady(false);
  let notInView = 0;
  player.start((f) => {
    const r = calibrator.update(f.landmarks as never, 30);
    notInView = r.ok ? 0 : notInView + 1;
    if (notInView >= 15) { calibrator.reset(); notInView = 0; } // moved out of view: hold the pose again
    room?.setReady(calibrator.passed);                          // tells the room; the host cannot start until all are ready
    el.textContent = calibrator.passed ? "Ready: your whole body is in view." : r.message;
  }, () => -1);
}

async function enter(rawCode: string) {
  const code = normalizeCode(rawCode);
  if (code.length !== 4) return status("A room code is 4 letters.");
  status("Starting the camera...");
  try { player = await getPlayer(); }
  catch (err) { return status("Camera did not start: " + (err as Error).message + ". Tick 'Simulated player' to try without one."); }
  const name = $<HTMLInputElement>("name").value || me;
  const hosted = hostedTransportFromEnv(code);
  room = new Room({ transport: hosted ?? broadcastChannelTransport(code), code, playerId: me, name });
  (window as unknown as { __room?: unknown }).__room = room; // for checking in the console
  room.on("update", render);
  room.on("start", onStart);
  room.join();
  $("lobby").classList.remove("hidden");
  $("stage").classList.remove("hidden");
  $("roomCode").textContent = code;
  status("In room " + code + (hosted ? " (online)" : " (this browser only)") + ". Wait for the host to start.");
  fitCanvas(clipCanvas, clipAspect); fitCanvas(playerCanvas, clipAspect);
  drawFrame(clipCanvas, null, clipPoseAt(0));
  render();
  startLobbyTracking();
  // Live preview of yourself while you wait, so you can check you are in frame.
  const preview = () => {
    if (!playing && !simulated()) drawFrame(playerCanvas, $<HTMLVideoElement>("cam"), null, { mirror: true });
    requestAnimationFrame(preview);
  };
  preview();
}

function render() {
  if (!room) return;
  $("role").textContent = room.isHost ? "(you are the host)" : "";
  $<HTMLButtonElement>("start").disabled = !room.isHost || playing || !room.allReady;
  $("roster").innerHTML = room.roster().map((p: { id: string; name: string; ready?: boolean }) => `<li>${escapeHtml(p.name)}${p.id === room!.hostId ? " (host)" : ""}${p.id === me ? " (you)" : ""} ${(p as { ready?: boolean }).ready ? "&#10003; ready" : "(not in view yet)"}</li>`).join("");
  $("standings").innerHTML = (room.standings() as Standing[]).map((r) => `<li>${escapeHtml(r.name)}: ${r.sittingOut ? "joined late, plays the next round" : escapeHtml(r.score ?? "playing...")}</li>`).join("");
  const waiting = (room.standings() as Standing[]).filter((r) => r.score === null && !r.sittingOut).map((r) => r.name);
  const notReady = (room.roster() as { name: string; ready?: boolean }[]).filter((p) => !p.ready).map((p) => p.name);
  if ((!room.round || room.allDone) && room.isHost && notReady.length) status("Waiting for " + notReady.join(", ") + " to get their whole body in view before you can start.");
  else if (room.round && !playing && waiting.length && waiting.length < room.roster().length) status("Waiting for " + waiting.join(", ") + " to finish...");
  else if (room.round && room.allDone && !playing) status("Everyone finished. Standings and reveal are below.");
  else if (!room.round && !room.isHost) status("In the room. Waiting for the host (" + room.roster().find((p: { id: string }) => p.id === room!.hostId)?.name + ") to start.");
  if (room.round && room.allDone && room.round.roundNo !== revealedRound && !playing) showReveal();
}

async function onStart(round: { clipId: string; startAt: number; roundNo: number }) {
  cancelAnimationFrame(revealTimer);
  $("results").classList.add("hidden");
  const el = $("countdown");
  el.classList.remove("hidden");
  while (Date.now() < round.startAt) {
    el.textContent = String(Math.max(1, Math.ceil((round.startAt - Date.now()) / 1000)));
    await new Promise((r) => setTimeout(r, 100));
  }
  el.classList.add("hidden");
  player!.stop(); // stop the lobby check; the round starts its own tracking
  playing = true; render();
  status("Go! Copy the clip as if it were a mirror.");
  const rec = recordingPlayer(player!);
  const result = await playRound(clip, null, rec, (f) => {
    drawFrame(clipCanvas, null, clipPoseAt(f.clipMs));
    drawFrame(playerCanvas, simulated() ? null : $<HTMLVideoElement>("cam"), f.player as never, { mirror: true, color: "#4cc9f0" });
  });
  playing = false;
  startLobbyTracking();
  room!.submitResult({ score: result.result.score ?? 0, timeline: rec.compact(clip.durationMs), extra: null });
  status(result.result.score == null ? "Tracking was too poor to score. Stand back so your whole body is in view." : "Your score: " + result.result.score + ". Waiting for the others...");
  render();
}

function showReveal() {
  if (!room?.round) return;
  revealedRound = room.round.roundNo;
  $("results").classList.remove("hidden");
  const rows = (room.standings() as Standing[]).filter((r) => r.timeline);
  // Everyone plays the starter clip's one character; spreadX stands the players side by side.
  const guide = { timeline: clip.timeline, range: { startMs: 0, endMs: clip.durationMs } } as unknown as Guide;
  const roles: RevealRole[] = rows.map((r) => ({ name: r.name, score: r.score, guide, timeline: deserializeTimeline(r.timeline) as never }));
  $("legend").innerHTML = roles.map((r, i) => `<li style="color:${safeColor(PLAYER_COLORS[i % PLAYER_COLORS.length])}">${escapeHtml(r.name)}: ${escapeHtml(r.score)}</li>`).join("");
  const started = performance.now();
  const tick = () => {
    const t = (performance.now() - started) % Math.max(1, clip.durationMs);
    drawReveal(revealCanvas, roles, t, { clipAspect, spreadX: roles.length > 1 ? 0.35 : 0 });
    revealTimer = requestAnimationFrame(tick);
  };
  tick();
}

$("create").addEventListener("click", () => enter(makeRoomCode()));
$("enter").addEventListener("click", () => enter($<HTMLInputElement>("code").value));
$("start").addEventListener("click", () => { try { room!.start("starter", 3000); } catch (e) { status((e as Error).message); } });
$("again").addEventListener("click", () => $("start").click());
