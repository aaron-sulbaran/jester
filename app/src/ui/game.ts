// The game's screens: start, cast, pass the laptop, your shape, play, the drum roll, the reveal, results.
// This file is Aaron's look and flow. It implements `BlindUi` for Alex's game (../blind.ts), which owns the
// rules, the camera, scoring and the reveal recording, and makes no DOM of its own.

import type { BodyPart } from "../../../engine/src/index.ts";
import { demoScene, dribbleScene, runBlindGame, SPEEDS, videoScene, type BlindDeps, type BlindUi, type ResultRow, type Scene } from "../blind.ts";
import { PLAYER_COLORS } from "../../../spikes/pose-match/reveal.mjs";

/** A CSS custom property from the skin, or the fallback. */
const cssVar = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/** Player colours come from the skin (--p1 to --p4), so the cast, the turn and the reveal all match it. */
const playerColors = () => [1, 2, 3, 4].map((i) => cssVar(`--p${i}`, PLAYER_COLORS[i - 1]!));

/** The recorded reveal takes the skin's paper, ink and lettering instead of the default dark card. */
const revealTheme = () => ({
  card: cssVar("--reveal-card", "#16161d"), ink: cssVar("--reveal-ink", "#f2f2f5"), soft: cssVar("--reveal-soft", "#a0a3b1"),
  accent: cssVar("--reveal-accent", "#f5c542"), font: cssVar("--reveal-font", "system-ui, sans-serif"), title: "Jester", glow: 0,
});

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

/** A jester cap drawn over each player's photo on the results, in their colour. */
const CAP_SVG = `<svg class="badge-cap" viewBox="0 0 200 150" aria-hidden="true"><path d="M60 112 C46 84 34 62 14 44 C42 50 72 72 94 106 Z"/><path d="M140 112 C154 84 166 62 186 44 C158 50 128 72 106 106 Z"/><path d="M78 108 C82 74 90 42 100 16 C110 42 118 74 122 108 Z"/><path class="band" d="M48 110 Q100 94 152 110 L152 132 Q100 118 48 132 Z"/><circle class="bell" cx="14" cy="44" r="11"/><circle class="bell" cx="100" cy="16" r="11"/><circle class="bell" cx="186" cy="44" r="11"/></svg>`;

/** Colours for alphabet sticker lettering: stamp red, blue, pink, yellow. */
const STICKER_COLORS = ["#D93A2B", "#4F7BF0", "#F47FA6", "#FFC93C"];
const TILT = [-4, 3, -2, 4, -3, 2];
const BOB = [4, -4, 2, -3, 3, -2];

/** Writes `text` into `el` as alphabet stickers: each letter its own colour (or all `color`), one white backing. */
function letters(el: HTMLElement, text: string, color?: string) {
  el.setAttribute("aria-label", text);
  const wrap = document.createElement("span");
  wrap.className = "letters";
  wrap.setAttribute("aria-hidden", "true");
  [...text].forEach((ch, i) => {
    const span = document.createElement("span");
    span.textContent = ch === " " ? "\u00a0" : ch;
    span.style.setProperty("--c", ch === " " ? "transparent" : color ?? STICKER_COLORS[i % STICKER_COLORS.length]!);
    span.style.setProperty("--r", `${TILT[i % TILT.length]}deg`);
    span.style.setProperty("--y", `${BOB[i % BOB.length]}px`);
    span.style.setProperty("--n", String(i));
    wrap.appendChild(span);
  });
  el.replaceChildren(wrap);
}

const ordinal = (n: number) => (n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`);

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
    b.innerHTML = `<span class="washi w-${["pink", "mint", "dots"][STARTERS.indexOf(c) % 3]}" aria-hidden="true"></span><span class="clip-pic" aria-hidden="true"><span class="clip-q">?</span></span><span class="clip-name"></span><span class="clip-hint"></span><svg class="clip-star" aria-hidden="true"><use href="#star" /></svg>`;
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
    // Start with one player per part; more players share parts, fewer leave some out.
    const parts = scene.guides.length;
    const want = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, parts));
    names = Array.from({ length: want }, (_, i) => names[i] ?? "");
    renderCast();
    show("cast");
    ($("castNames").querySelector("input") as HTMLInputElement | null)?.focus();
  }

  function renderCast() {
    const parts = scene?.guides.length ?? names.length;
    const extra = names.length - parts;
    $("castParts").textContent = (parts === 1 ? "This clip has 1 part." : `This clip has ${parts} parts.`)
      + (extra === 1 ? " Two of you will share one." : extra > 1 ? " Some of you will share." : extra < 0 ? " Not every part gets played." : "");
    const colors = playerColors();
    const box = $("castNames");
    box.innerHTML = "";
    names.forEach((value, i) => {
      const row = document.createElement("label");
      row.className = "who";
      row.style.setProperty("--who", colors[i % colors.length]!);
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
    // The reveal is drawn on a canvas in the skin's handwriting: make sure the fonts are in before it starts.
    await Promise.all(["700 40px Gaegu", "400 40px Gaegu", "40px 'Titan One'"].map((f) => document.fonts.load(f).catch(() => [])));
    rows = [];
    videoUrl = null;
    try {
      await runBlindGame(scene, cast, ui, deps, { speed, colors: playerColors(), theme: revealTheme() });
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
      letters($("handoverName"), player.name, player.color);
      $("handoverDone").textContent = previous ? `Nice one, ${previous.name}. Your score stays a secret until the end.` : "";
      $("handoverDone").hidden = !previous;
      const go = $<HTMLButtonElement>("handoverGo");
      go.querySelector(".ticket-text")!.textContent = `I'm ${player.name}`;
      go.focus();
      await clicked(go);
    },

    async showPart(player, role) {
      show("turn");
      turn.dataset.state = "part";
      turn.style.setProperty("--who", player.color);
      $("turnName").textContent = `${player.name}'s turn`;
      // The game's own explanation is long; the screen says it in two lines.
      $("partText").textContent = "Copy this shape like a mirror. Move when it moves.";
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
    letters($("resultsHeadline"), headline);
    const list = $("podium");
    list.innerHTML = "";
    rows.forEach((r, i) => {
      // Tied scores share a place.
      const place = 1 + rows.filter((o) => (o.score ?? -1) > (r.score ?? -1)).length;
      const li = document.createElement("li");
      li.className = "place" + (r.winner ? " won" : "");
      li.style.setProperty("--who", r.color);
      li.style.setProperty("--i", String(i));
      li.innerHTML = `<span class="badge"><span class="badge-photo"></span>${CAP_SVG}</span><span class="place-who"><span class="place-rank"></span><b class="tape"></b><span class="place-part"></span></span><span class="place-score"></span>`;
      li.querySelector(".place-rank")!.textContent = ordinal(place);
      const photo = li.querySelector(".badge-photo")!;
      if (r.face) { const img = new Image(); img.src = r.face.toDataURL("image/jpeg", 0.85); img.alt = `${r.name}'s face`; photo.appendChild(img); }
      else photo.classList.add("no-face");
      li.querySelector("b")!.textContent = r.name;
      li.querySelector(".place-part")!.textContent = `was ${r.role}`;
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
