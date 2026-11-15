// Play with friends online, in the main game's look: make a room or join one by its 4-letter code (typed, from a
// join link, or by scanning the room's QR), see everyone's jester, chat, and the host deals the parts. Each player
// then plays their own part on their own device (game.ts runs the round: no "pass the laptop"). The room itself is
// spikes/pose-match/rooms.mjs over the hosted connection. Chat lives only in each device's memory, never stored.

import { Room, broadcastChannelTransport, makeRoomCode, normalizeCode } from "../../../spikes/pose-match/rooms.mjs";
import { hostDeal } from "../onlineBlind.ts";
import { demoScene, dribbleScene, duoScene } from "../blind.ts";
import { hostedTransportFromEnv } from "../supabaseTransport.ts";
import { escapeHtml } from "../escape.ts";
import { listBank, type BankClip } from "../bank.ts";
import { videoScene, type Scene } from "../blind.ts";
import { bankSceneId, packScene, sceneFromBank, setHostUpload, UPLOAD_ID } from "../onlineClip.ts";
import { packFace, unpackFace } from "../packMedia.ts";
import { addressWithRoom, joinLink, linkShown, roomCodeFromSearch } from "../roomLink.ts";
import { FaceJester, variantFor, type JesterAnim } from "./faceJester.ts";
import { playersFor } from "../castWords.ts";

export const ONLINE_SCENES = { duo: duoScene, dribble: dribbleScene, demo: demoScene } as const;
export type OnlineSceneId = keyof typeof ONLINE_SCENES;
export type LobbyRoom = InstanceType<typeof Room>;
export interface OnlineRound { clipId: string; startAt: number; roundNo: number; extra?: { assign?: Record<string, number>; speed?: number; mode?: string } }

type Member = { id: string; name: string; ready?: boolean };
type ChatLine = { from: string; name: string; text: string };
type PlayMode = "blind" | "normal";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The room code as alphabet stickers, like the wordmark: each letter its own colour, tilted, on one white backing. */
const STICKER_INKS = ["var(--stamp)", "var(--p2)", "var(--p1)", "var(--ticket)"];
const TILT = [-5, 4, -3, 5];
const BOB = [5, -4, 3, -3];
/** When each sticker slaps down, in seconds: each one follows a little sooner than the last. */
const SLAP_AT = [0, 0.1, 0.18, 0.24];
function codeStickers(el: HTMLElement, code: string) {
  const wrap = document.createElement("span");
  wrap.className = "letters";
  [...code].forEach((ch, i) => {
    const s = document.createElement("span");
    s.textContent = ch;
    s.style.setProperty("--c", STICKER_INKS[i % STICKER_INKS.length]!);
    s.style.setProperty("--r", `${TILT[i % TILT.length]}deg`);
    s.style.setProperty("--y", `${BOB[i % BOB.length]}px`);
    s.style.setProperty("--n", String(i));
    s.style.setProperty("--d", `${SLAP_AT[i] ?? 0.24}s`);
    wrap.appendChild(s);
  });
  // Spaced out for screen readers, so the code is read letter by letter.
  el.setAttribute("aria-label", [...code].join(" "));
  el.replaceChildren(wrap);
}

/** The join link as a QR in ink on white, drawn as one SVG path. The QR library loads only when a room opens. */
async function drawQr(el: HTMLElement, link: string) {
  const { default: qrcode } = await import("qrcode-generator");
  const qr = qrcode(0, "M");
  qr.addData(link);
  qr.make();
  const n = qr.getModuleCount();
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  el.innerHTML = `<svg viewBox="-2 -2 ${n + 4} ${n + 4}" shape-rendering="crispEdges" aria-hidden="true"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" /><path d="${d}" /></svg>`;
  el.dataset.link = link; // what the QR holds, for checking it in a test
}

/** A player's name as this screen shows it: one line, at most the name field's 14 letters. What a join message
 *  carries is left as it is; a longer name from a modified client is only cut short here. */
const NAME_CHARS = 14;
const shownName = (name: unknown) => (typeof name === "string" ? name.replace(/\s+/g, " ").trim().slice(0, NAME_CHARS) : "") || "Player";

/** "Sam", "Sam and Lisa", "Sam, Lisa and Jo" */
const nameList = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** One player's seat in the lineup: their jester in their colour, a tape name tag, and who they are. */
interface Seat { li: HTMLLIElement; jester: FaceJester; variant: string; anim: JesterAnim | null; name: HTMLElement; says: HTMLElement }

