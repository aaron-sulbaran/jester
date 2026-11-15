// Play with friends online, in the main game's look: make a room or join one by its 4-letter code, see who is
// in, and the host deals the parts. Each player then plays their own part on their own device (game.ts runs
// the round: no "pass the laptop"). The room itself is spikes/pose-match/rooms.mjs over the hosted connection.

import { Room, broadcastChannelTransport, makeRoomCode, normalizeCode } from "../../../spikes/pose-match/rooms.mjs";
import { hostDeal } from "../onlineBlind.ts";
import { demoScene, dribbleScene } from "../blind.ts";
import { hostedTransportFromEnv } from "../supabaseTransport.ts";
import { escapeHtml } from "../escape.ts";

export const ONLINE_SCENES = { dribble: dribbleScene, demo: demoScene } as const;
export type OnlineSceneId = keyof typeof ONLINE_SCENES;
export type LobbyRoom = InstanceType<typeof Room>;
export interface OnlineRound { clipId: string; startAt: number; roundNo: number; extra?: { assign?: Record<string, number>; speed?: number } }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function initRoomLobby(hooks: { show(): void; goHome(): void; onRound(room: LobbyRoom, round: OnlineRound): void }) {
  let room: LobbyRoom | null = null;
  const me = "p" + Math.random().toString(36).slice(2, 7);

  const problem = (text: string) => { const el = $("roomProblem"); el.textContent = text; el.hidden = !text; };

  function render() {
    if (!room) return;
    const roster = room.roster() as { id: string; name: string }[];
    $("roomRoster").innerHTML = roster.map((p) => `<li>${escapeHtml(p.name)}${p.id === room!.hostId ? " (host)" : ""}${p.id === me ? " (you)" : ""}</li>`).join("");
    const host = room.isHost as boolean;
    $("roomHostRow").hidden = !host;
    $("roomGuestRow").hidden = host;
    $<HTMLButtonElement>("roomDeal").disabled = !host || roster.length < 2;
    $("roomNeedTwo").hidden = roster.length >= 2;
  }

  function enter(rawCode: string) {
    const code = normalizeCode(rawCode);
    if (code.length !== 4) return problem("A room code is 4 letters.");
    problem("");
    room?.leave();
    const hosted = hostedTransportFromEnv(code);
    const name = $<HTMLInputElement>("roomName").value.trim() || "Player";
    const r = new Room({ transport: hosted ?? broadcastChannelTransport(code), code, playerId: me, name });
    room = r;
    r.on("update", render);
    r.on("start", (round: OnlineRound) => hooks.onRound(r, round));
    r.join();
    $("roomJoin").hidden = true;
    $("roomLobby").hidden = false;
    $("roomCodeText").textContent = code;
    $("roomWhere").textContent = hosted ? "" : "(this browser only: the hosted connection is not set up on this copy)";
    render();
  }

  function leave() {
    room?.leave();
    room = null;
    $("roomJoin").hidden = false;
    $("roomLobby").hidden = true;
    problem("");
  }

  $("playOnline").addEventListener("click", () => { leave(); hooks.show(); });
  $("roomCreate").addEventListener("click", () => enter(makeRoomCode()));
  $("roomEnter").addEventListener("click", () => enter($<HTMLInputElement>("roomCode").value));
  $("roomBack").addEventListener("click", () => { leave(); hooks.goHome(); });
  $("roomDeal").addEventListener("click", () => {
    if (!room) return;
    const id = $<HTMLSelectElement>("roomScene").value as OnlineSceneId;
    hostDeal(room as never, ONLINE_SCENES[id](), id, { speed: 1 });
  });

  return { leave, get room() { return room; } };
}
