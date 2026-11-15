// Plain blind mode screens: a stand-in `BlindUi` on the ids in index.html (#blind and the stage), so the
// game runs end to end before Aaron's look (app/src/ui/) replaces it. The game itself is in blind.ts.

import type { BodyPart } from "../../engine/src/index.ts";
import { demoScene, runBlindGame, videoScene, type BlindDeps, type BlindUi, type Scene } from "./blind.ts";

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

  const sceneReady = (s: Scene) => {
    scene = s;
    status(`${s.name}: ${(s.durationMs / 1000).toFixed(1)} s, roles: ${s.guides.map((g) => g.subject.label).join(", ")}.`);
    $<HTMLButtonElement>("blindDeal").disabled = false;
  };
  $("blindDemo").addEventListener("click", () => sceneReady(demoScene()));
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
      show("turnStart", false); show("turnPartRow", false);
      $("turnTitle").textContent = `${player.name}'s turn`;
      $("turnText").textContent = `${previous ? `Done, ${previous.name}. Your score stays secret until the reveal. ` : ""}Pass the laptop to ${player.name}. Everyone else, look away from the screen.`;
      $("turnReveal").textContent = `I'm ${player.name}: show my role`;
      show("turnReveal", true);
      await click("turnReveal");
    },
    async showPart(_player, role) {
      show("turnReveal", false);
      $("turnText").textContent = (role.problem ? role.problem + " " : "") + role.text;
      const select = $<HTMLSelectElement>("turnPart");
      if (role.parts) {
        select.innerHTML = role.parts.map((p) => `<option value="${p.key}">${p.label}</option>`).join("");
        show("turnPartRow", true);
      }
      show("turnStart", true);
      await click("turnStart");
      show("turnStart", false); show("turnPartRow", false);
      return (role.parts ? select.value : "body") as BodyPart;
    },
    playStage: () => ({ guideCanvas: deps.guideCanvas, playerCanvas: deps.playerCanvas, cam: deps.cam }),
    countdown: deps.countdown,
    async beat() {
      $("turnText").textContent = "That's everyone. Gather round for the reveal.";
      $("turnTitle").textContent = "All done";
      await new Promise((r) => setTimeout(r, 1200));
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
    await runBlindGame(scene, names, ui, deps);
    $<HTMLButtonElement>("blindDeal").disabled = false;
  });

  $("blindAgain").addEventListener("click", () => {
    show("blindEnd", false); show("blindTurn", false); show("blindSetup", true);
    blank();
  });
}
