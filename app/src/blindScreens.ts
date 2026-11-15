// Plain blind mode screens: a stand-in `BlindUi` on the ids in index.html (#blind and the stage), so the
// game runs end to end before Aaron's look (app/src/ui/) replaces it. The game itself is in blind.ts.

import type { BodyPart } from "../../engine/src/index.ts";
import { demoScene, dribbleScene, runBlindGame, videoScene, type BlindDeps, type BlindUi, type Scene } from "./blind.ts";
import { Room, broadcastChannelTransport, makeRoomCode, normalizeCode } from "../../spikes/pose-match/rooms.mjs";
import { PLAYER_COLORS } from "../../spikes/pose-match/reveal.mjs";
import { hostedTransportFromEnv } from "./supabaseTransport.ts";
import { hostDeal, playMyRole, revealRoles, whenAllDone } from "./onlineBlind.ts";
import { drawReveal } from "./composite.ts";

/** Built-in scenes, by the id a room sends: every device builds the same one. Uploaded videos stay on one laptop. */
const ONLINE_SCENES = { dribble: dribbleScene, demo: demoScene } as const;
type OnlineSceneId = keyof typeof ONLINE_SCENES;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const show = (id: string, on: boolean) => $(id).classList.toggle("hidden", !on);

/** Resolves on the next click of button `id`. */
const click = (id: string) => new Promise<void>((r) => $(id).addEventListener("click", () => r(), { once: true }));

export interface ScreenDeps extends BlindDeps {
  countdown: (seconds: number) => Promise<void>;
  clipVideo: HTMLVideoElement;
  cam: HTMLVideoElement;
  guideCanvas: HTMLCanvasElement;
  playerCanvas: HTMLCanvasElement;
}

