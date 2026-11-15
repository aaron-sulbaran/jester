// The game's screens: start, cast, pass the laptop, your shape, play, the drum roll, the reveal, results.
// This file is Aaron's look and flow. It implements `BlindUi` for Alex's game (../blind.ts), which owns the
// rules, the camera, scoring and the reveal recording, and makes no DOM of its own.

import type { BodyPart } from "../../../engine/src/index.ts";
import { demoScene, dribbleScene, runBlindGame, SPEEDS, videoScene, type BlindDeps, type BlindUi, type ResultRow, type Scene } from "../blind.ts";
import { PLAYER_COLORS } from "../../../spikes/pose-match/reveal.mjs";

export interface GameDeps extends BlindDeps {
  clipVideo: HTMLVideoElement;
  cam: HTMLVideoElement;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Resolves on the next click of `el`. */
const clicked = (el: HTMLElement) => new Promise<void>((r) => el.addEventListener("click", () => r(), { once: true }));

const SCREENS = ["start", "reading", "cast", "handover", "turn", "drumroll", "reveal", "results", "oops"] as const;
type ScreenName = (typeof SCREENS)[number];

/** Shows one screen and hides the rest. The body carries the name too, so the look can theme per screen. */
function show(name: ScreenName) {
  for (const s of SCREENS) $(`screen-${s}`).hidden = s !== name;
  document.body.dataset.screen = name;
  window.scrollTo(0, 0);
}

interface StarterClip { id: string; title: string; hint: string; make: () => Scene }

// Titles hint at the clip without saying who is what: in blind mode nobody sees the clip until the reveal.
const STARTERS: StarterClip[] = [
  { id: "dribble", title: "Pickup game", hint: "Someone, and something they keep bouncing", make: dribbleScene },
  { id: "dance", title: "Dance break", hint: "Someone dancing, and something flying around", make: demoScene },
];

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;

export function initGame(deps: GameDeps) {
  let scene: Scene | null = null;
  let picked: StarterClip | null = STARTERS[0] ?? null;
  let names: string[] = ["", "", ""];
  let speed: number = SPEEDS[0];
  let rows: ResultRow[] = [];
  let videoUrl: string | null = null;

  const guideCanvas = $<HTMLCanvasElement>("guideCanvas");
  const playerCanvas = $<HTMLCanvasElement>("youCanvas");
  const revealCanvas = $<HTMLCanvasElement>("revealStage");
  const turn = $("screen-turn");

  // ---- Start ----

  const clipList = $("clips");
  for (const c of STARTERS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "clip";
    b.dataset.clip = c.id;
    b.innerHTML = `<span class="clip-pic" aria-hidden="true"></span><span class="clip-name"></span><span class="clip-hint"></span>`;
    b.querySelector(".clip-name")!.textContent = c.title;
    b.querySelector(".clip-hint")!.textContent = c.hint;
    b.addEventListener("click", () => pickStarter(c));
    clipList.appendChild(b);
  }

  function pickStarter(c: StarterClip) {
    picked = c;
    for (const b of clipList.querySelectorAll<HTMLButtonElement>(".clip")) b.setAttribute("aria-pressed", String(b.dataset.clip === c.id));
    $("playLabel").textContent = `Play ${c.title}`;
  }
  if (picked) pickStarter(picked);

  $("play").addEventListener("click", () => {
    if (!picked) return;
    scene = picked.make();
    openCast();
  });

  $("upload").addEventListener("change", async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    show("reading");
    $("readingName").textContent = file.name;
    const bar = $<HTMLProgressElement>("readingBar");
    bar.value = 0;
    try {
      const s = await videoScene(file, deps.clipVideo, (share) => { bar.value = share; });
      if (typeof s === "string") return startProblem(s);
      scene = s;
      openCast();
    } catch (err) {
      startProblem(`I could not read that clip: ${(err as Error).message}`);
    }
  });

  function startProblem(text: string) {
    $("startProblem").textContent = text;
    $("startProblem").hidden = false;
    show("start");
  }