export function initRoomLobby(hooks: { show(): void; goHome(): void; onRound(room: LobbyRoom, round: OnlineRound): void; clipVideo: HTMLVideoElement; mode?: () => string }) {
  let room: LobbyRoom | null = null;
  const me = "p" + Math.random().toString(36).slice(2, 7);

  // ---- Joining: a link with ?room=CODE opens this screen with the code in, and Join is the main action ----

  const invited = roomCodeFromSearch(location.search);
  const joinBox = $("roomJoin");
  const setTicket = (b: HTMLElement, main: boolean, text: string) => {
    b.className = main ? "btn btn-main" : "btn btn-quiet";
    b.querySelector(".ticket-text")!.textContent = text;
  };
  function showInvite(code: string | null) {
    joinBox.toggleAttribute("data-invite", !!code);
    $("roomInvite").hidden = !code;
    $("roomHeadText").textContent = code ? "Join your friends" : "Play with friends online";
    if (code) { codeStickers($("roomInviteCode"), code); $<HTMLInputElement>("roomCode").value = code; }
    setTicket($("roomEnter"), !!code, code ? "Join the room" : "Join");
    setTicket($("roomCreate"), !code, code ? "Make a new room instead" : "Make a room");
  }
  showInvite(invited);
  if (invited) requestAnimationFrame(() => $("roomName").focus());

  // ---- The host's choices: the clip (remembered for next time), and Blind or Normal ----

  // The clip: taped cards like the start screen's library. Surprise me (a random bank clip nobody sees first), one
  // card per bank clip, and Upload your own. The built-in test scenes show only on ?dev=1.
  const KEY = "jester.onlineMode";
  const pickRow = $("roomModes");
  const bankSelect = $<HTMLSelectElement>("roomBankSelect");
  const uploadInput = $<HTMLInputElement>("roomUploadFile");
  const uploadStatus = $("roomUploadStatus");
  let bank: BankClip[] = [];
  let uploaded: Scene | null = null;
  const allCards = () => [...pickRow.querySelectorAll<HTMLButtonElement>("[role=radio]")];
  /** The cards this player can see: the test scenes only with ?dev=1. */
  const cards = () => allCards().filter((b) => !b.hidden && (!b.classList.contains("dev-only") || document.body.classList.contains("dev")));
  const keyOf = (b: HTMLElement) => (b.dataset.scene === "bank" ? `bank:${b.dataset.clip}` : b.dataset.scene ?? "");
  const pickedCard = () => cards().find((b) => b.getAttribute("aria-checked") === "true") ?? null;
  function pickCard(key: string, remember = true) {
    const target = cards().find((b) => keyOf(b) === key) ?? cards()[0] ?? null;
    for (const b of allCards()) b.setAttribute("aria-checked", String(b === target));
    if (target?.dataset.scene === "bank") bankSelect.value = target.dataset.clip ?? "";
    $("roomUploadRow").hidden = target?.dataset.scene !== UPLOAD_ID;
    if (remember && target) { try { localStorage.setItem(KEY, keyOf(target)); } catch { /* private mode: it just will not be remembered */ } }
    updateDeal();
  }
  let saved: string | null = null;
  try { saved = localStorage.getItem(KEY); } catch { /* ignore */ }
  pickRow.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[role=radio]");
    if (b) pickCard(keyOf(b));
  });

  /** One taped photo per bank clip. In Blind the picture stays under a question mark, as on the start screen. */
  function bankCard(clip: BankClip, i: number): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "clip";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", "false");
    b.dataset.scene = "bank";
    b.dataset.clip = clip.id;
    b.innerHTML = `<span class="washi w-${["mint", "dots", "pink"][i % 3]}" aria-hidden="true"></span><span class="clip-pic" aria-hidden="true"><span class="clip-q">?</span></span><span class="clip-name"></span><span class="clip-hint"></span><svg class="clip-star" aria-hidden="true"><use href="#star" /></svg>`;
    if (clip.poster) {
      // The poster url comes from the bank, so it is set as an attribute rather than written into markup.
      const img = document.createElement("img");
      img.src = clip.poster;
      img.alt = "";
      img.loading = "lazy";
      b.querySelector(".clip-pic")!.prepend(img);
    }
    const players = playersFor(clip.people, clip.things);
    b.querySelector(".clip-name")!.textContent = clip.title;
    b.querySelector(".clip-hint")!.textContent = `${players} ${players === 1 ? "player" : "players"}, ${Math.round(clip.durationMs / 1000)} s`;
    return b;
  }
  const surpriseHint = () => {
    $("roomSurpriseHint").textContent = !bank.length ? "One of the built-in scenes, at random."
      : playMode === "blind" ? "Any clip from the bank. Nobody sees it until the end." : "Any clip from the bank, at random.";
  };
  void listBank().then((r) => {
    bank = r.data ?? [];
    bankSelect.innerHTML = bank.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.title)}</option>`).join("");
    const upload = pickRow.querySelector('[data-scene="upload"]');
    for (const [i, clip] of bank.entries()) pickRow.insertBefore(bankCard(clip, i), upload);
    surpriseHint();
    pickCard(saved ?? "surprise", false);
  });
  /** What Deal will play: a bank clip (Surprise me picks one now), the upload, or a built-in scene. */
  function chosenPick(): { scene: string; clip?: string } {
    const b = pickedCard();
    const scene = b?.dataset.scene ?? "surprise";
    if (scene === "surprise") {
      if (bank.length) return { scene: "bank", clip: bank[Math.floor(Math.random() * bank.length)]!.id };
      const ids = Object.keys(ONLINE_SCENES) as OnlineSceneId[];
      return { scene: ids[Math.floor(Math.random() * ids.length)]! };
    }
    return scene === "bank" ? { scene, clip: b!.dataset.clip } : { scene };
  }

  // One paper switch, like the start screen's. It starts on whatever the host had picked there.
  const plays = [...document.querySelectorAll<HTMLButtonElement>("#roomPlayMode .mode")];
  let playMode: PlayMode = "blind";
  const setPlay = (m: PlayMode) => {
    playMode = m;
    for (const b of plays) b.setAttribute("aria-checked", String(b.dataset.play === m));
    $("roomPlaySays").textContent = plays.find((b) => b.dataset.play === m)?.querySelector("span")?.textContent ?? "";
    pickRow.dataset.play = m; // posters show in Normal only, as on the start screen
    surpriseHint();
  };
  plays.forEach((b) => b.addEventListener("click", () => setPlay(b.dataset.play as PlayMode)));
  setPlay("blind");

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

  // ---- The photo booth: your camera in a taped print. Joining counts down 3, 2, 1 and snaps the face circle; your
  // jester wears it in the lobby, on every device in the room, until a round brings a newer face. Never stored. ----

  const boothView = $<HTMLCanvasElement>("roomBoothView");
  /** The face circle's width as a share of the print (style.css: .room-booth-ring is inset 15%). */
  const RING = 0.7;
  let boothStream: MediaStream | null = null;
  let boothVideo: HTMLVideoElement | null = null;
  let boothRaf = 0;
  let boothTurn = 0; // bumps on every start and stop, so a camera that answers after leaving is let go
  let joinTurn = 0;  // bumps on leave, so a countdown under way does not join
  let myFace: HTMLCanvasElement | null = null;
  let myFaceText: string | null = null;
  const faces = new Map<string, HTMLCanvasElement>();
  const faceText = new Map<string, string>(); // the picture text each jester wears now
  const MAX_FACE_CHARS = 200_000;
  let knownIds = new Set<string>();
  let resendTimer = 0;
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  /** The centre square of the camera, flipped like a mirror. */
  function drawBooth() {
    const v = boothVideo;
    if (!v || v.readyState < 2 || !v.videoWidth) return;
    const side = Math.min(v.videoWidth, v.videoHeight);
    const g = boothView.getContext("2d")!;
    g.save();
    g.translate(boothView.width, 0);
    g.scale(-1, 1);
    g.drawImage(v, (v.videoWidth - side) / 2, (v.videoHeight - side) / 2, side, side, 0, 0, boothView.width, boothView.height);
    g.restore();
  }
  async function startBooth() {
    stopBooth();
    const turn = ++boothTurn;
    $("roomBoothSays").textContent = "Face in the circle";
    if (!navigator.mediaDevices?.getUserMedia) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      if (turn !== boothTurn) { stream.getTracks().forEach((t) => t.stop()); return; }
      boothStream = stream;
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.srcObject = stream;
      await v.play();
      if (turn !== boothTurn) return; // stopBooth has already let the camera go
      boothVideo = v;
      $("roomBoothCol").hidden = false;
      const loop = () => { drawBooth(); boothRaf = requestAnimationFrame(loop); };
      loop();
    } catch { /* no camera, or it was refused: you join with the plain grey face */ }
  }
  function stopBooth() {
    boothTurn++;
    cancelAnimationFrame(boothRaf);
    boothRaf = 0;
    boothStream?.getTracks().forEach((t) => t.stop());
    boothStream = null;
    boothVideo = null;
  }
  const restart = (el: HTMLElement, cls: string) => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };
  /** Counts down on the print, snaps the face circle and lets the camera go. Null without a camera. */
  async function snapFace(): Promise<HTMLCanvasElement | null> {
    if (!boothVideo) { stopBooth(); return null; }
    const count = $("roomBoothCount");
    for (const n of ["3", "2", "1"]) {
      count.textContent = n;
      restart(count, "tick");
      await wait(650);
      if (!boothVideo) { count.textContent = ""; return null; } // left meanwhile
    }
    count.textContent = "";
    drawBooth();
    cancelAnimationFrame(boothRaf); // the print keeps the snapped frame
    boothRaf = 0;
    restart($("roomBoothFlash"), "go");
    const face = document.createElement("canvas");
    face.width = face.height = 256;
    const g = face.getContext("2d")!;
    g.beginPath();
    g.arc(128, 128, 128, 0, Math.PI * 2);
    g.clip();
    const side = boothView.width * RING, from = (boothView.width - side) / 2;
    g.drawImage(boothView, from, from, side, side, 0, 0, 256, 256);
    $("roomBoothSays").textContent = "Got you";
    await wait(550);
    stopBooth();
    return face;
  }
  async function joinWithPhoto(rawCode: string) {
    if (normalizeCode(rawCode).length !== 4) return problem("A room code is 4 letters.");
    const turn = ++joinTurn;
    const buttons = [$<HTMLButtonElement>("roomCreate"), $<HTMLButtonElement>("roomEnter")];
    for (const b of buttons) b.disabled = true;
    try {
      const face = await snapFace();
      if (turn !== joinTurn) return; // they left during the countdown
      myFace = face;
      myFaceText = face ? packFace(face) : null;
    } finally {
      for (const b of buttons) b.disabled = false;
    }
    enter(rawCode);
  }
  function shareMyFace() {
    if (room && myFaceText) void room.sendMedia("lobbyface", myFaceText, { chunkChars: 60000, delayMs: 0 }).catch(() => {});
  }
  /** Puts each player's newest face on their jester: the face from their last round, else their lobby photo. */
  function syncFaces(roster: Member[]) {
    if (!room) return;
    for (const p of roster) {
      const media = (room.media.get(p.id) ?? {}) as Record<string, string>;
      const text = media.face ?? media.lobbyface;
      if (!text || text.length > MAX_FACE_CHARS || text === faceText.get(p.id)) continue;
      faceText.set(p.id, text);
      void unpackFace(text).then((c) => {
        if (!c || faceText.get(p.id) !== text) return;
        faces.set(p.id, c);
        seats.get(p.id)?.jester.setFace(c);
      });
    }
  }

  // ---- The lineup: everyone's jester. Ready players (and the host) dance; the rest stand by ----

  const seats = new Map<string, Seat>();
  const rosterList = $("roomRoster");
  function makeSeat(variant: string): Seat {
    const li = document.createElement("li");
    li.className = "room-seat";
    const jester = new FaceJester(null, variant, 240);
    jester.canvas.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "tape room-seat-name";
    const says = document.createElement("span");
    says.className = "room-seat-says";
    li.append(jester.canvas, name, says);
    return { li, jester, variant, anim: null, name, says };
  }
  function dropSeat(id: string) {
    faces.delete(id);
    faceText.delete(id);
    const s = seats.get(id);
    if (!s) return;
    s.jester.stop();
    s.li.remove();
    seats.delete(id);
  }
  function renderSeats(roster: Member[], hostId: string) {
    const here = new Set(roster.map((p) => p.id));
    for (const id of [...seats.keys()]) if (!here.has(id)) dropSeat(id);
    roster.forEach((p, i) => {
      // Player n wears colourway n, as in the game itself (game.ts colours players by their place in the room).
      const variant = variantFor(i);
      let s = seats.get(p.id);
      if (s && s.variant !== variant) { dropSeat(p.id); s = undefined; }
      if (!s) { s = makeSeat(variant); seats.set(p.id, s); s.jester.setFace(faces.get(p.id) ?? null); }
      if (rosterList.children[i] !== s.li) rosterList.insertBefore(s.li, rosterList.children[i] ?? null);
      s.li.style.setProperty("--who", `var(--p${(i % 4) + 1})`);
      s.name.textContent = shownName(p.name);
      const isHost = p.id === hostId, isMe = p.id === me;
      const ready = isHost || !!p.ready;
      s.li.dataset.ready = String(ready);
      s.says.textContent = isHost ? (isMe ? "You, the host" : "The host") : `${isMe ? "You, " : ""}${ready ? "ready" : "not ready yet"}`.replace(/^./, (c) => c.toUpperCase());
      const anim: JesterAnim = ready && !calm() ? "dance" : "idle";
      if (anim !== s.anim) { s.anim = anim; s.jester.play(anim); }
    });
  }

  function render() {
    if (!room) return;
    const roster = room.roster() as Member[];
    const hostId = room.hostId as string;
    const host = room.isHost as boolean;
    renderSeats(roster, hostId);
    syncFaces(roster);
    // Someone new: send them my photo (a short wait gathers several arrivals into one send).
    const newcomer = roster.some((p) => p.id !== me && !knownIds.has(p.id));
    knownIds = new Set(roster.map((p) => p.id));
    if (newcomer) { clearTimeout(resendTimer); resendTimer = window.setTimeout(shareMyFace, 400); }
    $("roomLobby").dataset.role = host ? "host" : "guest";
    // The chat goes under the shorter side: the lineup for the host, the ready ticket for a guest.
    const chatHome = $(host ? "roomSideWho" : "roomSidePlay");
    if ($("roomChat").parentElement !== chatHome) chatHome.appendChild($("roomChat"));
    $("roomHostRow").hidden = !host;
    $("roomGuestRow").hidden = host;
    $("roomNeedTwo").hidden = roster.length >= 2;
    // The host sees who still has to tap ready; dealing is never held up by someone who stepped away.
    const guests = roster.filter((p) => p.id !== hostId);
    const waiting = guests.filter((p) => !p.ready).map((p) => shownName(p.name));
    const readyLine = $("roomReadyLine");
    readyLine.hidden = guests.length === 0;
    readyLine.textContent = waiting.length === 0 ? "Everyone's ready." : `${nameList(waiting)} ${waiting.length === 1 ? "isn't" : "aren't"} ready yet.`;
    const hostPlayer = roster.find((p) => p.id === hostId);
    const hostName = hostPlayer ? shownName(hostPlayer.name) : "The host";
    $("roomGuestNote").textContent = `${hostName} picks the clip and deals the parts.`;
    const readyBtn = $("roomReady");
    readyBtn.setAttribute("aria-pressed", String(!!room.ready));
    $("roomReadySays").textContent = room.ready ? "Need a minute? Press it again." : `${hostName} sees when you're ready.`;
    updateDeal();
  }

  /** The Deal button needs a second player, and for an upload, a clip that has been read. */
  function updateDeal() {
    if (!room) return;
    const roster = room.roster() as Member[];
    const waitingOnUpload = pickedCard()?.dataset.scene === UPLOAD_ID && !uploaded;
    $<HTMLButtonElement>("roomDeal").disabled = !room.isHost || roster.length < 2 || waitingOnUpload;
  }

  // ---- Chat: a torn notebook page. Each device keeps the lines it heard until it leaves the room ----

  const chatLog = $("roomChatLog");
  const chatInput = $<HTMLInputElement>("roomChatText");
  let lastSaid = 0;
  function addChat(line: ChatLine) {
    const li = document.createElement("li");
    li.className = line.from === me ? "mine" : "";
    const who = document.createElement("b");
    who.textContent = `${shownName(line.name)}:`;
    li.append(who, document.createTextNode(" " + line.text));
    chatLog.appendChild(li);
    while (chatLog.children.length > 60) chatLog.firstElementChild?.remove();
    $("roomChatEmpty").hidden = true;
    const lines = $("roomChatLines");
    lines.scrollTop = lines.scrollHeight;
  }
  function clearChat() {
    chatLog.replaceChildren();
    $("roomChatEmpty").hidden = false;
    chatInput.value = "";
  }
  $("roomChatForm").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!room || Date.now() - lastSaid < 400) return;
    if (room.say(chatInput.value)) { lastSaid = Date.now(); chatInput.value = ""; }
  });

  // ---- Getting people in: the code, the link, the QR ----

  let link = "";
  const copyBtn = $<HTMLButtonElement>("roomCopy");
  let copyTimer = 0;
  copyBtn.addEventListener("click", async () => {
    clearTimeout(copyTimer);
    try {
      await navigator.clipboard.writeText(link);
      copyBtn.textContent = "Copied";
    } catch {
      // No clipboard here: show the link and select it, so it can be copied by hand. Otherwise it stays off
      // screen: the QR and Copy link carry it.
      $("roomLinkText").hidden = false;
      $("roomLinkLine").hidden = false;
      const range = document.createRange();
      range.selectNodeContents($("roomLinkText"));
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      copyBtn.textContent = "Link selected";
    }
    copyTimer = window.setTimeout(() => { copyBtn.textContent = "Copy link"; }, 1800);
  });

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
    r.on("chat", addChat);
    r.on("start", (round: OnlineRound) => {
      if (!r.isHost) r.setReady(false); // ready again for the next round
      hooks.onRound(r, round);
    });
    r.join();
    shareMyFace();
    setPlay((hooks.mode?.() === "normal" ? "normal" : "blind"));
    $("roomJoin").hidden = true;
    $("roomLobby").hidden = false;
    $("roomHead").hidden = true;
    $("roomBack").textContent = "Leave the room";
    codeStickers($("roomCodeText"), code);
    link = joinLink(code, location);
    $("roomLinkText").textContent = linkShown(link);
    $("roomLinkText").hidden = true;
    $("roomWhere").textContent = hosted ? "" : "(this browser only: the hosted connection is not set up on this copy)";
    $("roomLinkLine").hidden = !!hosted; // only the "this browser only" notice shows here
    $("roomQrCode").replaceChildren();
    $("roomQr").hidden = false; // a QR that failed in an earlier room must not hide this one's
    void drawQr($("roomQrCode"), link).catch(() => { $("roomQr").hidden = true; });
    history.replaceState(history.state, "", addressWithRoom(location.href, code));
    render();
  }

  function leave() {
    joinTurn++; // a countdown under way no longer joins
    stopBooth();
    $("roomBoothCol").hidden = true;
    myFace = null; myFaceText = null;
    knownIds = new Set();
    clearTimeout(resendTimer);
    room?.leave();
    room = null;
    for (const id of [...seats.keys()]) dropSeat(id);
    clearChat();
    $("roomJoin").hidden = false;
    $("roomLobby").hidden = true;
    $("roomHead").hidden = false;
    $("roomBack").textContent = "Back";
    showInvite(null);
    if (roomCodeFromSearch(location.search)) history.replaceState(history.state, "", addressWithRoom(location.href, null));
    problem("");
  }

  $("playOnline").addEventListener("click", () => { leave(); hooks.show(); void startBooth(); });
  $("roomCreate").addEventListener("click", () => void joinWithPhoto(makeRoomCode()));
  $("roomEnter").addEventListener("click", () => void joinWithPhoto($<HTMLInputElement>("roomCode").value));
  if (invited) void startBooth();
  // Enter in a field does what its main button does.
  $("roomName").addEventListener("keydown", (e) => { if (e.key === "Enter") (joinBox.hasAttribute("data-invite") ? $("roomEnter") : $("roomCreate")).click(); });
  $("roomCode").addEventListener("keydown", (e) => { if (e.key === "Enter") $("roomEnter").click(); });
  $("roomBack").addEventListener("click", () => { leave(); hooks.goHome(); });
  $("roomReady").addEventListener("click", () => { if (room && !room.isHost) room.setReady(!room.ready); });
  $("roomDeal").addEventListener("click", async () => {
    if (!room) return;
    problem("");
    const pick = chosenPick();
    const deal = $<HTMLButtonElement>("roomDeal");
    deal.disabled = true;
    try {
      if (pick.scene === UPLOAD_ID) {
        if (!uploaded) return;
        // Deal first, then send the clip's guides: the others wait for them to arrive.
        hostDeal(room as never, uploaded, UPLOAD_ID, { speed: 1, mode: playMode });
        await room.sendMedia("scene", packScene(uploaded).data!);
      } else if (pick.scene === "bank" && pick.clip) {
        const clipId = pick.clip;
        bankSelect.value = clipId;
        const s = await sceneFromBank(clipId, hooks.clipVideo);
        if (s.error !== null) return problem(s.error);
        hostDeal(room as never, s.data, bankSceneId(clipId), { speed: 1, mode: playMode });
      } else {
        hostDeal(room as never, ONLINE_SCENES[pick.scene as OnlineSceneId](), pick.scene, { speed: 1, mode: playMode });
      }
    } catch (err) {
      problem((err as Error).message);
    } finally {
      updateDeal();
    }
  });

  return { leave, invited, get room() { return room; } };
}
