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

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const clip = starterClip();
const clipAspect = clip.width / clip.height;
const me = "p" + Math.random().toString(36).slice(2, 6);
const clipCanvas = $<HTMLCanvasElement>("clipCanvas"), playerCanvas = $<HTMLCanvasElement>("playerCanvas"), revealCanvas = $<HTMLCanvasElement>("revealCanvas");

type Standing = { id: string; name: string; score: number | null; timeline: unknown };

let room: InstanceType<typeof Room> | null = null;
let player: Player | null = null;
let playing = false;
let revealTimer = 0;
let revealedRound = -1;

const status = (t: string) => { $("status").textContent = t; };
const clipPoseAt = (ms: number) => (sampleAt(clip.samples, Math.max(0, ms) / 1000)?.landmarks ?? null) as never;

async function getPlayer(): Promise<Player> {
  if ($<HTMLInputElement>("sim").checked) return simulatedPlayer(clip, () => 10);
  return cameraPlayer($<HTMLVideoElement>("cam"));
}

async function enter(rawCode: string) {
  const code = normalizeCode(rawCode);
  if (code.length !== 4) return status("A room code is 4 letters.");
  status("Starting the camera...");
  try { player = await getPlayer(); }
  catch (err) { return status("Camera did not start: " + (err as Error).message + ". Tick 'Simulated player' to try without one."); }
  const name = $<HTMLInputElement>("name").value || me;
  room = new Room({ transport: broadcastChannelTransport(code), code, playerId: me, name });
  room.on("update", render);
  room.on("start", onStart);
  room.join();
  $("lobby").classList.remove("hidden");
  $("stage").classList.remove("hidden");
  $("roomCode").textContent = code;
  status("In room " + code + ". Wait for the host to start.");
  fitCanvas(clipCanvas, clipAspect); fitCanvas(playerCanvas, clipAspect);
  drawFrame(clipCanvas, null, clipPoseAt(0));
  render();
}

function render() {
  if (!room) return;
  $("role").textContent = room.isHost ? "(you are the host)" : "";
  $<HTMLButtonElement>("start").disabled = !room.isHost || playing;
  $("roster").innerHTML = room.roster().map((p: { id: string; name: string }) => `<li>${p.name}${p.id === room!.hostId ? " (host)" : ""}${p.id === me ? " (you)" : ""}</li>`).join("");
  $("standings").innerHTML = (room.standings() as Standing[]).map((r) => `<li>${r.name}: ${r.score ?? "playing..."}</li>`).join("");
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
  playing = true; render();
  status("Go! Copy the clip as if it were a mirror.");
  const rec = recordingPlayer(player!);
  const result = await playRound(clip, null, rec, (f) => {
    drawFrame(clipCanvas, null, clipPoseAt(f.clipMs));
    drawFrame(playerCanvas, null, f.player as never, { mirror: true, color: "#4cc9f0" });
  });
  playing = false;
  room!.submitResult({ score: result.result.score ?? 0, timeline: rec.compact(clip.durationMs) });
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
  $("legend").innerHTML = roles.map((r, i) => `<li style="color:${PLAYER_COLORS[i % PLAYER_COLORS.length]}">${r.name}: ${r.score}</li>`).join("");
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
