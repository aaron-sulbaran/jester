// Play with friends online, in the main game's look: make a room or join one by its 4-letter code, see who is
// in, and the host deals the parts. Each player then plays their own part on their own device (game.ts runs
// the round: no "pass the laptop"). The room itself is spikes/pose-match/rooms.mjs over the hosted connection.

import { Room, broadcastChannelTransport, makeRoomCode, normalizeCode } from "../../../spikes/pose-match/rooms.mjs";
import { hostDeal } from "../onlineBlind.ts";
import { demoScene, dribbleScene, duoScene } from "../blind.ts";
import { hostedTransportFromEnv } from "../supabaseTransport.ts";
import { escapeHtml } from "../escape.ts";
import { listBank, type BankClip } from "../bank.ts";
import { videoScene, type Scene } from "../blind.ts";
import { bankSceneId, packScene, sceneFromBank, setHostUpload, UPLOAD_ID } from "../onlineClip.ts";

export const ONLINE_SCENES = { duo: duoScene, dribble: dribbleScene, demo: demoScene } as const;
export type OnlineSceneId = keyof typeof ONLINE_SCENES;
export type LobbyRoom = InstanceType<typeof Room>;
export interface OnlineRound { clipId: string; startAt: number; roundNo: number; extra?: { assign?: Record<string, number>; speed?: number } }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function initRoomLobby(hooks: { show(): void; goHome(): void; onRound(room: LobbyRoom, round: OnlineRound): void; clipVideo: HTMLVideoElement }) {
  let room: LobbyRoom | null = null;
  const me = "p" + Math.random().toString(36).slice(2, 7);

  // The clip cards: pick one (remembered for next time), or "Surprise me" for a random one.
  const KEY = "jester.onlineMode";
  const modes = [...document.querySelectorAll<HTMLButtonElement>("#roomModes .mode")];
  const pickMode = (id: string, remember = true) => {
    for (const m of modes) m.setAttribute("aria-checked", String(m.dataset.scene === id));
    if (remember) { try { localStorage.setItem(KEY, id); } catch { /* private mode: it just will not be remembered */ } }
  };
  let saved: string | null = null;
  try { saved = localStorage.getItem(KEY); } catch { /* ignore */ }
  pickMode(modes.some((m) => m.dataset.scene === saved) ? saved! : "duo", false);
  modes.forEach((m) => m.addEventListener("click", () => pickMode(m.dataset.scene!)));
  const chosenScene = (): string => {
    const id = modes.find((m) => m.getAttribute("aria-checked") === "true")?.dataset.scene ?? "duo";
    const ids = Object.keys(ONLINE_SCENES) as OnlineSceneId[];
    return id === "surprise" ? ids[Math.floor(Math.random() * ids.length)]! : id;
  };

  // Video bank: the host picks a clip; every device loads it from the bank. Upload: the host reads their own file.
  const bankSelect = $<HTMLSelectElement>("roomBankSelect");
  const uploadInput = $<HTMLInputElement>("roomUploadFile");
  const uploadStatus = $("roomUploadStatus");
  let bank: BankClip[] = [];
  let uploaded: Scene | null = null;
  const syncClipRows = () => {
    const id = modes.find((m) => m.getAttribute("aria-checked") === "true")?.dataset.scene;
    $("roomBankRow").hidden = id !== "bank";
    $("roomUploadRow").hidden = id !== "upload";
    updateDeal();
  };
  modes.forEach((m) => m.addEventListener("click", syncClipRows));
  void listBank().then((r) => {
    bank = r.data ?? [];
    bankSelect.innerHTML = bank.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.title)}</option>`).join("");
    const card = modes.find((m) => m.dataset.scene === "bank");
    if (card) card.hidden = bank.length === 0;
  });
  uploadInput.addEventListener("change", async () => {
    const file = uploadInput.files?.[0];
    uploaded = null; setHostUpload(null);
    if (!file) return updateDeal();
    uploadStatus.textContent = "Finding everyone in your clip...";
    updateDeal();
    try {
      const s = await videoScene(file, hooks.clipVideo, (share) => { uploadStatus.textContent = `Reading your clip... ${Math.round(share * 100)}%`; });
      if (typeof s === "string") { uploadStatus.textContent = s; }
      else {
        const packed = packScene(s);
        if (packed.error !== null) { uploadStatus.textContent = packed.error; }
        else { uploaded = s; setHostUpload(s); uploadStatus.textContent = `Ready: ${s.name}, ${(s.durationMs / 1000).toFixed(0)} s, ${s.guides.length} part${s.guides.length === 1 ? "" : "s"}. Your friends see the shapes, not your video.`; }
      }
    } catch (err) {
      uploadStatus.textContent = "Could not read that clip: " + (err as Error).message;
    }
    updateDeal();
  });

  const problem = (text: string) => { const el = $("roomProblem"); el.textContent = text; el.hidden = !text; };

  function render() {
    if (!room) return;
    const roster = room.roster() as { id: string; name: string }[];
    $("roomRoster").innerHTML = roster.map((p) => `<li>${escapeHtml(p.name)}${p.id === room!.hostId ? " (host)" : ""}${p.id === me ? " (you)" : ""}</li>`).join("");
    const host = room.isHost as boolean;
    $("roomHostRow").hidden = !host;
    $("roomGuestRow").hidden = host;
    $("roomNeedTwo").hidden = roster.length >= 2;
    updateDeal();
  }

  /** The Deal button needs a second player, and for an upload, a clip that has been read. */
  function updateDeal() {
    if (!room) return;
    const roster = room.roster() as { id: string; name: string }[];
    const waitingOnUpload = chosenScene() === UPLOAD_ID && !uploaded;
    $<HTMLButtonElement>("roomDeal").disabled = !room.isHost || roster.length < 2 || waitingOnUpload;
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
    (window as unknown as { __jesterRoom?: unknown }).__jesterRoom = r; // for checking in the console
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
  $("roomDeal").addEventListener("click", async () => {
    if (!room) return;
    problem("");
    const id = chosenScene();
    const deal = $<HTMLButtonElement>("roomDeal");
    deal.disabled = true;
    try {
      if (id === UPLOAD_ID) {
        if (!uploaded) return;
        // Deal first, then send the clip's guides: the others wait for them to arrive.
        hostDeal(room as never, uploaded, UPLOAD_ID, { speed: 1 });
        await room.sendMedia("scene", packScene(uploaded).data!);
      } else if (id === "bank") {
        const clipId = bankSelect.value;
        const s = await sceneFromBank(clipId, hooks.clipVideo);
        if (s.error !== null) return problem(s.error);
        hostDeal(room as never, s.data, bankSceneId(clipId), { speed: 1 });
      } else {
        hostDeal(room as never, ONLINE_SCENES[id as OnlineSceneId](), id, { speed: 1 });
      }
    } catch (err) {
      problem((err as Error).message);
    } finally {
      updateDeal();
    }
  });

  return { leave, get room() { return room; } };
}