  $("soloLink").addEventListener("click", () => { document.body.classList.add("solo"); });
  $("soloBack").addEventListener("click", () => { document.body.classList.remove("solo"); show("start"); });

  // ---- Cast ----

  function openCast() {
    if (!scene) return;
    $("startProblem").hidden = true;
    const parts = scene.guides.length;
    $("castParts").textContent = parts === 1 ? "This clip has 1 part." : `This clip has ${parts} parts.`;
    if (names.length < MIN_PLAYERS) names = ["", ""];
    renderCast();
    show("cast");
    ($("castNames").querySelector("input") as HTMLInputElement | null)?.focus();
  }

  function renderCast() {
    const box = $("castNames");
    box.innerHTML = "";
    names.forEach((value, i) => {
      const row = document.createElement("label");
      row.className = "who";
      row.style.setProperty("--who", PLAYER_COLORS[i % PLAYER_COLORS.length]!);
      row.innerHTML = `<span class="who-dot" aria-hidden="true"></span><span class="who-label">Player ${i + 1}</span>`;
      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = 14;
      input.placeholder = `Player ${i + 1}`;
      input.value = value;
      input.autocomplete = "off";
      input.addEventListener("input", () => { names[i] = input.value; });
      row.appendChild(input);
      box.appendChild(row);
    });
    $<HTMLButtonElement>("castLess").disabled = names.length <= MIN_PLAYERS;
    $<HTMLButtonElement>("castMore").disabled = names.length >= MAX_PLAYERS;
  }
  $("castMore").addEventListener("click", () => { if (names.length < MAX_PLAYERS) { names.push(""); renderCast(); } });
  $("castLess").addEventListener("click", () => { if (names.length > MIN_PLAYERS) { names.pop(); renderCast(); } });
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-speed]")) {
    b.addEventListener("click", () => {
      speed = Number(b.dataset.speed);
      for (const o of document.querySelectorAll<HTMLButtonElement>("[data-speed]")) o.setAttribute("aria-pressed", String(o === b));
    });
  }
  $("castBack").addEventListener("click", () => show("start"));
  $("deal").addEventListener("click", () => { void runGame(); });

  // ---- The game ----

  async function runGame() {
    if (!scene) return;
    const cast = names.map((n, i) => n.trim() || `Player ${i + 1}`);
    rows = [];
    videoUrl = null;
    try {
      await runBlindGame(scene, cast, ui, deps, { speed });
    } catch (err) {
      // Never stall silently: say what broke and offer a way back.
      console.error("The game stopped:", err);
      $("oopsText").textContent = (err as Error).message;
      show("oops");
    }
  }

  const ui: BlindUi = {
    async handover(player, previous) {
      show("handover");
      const screen = $("screen-handover");
      screen.style.setProperty("--who", player.color);
      $("handoverName").textContent = player.name;
      $("handoverDone").textContent = previous ? `Nice one, ${previous.name}. Your score stays a secret until the end.` : "";
      $("handoverDone").hidden = !previous;
      const go = $<HTMLButtonElement>("handoverGo");
      go.textContent = `I'm ${player.name}`;
      go.focus();
      await clicked(go);
    },

    async showPart(player, role) {
      show("turn");
      turn.dataset.state = "part";
      turn.style.setProperty("--who", player.color);
      $("turnName").textContent = `${player.name}'s turn`;
      $("partText").textContent = role.text;
      $("partProblem").textContent = role.problem ?? "";
      $("partProblem").hidden = !role.problem;
      const chips = $("partChips");
      chips.innerHTML = "";
      let chosen: BodyPart = role.parts[0]?.key ?? "body";
      role.parts.forEach((p, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "chip";
        b.textContent = p.label;
        b.setAttribute("aria-pressed", String(i === 0));
        b.addEventListener("click", () => {
          chosen = p.key;
          for (const o of chips.querySelectorAll("button")) o.setAttribute("aria-pressed", String(o === b));
        });
        chips.appendChild(b);
      });
      const watch = $<HTMLButtonElement>("partWatch");
      const onWatch = async () => {
        watch.disabled = true;
        await role.preview();
        watch.disabled = false;
      };
      watch.addEventListener("click", onWatch);
      await clicked($("partGo"));
      watch.removeEventListener("click", onWatch);
      return chosen;
    },

    playStage: () => ({ guideCanvas, playerCanvas, cam: deps.cam }),

    async countdown(seconds) {
      // The countdown is the moment the turn starts: the camera comes in under the shape.
      turn.dataset.state = "play";
      const el = $("count");
      el.hidden = false;
      for (let s = seconds; s > 0; s--) {
        el.textContent = String(s);
        el.classList.remove("tick");
        void el.offsetWidth; // restart the tick animation
        el.classList.add("tick");
        await wait(1000);
      }
      el.hidden = true;
    },

    async beat() {
      show("drumroll");
      await wait(1800);
    },

    revealCanvas: () => revealCanvas,

    progress(share) {
      $<HTMLProgressElement>("revealBar").value = share;
    },

    results(r) {
      rows = [...r].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
      show("reveal");
    },

    revealReady(url) {
      videoUrl = url;
      showResults();
    },
  };

  // ---- Results ----

  function showResults() {
    const winners = rows.filter((r) => r.winner);
    const headline = winners.length === 0 ? "Everyone played!"
      : winners.length === 1 ? `${winners[0]!.name} wins!`
      : `${winners.map((w) => w.name).join(" and ")} tie!`;
    $("resultsHeadline").textContent = headline;
    const list = $("podium");
    list.innerHTML = "";
    rows.forEach((r, i) => {
      const li = document.createElement("li");
      li.className = "place" + (r.winner ? " won" : "");
      li.style.setProperty("--who", r.color);
      li.style.setProperty("--i", String(i));
      li.innerHTML = `<span class="place-rank"></span><span class="place-who"><b></b><span></span></span><span class="place-score"></span>`;
      li.querySelector(".place-rank")!.textContent = String(i + 1);
      li.querySelector("b")!.textContent = r.name;
      li.querySelector(".place-who span")!.textContent = `was ${r.role}`;
      li.querySelector(".place-score")!.textContent = r.score == null ? "no score" : String(r.score);
      list.appendChild(li);
    });
    const video = $<HTMLVideoElement>("resultsVideo");
    const save = $<HTMLAnchorElement>("resultsSave");
    if (videoUrl) {
      video.src = videoUrl;
      video.hidden = false;
      save.href = videoUrl;
      save.hidden = false;
      // Recorded WebM has no length in its header: jump far ahead once so the seek bar works, then back.
      video.addEventListener("loadedmetadata", () => {
        if (video.duration !== Infinity) return;
        video.currentTime = 1e9;
        video.addEventListener("timeupdate", () => { video.currentTime = 0; void video.play().catch(() => {}); }, { once: true });
      }, { once: true });
      void video.play().catch(() => {});
    } else {
      video.hidden = true;
      save.hidden = true;
    }
    $("sendNote").textContent = "";
    show("results");
  }

  $("send").addEventListener("click", async () => {
    const note = $("sendNote");
    if (!videoUrl) { note.textContent = "This browser could not record the reveal, so there is nothing to send."; return; }
    const blob = await (await fetch(videoUrl)).blob();
    const file = new File([blob], "jester.webm", { type: blob.type || "video/webm" });
    const share = { files: [file], title: "Jester", text: "We played Jester. Look what we turned into." };
    if (navigator.canShare?.(share)) {
      try { await navigator.share(share); note.textContent = "Sent."; } catch { /* the player closed the share sheet */ }
      return;
    }
    $<HTMLAnchorElement>("resultsSave").click();
    note.textContent = "Saved to your downloads. Send it from there.";
  });

  $("again").addEventListener("click", () => { if (scene) openCast(); else show("start"); });
  $("newClip").addEventListener("click", () => show("start"));
  $("oopsBack").addEventListener("click", () => show("start"));

  show("start");
}
