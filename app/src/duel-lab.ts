// Duel lab: a plain page to try the competing mode by hand. Make or join a room, the host picks a clip
// and a look, everyone plays, then standings, the reveal and the next round. Elimination drops last
// place each round across successive clips; the last two play best of three.
// One person can test with two tabs: tick "Simulated player" in one of them.

import { Room, broadcastChannelTransport, makeRoomCode, normalizeCode } from "../../spikes/pose-match/rooms.mjs";
import { advance, clockText, FINAL_BEST_OF, startElimination, type Elimination } from "../../clip/src/match.ts";
import { cameraPlayer } from "./round.ts";
import { drawFrame, fitCanvas } from "./draw.ts";
import { hostedTransportFromEnv } from "./supabaseTransport.ts";
import {
  behindLine, drawDuelSubject, duelClips, duelStandings, hostStartDuel, isDuelRound, loadDuelClip, playDuel, playDuelReveal,
  type DuelLook, type DuelPerformer, type DuelRoom,
} from "./onlineDuel.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const me = "p" + Math.random().toString(36).slice(2, 6);
const clipCanvas = $<HTMLCanvasElement>("clipCanvas"), playerCanvas = $<HTMLCanvasElement>("playerCanvas"), revealCanvas = $<HTMLCanvasElement>("revealCanvas");
const cam = $<HTMLVideoElement>("cam"), clipVideo = $<HTMLVideoElement>("clipVideo");

let room: DuelRoom & { isHost: boolean; hostId: string; join(): void } | null = null;
let performer: DuelPerformer | null = null;
let playing = false;
let revealedRound = -1;
let stopReveal: (() => void) | null = null;
let match: Elimination | null = null;

const simulated = () => $<HTMLInputElement>("sim").checked;
const status = (t: string) => { $("status").textContent = t; };
const nameOf = (id: string) => room?.roster().find((p) => p.id === id)?.name ?? id;
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Each clip's length, so the room can close a round's results on time. */
const clipLengths = new Map<string, number>();