export function initBlindScreens(deps: ScreenDeps) {
  const status = (t: string) => { $("blindStatus").textContent = t; };
  let scene: Scene | null = null;
  let sceneId: OnlineSceneId | null = null;
  // Online play: `room` is set once this device has joined one; `online` is true while an online round runs.
  let room: any = null;
  let online = false;
  let revealTimer = 0;

  const blank = () => {
    for (const c of [deps.guideCanvas, deps.playerCanvas]) {
      const ctx = c.getContext("2d")!; ctx.fillStyle = "#000"; ctx.fillRect(0, 0, c.width, c.height);
    }
  };

  const syncNames = () => {
    const n = Number($<HTMLSelectElement>("blindCount").value);
    const box = $("blindNames");
    const old = [...box.querySelectorAll("input")].map((i) => i.value);
    box.innerHTML = "";
    for (let i = 0; i < n; i++) {
      const input = document.createElement("input");
      input.value = old[i] ?? `Player ${i + 1}`;
      input.size = 10;
      box.appendChild(input);
    }
  };
  syncNames();
  $("blindCount").addEventListener("change", syncNames);

  const sceneReady = (s: Scene, id: OnlineSceneId | null = null) => {
    scene = s;
    sceneId = id;
    renderLobby();
    status(`${s.name}: ${(s.durationMs / 1000).toFixed(1)} s, roles: ${s.guides.map((g) => g.subject.label).join(", ")}.`);
    $<HTMLButtonElement>("blindDeal").disabled = false;
  };
  $("blindDemo").addEventListener("click", () => sceneReady(demoScene(), "demo"));
  $("blindDribble").addEventListener("click", () => sceneReady(dribbleScene(), "dribble"));
  $("blindFile").addEventListener("change", async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    $<HTMLButtonElement>("blindDeal").disabled = true;
    status("Reading the clip and finding everyone in it...");
    try {
      const s = await videoScene(file, deps.clipVideo, (share) => status(`Reading the clip... ${Math.round(share * 100)}%`));
      if (typeof s === "string") status(s); else sceneReady(s);
    } catch (err) {
      status("Could not read the clip: " + (err as Error).message);
    }
  });

  const ui: BlindUi = {
    async handover(player, previous) {
      blank();
      show("blindSetup", false); show("blindEnd", false); show("blindTurn", true);
      show("turnStart", false); show("turnPartRow", false); show("turnPreview", false);
      $("turnTitle").textContent = `${player.name}'s turn`;
      $("turnText").textContent = online
        ? "The host dealt the roles. Yours is secret: keep your screen to yourself."
        : `${previous ? `Done, ${previous.name}. Your score stays secret until the reveal. ` : ""}Pass the laptop to ${player.name}. Everyone else, look away from the screen.`;
      $("turnReveal").textContent = online ? "Show me my role" : `I'm ${player.name}: show me`;
      show("turnReveal", true);
      await click("turnReveal");
    },
    async showPart(_player, role) {
      show("turnReveal", false);
      $("turnText").textContent = (role.problem ? role.problem + " " : "") + role.text;
      const select = $<HTMLSelectElement>("turnPart");
      select.innerHTML = role.parts.map((p) => `<option value="${p.key}">${p.label}</option>`).join("");
      show("turnPartRow", true);
      show("turnStart", true); show("turnPreview", true);
      // Watching once is unscored; Start stays available the whole time.
      const onPreview = async () => {
        $<HTMLButtonElement>("turnPreview").disabled = true;
        await role.preview();
        $<HTMLButtonElement>("turnPreview").disabled = false;
      };
      $("turnPreview").addEventListener("click", onPreview);
      await click("turnStart");
      $("turnPreview").removeEventListener("click", onPreview);
      show("turnStart", false); show("turnPartRow", false); show("turnPreview", false);
      return select.value as BodyPart;
    },
    playStage: () => ({ guideCanvas: deps.guideCanvas, playerCanvas: deps.playerCanvas, cam: deps.cam }),
    countdown: deps.countdown,
    async beat() {
      $("turnText").textContent = online ? "Done. Sending your moves to the room..." : "That's everyone. Gather round for the reveal.";
      $("turnTitle").textContent = "All done";
      await new Promise((r) => setTimeout(r, online ? 400 : 1200));
    },
    revealCanvas: () => $<HTMLCanvasElement>("blindCanvas"),
    progress(share) { $("blindEndStatus").textContent = `Putting everyone together... ${Math.round(share * 100)}%`; },
    results(rows) {
      show("blindTurn", false); show("blindEnd", true);
      show("blindCanvas", true); show("blindVideo", false); show("blindDownload", false);
      $("blindBoard").innerHTML = rows.map((r) => {
        const crown = r.winner ? (r.tied ? " <b>ties for first</b>" : " <b>wins</b>") : "";
        const score = r.score == null ? "no score" : `${r.score} ${r.tier ?? ""}`;
        return `<tr><td><span class="dot" style="background:${r.color}"></span>${r.name}${crown}</td><td>${r.role} (${r.look === "outline" ? "outline" : "stick figure"})</td><td>${score}</td></tr>`;
      }).join("");
    },
    revealReady(url) {
      if (!url) { $("blindEndStatus").textContent = "This browser cannot record the reveal to a file."; return; }
      const video = $<HTMLVideoElement>("blindVideo"), link = $<HTMLAnchorElement>("blindDownload");
      video.src = url;
      // Recorded WebM has no length in its header: jump far ahead once so the seek bar works, then back.
      video.addEventListener("loadedmetadata", () => {
        if (video.duration !== Infinity) return;
        video.currentTime = 1e9;
        video.addEventListener("timeupdate", () => { video.currentTime = 0; }, { once: true });
      }, { once: true });
      link.href = url;
      show("blindCanvas", false); show("blindVideo", true); show("blindDownload", true);
      $("blindEndStatus").textContent = "Here is everyone, together.";
    },
  };

  $("blindDeal").addEventListener("click", async () => {
    if (!scene) return;
    $<HTMLButtonElement>("blindDeal").disabled = true;
    const names = [...$("blindNames").querySelectorAll("input")].map((i, k) => i.value.trim() || `Player ${k + 1}`);
    try {
      await runBlindGame(scene, names, ui, deps, { speed: Number($<HTMLSelectElement>("blindSpeed").value) });
    } catch (err) {
      // Never stall silently: say what broke and offer a way back to the start.
      console.error("Blind mode stopped:", err);
      show("blindTurn", false); show("blindEnd", true);
      $("blindEndStatus").textContent = `Something went wrong: ${(err as Error).message}. Press Play again to start over.`;
    }
    $<HTMLButtonElement>("blindDeal").disabled = false;
  });

  $("blindAgain").addEventListener("click", () => {
    cancelAnimationFrame(revealTimer);
    show("blindEnd", false); show("blindTurn", false); show("blindSetup", true);
    blank();
    renderLobby();
  });

  // ---- Online: each player on their own device (Lisa's rooms and onlineBlind.ts) ----

  function renderLobby() {
    if (!room) return;
    const host = room.isHost as boolean;
    $("onlineRoster").innerHTML = (room.roster() as { id: string; name: string }[])
      .map((p) => `<li>${p.name}${p.id === room.hostId ? " (host)" : ""}${p.id === room.me ? " (you)" : ""}</li>`).join("");
    show("onlineHostRow", host); show("onlineGuestRow", !host);
    $<HTMLButtonElement>("onlineDeal").disabled = !host || online || !sceneId;
    $("onlineHostRow").title = sceneId ? "" : "Online rooms use Dribble or Dancer and a ball (a picked video stays on this laptop).";
  }

  function enterRoom(rawCode: string) {
    const code = normalizeCode(rawCode);
    if (code.length !== 4) { status("A room code is 4 letters."); return; }
    room?.leave();
    const name = $<HTMLInputElement>("onlineName").value.trim() || "Player";
    const hosted = hostedTransportFromEnv(code);
    room = new Room({ transport: hosted ?? broadcastChannelTransport(code), code, playerId: "p" + Math.random().toString(36).slice(2, 7), name });
    room.on("update", renderLobby);
    room.on("start", onOnlineStart);
    room.join();
    $("onlineRoomCode").textContent = code;
    $("onlineWhere").textContent = hosted ? "(online: share the code)" : "(this browser only: open a second tab to try it)";
    show("onlineLobby", true);
    renderLobby();
  }

  async function onOnlineStart(round: { clipId: string; roundNo: number; extra?: { speed?: number } }) {
    const make = ONLINE_SCENES[round.clipId as OnlineSceneId];
    if (!make || online) return;
    const s = make();
    online = true;
    cancelAnimationFrame(revealTimer);
    renderLobby();
    try {
      await playMyRole(room, s, ui, deps, { speed: round.extra?.speed ?? 1, reveal: false });
      $("blindEndStatus").textContent = "Your moves are in. Waiting for everyone else to finish...";
      await whenAllDone(room);
      if (room.round?.roundNo === round.roundNo) showOnlineReveal(s);
    } catch (err) {
      console.error("Online blind mode stopped:", err);
      show("blindTurn", false); show("blindEnd", true);
      $("blindEndStatus").textContent = `Something went wrong: ${(err as Error).message}. Press Play again to go back to the room.`;
    }
    online = false;
    renderLobby();
  }

  /** Everyone's result from the room, then the group reveal looping on the reveal canvas. */
  function showOnlineReveal(s: Scene) {
    const standings = room.standings() as { name: string; score: number | null; extra: { role: string } | null }[];
    const roles = revealRoles(room, s);
    const top = Math.max(...standings.map((r) => r.score ?? -1));
    const tied = standings.filter((r) => r.score === top).length > 1;
    $("blindBoard").innerHTML = standings.map((r) => {
      const crown = r.score === top && top >= 0 ? (tied ? " <b>ties for first</b>" : " <b>wins</b>") : "";
      const color = PLAYER_COLORS[roles.findIndex((x) => x.name?.startsWith(r.name + " (")) % PLAYER_COLORS.length] ?? "#888";
      return `<tr><td><span class="dot" style="background:${color}"></span>${r.name}${crown}</td><td>${r.extra?.role ?? ""}</td><td>${r.score ?? "no score"}</td></tr>`;
    }).join("");
    show("blindTurn", false); show("blindEnd", true);
    show("blindCanvas", true); show("blindVideo", false); show("blindDownload", false);
    $("blindEndStatus").textContent = "Here is everyone, together.";
    const canvas = $<HTMLCanvasElement>("blindCanvas");
    const started = performance.now();
    const tick = () => {
      const ms = s.startMs + ((performance.now() - started) % Math.max(1, s.durationMs));
      drawReveal(canvas, roles, ms, { clipAspect: s.width / s.height });
      revealTimer = requestAnimationFrame(tick);
    };
    tick();
  }

  $("onlineCreate").addEventListener("click", () => enterRoom(makeRoomCode()));
  $("onlineJoin").addEventListener("click", () => enterRoom($<HTMLInputElement>("onlineCode").value));
  $("onlineDeal").addEventListener("click", () => {
    if (!room?.isHost || !sceneId || !scene) return;
    try { hostDeal(room, scene, sceneId, { speed: Number($<HTMLSelectElement>("blindSpeed").value) }); }
    catch (err) { status((err as Error).message); }
  });
}