async function fillClips() {
  const listed = await duelClips();
  for (const c of listed.data) clipLengths.set(c.id, c.durationMs);
  $<HTMLSelectElement>("clip").innerHTML = listed.data.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.title)} (${clockText(c.durationMs)})</option>`).join("");
  if (listed.error) status(listed.error + " The built in starter dance still works.");
}

async function enter(rawCode: string) {
  const code = normalizeCode(rawCode);
  if (code.length !== 4) return status("A room code is 4 letters.");
  if (simulated()) performer = { kind: "simulated", noiseDegrees: 12 };
  else {
    status("Starting the camera...");
    try { performer = { kind: "camera", player: await cameraPlayer(cam) }; }
    catch (err) { return status("The camera did not start (" + (err as Error).message + "). Tick Simulated player to try without one."); }
  }
  const name = $<HTMLInputElement>("name").value.trim() || (simulated() ? "Sim " : "Player ") + me.slice(1);
  const hosted = hostedTransportFromEnv(code);
  room = new Room({ transport: hosted ?? broadcastChannelTransport(code), code, playerId: me, name }) as unknown as NonNullable<typeof room>;
  (window as unknown as { __room?: unknown }).__room = room;
  room.on("update", render);
  room.on("start", () => void onStart());
  room.join();
  $("join").classList.add("hidden");
  $("lobby").classList.remove("hidden");
  $("stage").classList.remove("hidden");
  $("roomCode").textContent = code;
  $("where").textContent = hosted ? "online: any laptop can join with the code" : "this browser only: open another tab to join";
  status("In room " + code + ". " + (room.isHost ? "You are the host: pick a clip and press Start round." : "Waiting for the host to start."));
  await fillClips();
  render();
  const preview = () => {
    if (!playing && performer?.kind === "camera" && cam.videoWidth) { fitCanvas(playerCanvas, cam.videoWidth / cam.videoHeight); drawFrame(playerCanvas, cam, null, { mirror: true }); }
    requestAnimationFrame(preview);
  };
  preview();
}

function render() {
  if (!room) return;
  const alive = isDuelRound(room.round) ? room.round.extra.alive : null;
  $("roster").innerHTML = room.roster().map((p) => {
    const tags = [p.id === room!.hostId ? "host" : "", p.id === me ? "you" : "", alive && !alive.includes(p.id) ? "out" : ""].filter(Boolean);
    return `<li>${escapeHtml(p.name)}${tags.length ? ` (${tags.join(", ")})` : ""}</li>`;
  }).join("");
  $("hostControls").classList.toggle("hidden", !room.isHost);
  $<HTMLButtonElement>("start").disabled = playing || (!!room.round && !room.allDone);
  $("elimLine").textContent = elimText();

  if (!room.round) return;
  const table = duelStandings(room);
  $("roundNo").textContent = String(room.round.roundNo);
  $("standings").innerHTML = table.ranked.map((r) => `<tr><td>${r.place}</td><td>${escapeHtml(r.name)}${r.id === me ? " (you)" : ""}</td><td>${r.score ?? "no score"}</td><td>${r.lagMs === null ? "" : Math.abs(r.lagMs) <= 40 ? "on the beat" : `${Math.abs(r.lagMs)} ms ${r.lagMs > 0 ? "behind" : "ahead"}`}</td></tr>`).join("")
    + table.waiting.map((n) => `<tr><td></td><td>${escapeHtml(n)}</td><td>playing...</td><td></td></tr>`).join("");
  if (!playing && table.waiting.length && table.waiting.length < room.roster().length) status("Waiting for " + table.waiting.join(", ") + " to finish...");
  if (room.allDone && !playing && room.round.roundNo !== revealedRound) void showResults();
}

function elimText(): string {
  if (!room) return "";
  if (match?.winner) return `${nameOf(match.winner)} wins the match.`;
  if (match && match.alive.length === 2 && match.finalRounds.length) {
    return `Final, best of ${FINAL_BEST_OF}: ${match.alive.map((id) => `${nameOf(id)} ${lastWins[id] ?? 0}`).join(", ")}.`;
  }
  if (match) return `Elimination: ${match.alive.map(nameOf).join(", ")} still in.` + (match.out.length ? ` Out: ${match.out.map(nameOf).join(", ")}.` : "");
  const alive = isDuelRound(room.round) ? room.round.extra.alive : null;
  return alive ? `Still in: ${alive.map(nameOf).join(", ")}.` : "";
}

let lastWins: Record<string, number> = {};
let replayNext = false;

async function onStart() {
  if (!room || !performer || !isDuelRound(room.round)) return;
  stopReveal?.(); stopReveal = null;
  $("results").classList.add("hidden");
  $("behind").textContent = "";
  playing = true; render();
  const look = room.round.extra.look as DuelLook;
  // A fresh wobble each round so two simulated players do not tie.
  if (performer.kind === "simulated") performer = { kind: "simulated", noiseDegrees: 8 + Math.random() * 22 };
  const outcome = await playDuel(room, performer, clipVideo, {
    onStatus: (t) => { if (/^\D*\d+$/.test(t)) { $("countdown").textContent = t; } else { $("countdown").textContent = ""; status(t); } },
    onFrame: (f) => {
      fitCanvas(clipCanvas, f.clip.aspect);
      drawDuelSubject(clipCanvas, f.clip, look, f.phase, f.mediaMs);
      if (f.phase === "watch") return;
      if (performer?.kind === "camera") { fitCanvas(playerCanvas, cam.videoWidth / (cam.videoHeight || 1) || 4 / 3); drawFrame(playerCanvas, cam, f.player, { mirror: true, color: "#4cc9f0" }); }
      else { fitCanvas(playerCanvas, f.clip.aspect); drawFrame(playerCanvas, null, f.player, { mirror: true, color: "#4cc9f0" }); }
    },
  });
  $("countdown").textContent = "";
  playing = false;
  if (outcome.error) status(outcome.error);
  render();
}

async function showResults() {
  if (!room?.round) return;
  revealedRound = room.round.roundNo;
  const table = duelStandings(room);
  $("results").classList.remove("hidden");
  const line = behindLine(table.ranked);
  const top = table.ranked[0];
  const winnerText = top && table.ranked.filter((r) => r.place === 1).length === 1 ? `${top.name} wins round ${room.round.roundNo}.` : "A tie for first.";
  status(winnerText);
  if (room.isHost && match && !match.winner) {
    const step = advance(match, table.ranked);
    match = step.state;
    if (step.final) lastWins = step.final.wins;
    replayNext = step.replay;
    const said = step.replay ? " Tie: this round is played again." : step.dropped.length ? ` ${step.dropped.map(nameOf).join(", ")} ${step.dropped.length > 1 ? "are" : "is"} out.` : "";
    status(winnerText + said + (match.winner ? ` ${nameOf(match.winner)} wins the match!` : ""));
  }
  $("behind").textContent = line ?? "";
  $("next").classList.toggle("hidden", !room.isHost);
  $("next").textContent = match?.winner ? "New match" : "Next round";
  render();
  const loaded = await loadDuelClip(room.round.clipId, clipVideo);
  if (loaded.error !== null) return status(loaded.error);
  fitCanvas(revealCanvas, loaded.data.aspect);
  stopReveal?.();
  stopReveal = playDuelReveal(revealCanvas, loaded.data, table.ranked);
}

function startRound() {
  if (!room?.isHost) return;
  const elimination = $<HTMLInputElement>("elim").checked;
  if (!elimination) match = null;
  else if (!match || match.winner) { match = startElimination(room.roster().map((p) => p.id)); lastWins = {}; }
  if (match?.winner) return;
  try { hostStartDuel(room, $<HTMLSelectElement>("clip").value, $<HTMLSelectElement>("look").value as DuelLook, { alive: match ? match.alive : null, durationMs: clipLengths.get($<HTMLSelectElement>("clip").value) ?? null }); }
  catch (e) { status((e as Error).message); }
}

$("create").addEventListener("click", () => void enter(makeRoomCode()));
$("enter").addEventListener("click", () => void enter($<HTMLInputElement>("code").value));
$("start").addEventListener("click", startRound);
$("next").addEventListener("click", () => {
  const select = $<HTMLSelectElement>("clip");
  // Elimination moves on to the next clip each round (unless the round is being replayed after a tie).
  if (match && !match.winner && !replayNext && select.options.length > 1) select.selectedIndex = (select.selectedIndex + 1) % select.options.length;
  if (match?.winner) match = null;
  startRound();
});
