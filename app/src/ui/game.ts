// The game's screens: start, cast, pass the laptop, your shape, play, the drum roll, the reveal, results.
// This file is Aaron's look and flow. It implements `BlindUi` for Alex's game (../blind.ts), which owns the
// rules, the camera, scoring and the reveal recording, and makes no DOM of its own.

import type { BodyPart } from "../../../engine/src/index.ts";
import { demoScene, drawDemoScene, dribbleScene, revealRemoteGame, runBlindGame, SPEEDS, videoScene, type BlindDeps, type BlindUi, type RemoteResult, type ResultRow, type Scene } from "../blind.ts";
import { listBank, type BankClip } from "../bank.ts";
import { bankScene } from "../bankRound.ts";
import { submitClip } from "../submit.ts";
import { playWithSound } from "../sound.ts";
import { FaceJester, preloadJesters, variantFor } from "./faceJester.ts";
import { jesterBars } from "./jesterBar.ts";
import { countUp, guardCamera, installFeel, waitOrSkip } from "./feel.ts"; // GAME FEEL (sounds, camera card, keys)
import { awardsFor, motionOf, rankFor } from "../feelText.ts";
import { say } from "../host.ts";
import * as sfx from "../sfx.ts";
import { PLAYER_COLORS } from "../../../spikes/pose-match/reveal.mjs";
import { deserializeTimeline } from "../../../spikes/pose-match/serialize.mjs";
import { BANK_PREFIX, UPLOAD_ID, getHostUpload, sceneFromBank, waitForUploadedScene } from "../onlineClip.ts";
import { initRoomLobby, ONLINE_SCENES, type LobbyRoom, type OnlineRound, type OnlineSceneId } from "./room.ts";
import { playMyRole, sendMyMedia, whenMediaIn } from "../onlineBlind.ts";
import { unpackCutouts, unpackFace } from "../packMedia.ts";

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
const left = () => new DOMException("Left the game", "AbortError");
/** Waits `ms`, or rejects at once if the game is left. */
const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(left());
  const t = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
  const stop = () => { clearTimeout(t); reject(left()); };
  signal?.addEventListener("abort", stop, { once: true });
});
/** Resolves on the next click of `el`, or rejects if the game is left first. */
const clicked = (el: HTMLElement, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(left());
  const on = () => { signal?.removeEventListener("abort", stop); resolve(); };
  const stop = () => { el.removeEventListener("click", on); reject(left()); };
  el.addEventListener("click", on, { once: true });
  signal?.addEventListener("abort", stop, { once: true });
});

const SCREENS = ["howto", "start", "room", "reading", "cast", "watch", "handover", "turn", "drumroll", "reveal", "crown", "results", "oops"] as const;
type ScreenName = (typeof SCREENS)[number];
/** Screens where a game is under way: leaving from these asks first. */
const MID_GAME: readonly ScreenName[] = ["watch", "handover", "turn", "drumroll", "reveal"];

/** Shows one screen and hides the rest. The body carries the name too, so the look can theme per screen. */
function show(name: ScreenName) {
  for (const s of SCREENS) $(`screen-${s}`).hidden = s !== name;
  document.body.dataset.screen = name;
  // Home shows everywhere except the start screen and How to play.
  $("gameNav").hidden = name === "start" || name === "howto";
  window.scrollTo(0, 0);
}

/** How many times each player may start their turn over, per game, and for how long after the countdown. */
const RESTARTS_PER_PLAYER = 1;
const RESTART_WINDOW_MS = 5000;
const HOWTO_SEEN = "jester.howtoSeen";

interface StarterClip { id: string; title: string; hint: string; make: () => Scene }

/** Blind: you only see your shape, everyone finds out at the end. Watch first: everyone watches the clip, then plays it. */
type Mode = "blind" | "watch";
/** What the Play ticket will start. A surprise is a random bank clip nobody sees first. */
type Pick = { kind: "bank"; clip: BankClip } | { kind: "starter"; starter: StarterClip } | { kind: "surprise" };

/** "1 person and 1 thing, 20 s" */
function castLine(people: number, things: number, durationMs: number) {
  const parts = [people ? `${people} ${people === 1 ? "person" : "people"}` : "", things ? `${things} ${things === 1 ? "thing" : "things"}` : ""].filter(Boolean);
  return `${parts.join(" and ")}, ${Math.round(durationMs / 1000)} s`;
}

// The built-in clips work offline. They show only when the bank is empty.
// Titles hint at the clip without saying who is what: in blind mode nobody sees the clip until the reveal.
const STARTERS: StarterClip[] = [
  { id: "dribble", title: "Pickup game", hint: "Someone, and something they keep bouncing", make: dribbleScene },
  { id: "dance", title: "Dance break", hint: "Someone dancing, and something flying around", make: demoScene },
];

/** Colours for alphabet sticker lettering: stamp red, blue, pink, yellow. */
const STICKER_COLORS = ["#D93A2B", "#4F7BF0", "#F47FA6", "#FFC93C"];
const TILT = [-4, 3, -2, 4, -3, 2];
const BOB = [4, -4, 2, -3, 3, -2];

/** Writes `text` into `el` as alphabet stickers: each letter its own colour (or all `color`), one white backing. */
function letters(el: HTMLElement, text: string, color?: string) {
  // Screen readers get the whole word from hidden text; an aria-label on a heading is not read everywhere,
  // and the letter stickers on their own were read one letter at a time.
  const said = document.createElement("span");
  said.className = "vh";
  said.textContent = text;
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
  el.removeAttribute("aria-label");
  el.replaceChildren(said, wrap);
}

const ordinal = (n: number) => (n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`);

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;

export function initGame(deps: GameDeps) {
  let scene: Scene | null = null;
  let mode: Mode = "blind";
  let bank: BankClip[] = [];
  let pick: Pick | null = null;
  let names: string[] = ["", "", ""];
  let speed: number = SPEEDS[0];
  let rows: ResultRow[] = [];
  let videoUrl: string | null = null;
  // The camera for the game's turns: a loading card, a card when it fails, the simulated player (?demo=1).
  const camera = guardCamera(deps, () => goHome());
  installFeel();

  const guideCanvas = $<HTMLCanvasElement>("guideCanvas");
  const playerCanvas = $<HTMLCanvasElement>("youCanvas");
  const revealCanvas = $<HTMLCanvasElement>("revealStage");
  // Fast forward and skip for the reveal: blind.ts reads `speed` every tick while the reveal records.
  const revealControl = { speed: 1 };
  const setPace = (speed: number) => { revealControl.speed = speed; $("revealFastLabel").textContent = `${speed}x`; };
  $("revealFast").addEventListener("click", () => { const steps = [1, 2, 4]; setPace(steps[(steps.indexOf(revealControl.speed) + 1) % steps.length] ?? 1); });
  $("revealSkip").addEventListener("click", () => setPace(16));
  const turn = $("screen-turn");

  // ---- Start ----

  const bankBox = $("bank");
  document.body.dataset.mode = mode;
  // Team tools (the testing upload, the practice area, the empty bank note) show only on a local dev server
  // or with ?dev=1, never to visitors on the live site. ?dev=0 shows the visitor's page on a dev server.
  const devParam = new URLSearchParams(location.search).get("dev");
  document.body.classList.toggle("dev", devParam !== null ? devParam !== "0" : ["localhost", "127.0.0.1"].includes(location.hostname));

  const keyOf = (p: Pick) => (p.kind === "surprise" ? "surprise" : p.kind === "bank" ? `bank:${p.clip.id}` : `starter:${p.starter.id}`);

  /** One taped photo per clip. In blind mode the picture stays under a question mark. */
  function card(p: Pick, i: number): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "clip" + (p.kind === "surprise" ? " surprise" : "");
    b.dataset.key = keyOf(p);
    const tape = ["pink", "mint", "dots"][i % 3];
    b.innerHTML = `<span class="washi w-${tape}" aria-hidden="true"></span><span class="clip-pic" aria-hidden="true"><span class="clip-q">?</span></span><span class="clip-name"></span><span class="clip-hint"></span><span class="clip-credit"></span><svg class="clip-star" aria-hidden="true"><use href="#star" /></svg>`;
    if (p.kind === "bank" && p.clip.poster) {
      // The poster url comes from the bank, so set it as an attribute rather than writing it into markup.
      const img = document.createElement("img");
      img.src = p.clip.poster;
      img.alt = "";
      b.querySelector(".clip-pic")!.prepend(img);
    }
    const [name, hint, credit] = p.kind === "surprise" ? ["Surprise me", "A clip from the bank. Nobody sees it until the end.", ""]
      : p.kind === "bank" ? [p.clip.title, castLine(p.clip.people, p.clip.things, p.clip.durationMs), p.clip.credit ? `by ${p.clip.credit}` : ""]
      : [p.starter.title, p.starter.hint, ""];
    b.querySelector(".clip-name")!.textContent = name;
    b.querySelector(".clip-hint")!.textContent = hint;
    b.querySelector(".clip-credit")!.textContent = credit;
    b.addEventListener("click", () => choose(p));
    return b;
  }

  function renderBank() {
    const picks: Pick[] = bank.length
      ? [...(mode === "blind" && bank.length > 1 ? [{ kind: "surprise" } as Pick] : []), ...bank.map((clip): Pick => ({ kind: "bank", clip }))]
      : STARTERS.map((starter): Pick => ({ kind: "starter", starter }));
    bankBox.replaceChildren(...picks.map(card));
    // A note for the team only: visitors just see the starter clips.
    const note = $("bankNote");
    note.hidden = bank.length > 0 || !document.body.classList.contains("dev");
    note.textContent = "The bank is empty. Add clips with the bank tool. Until then, here are the starter clips.";
    // Keep the pick if it is still on screen, else the first card.
    const keep = pick && picks.find((p) => keyOf(p) === keyOf(pick!));
    choose(keep ?? picks[0] ?? null);
  }

  function choose(p: Pick | null) {
    pick = p;
    for (const b of bankBox.querySelectorAll<HTMLButtonElement>(".clip")) b.setAttribute("aria-pressed", String(!!p && b.dataset.key === keyOf(p)));
    $("playLabel").textContent = !p ? "Play" : p.kind === "surprise" ? "Play a surprise clip" : `Play ${p.kind === "bank" ? p.clip.title : p.starter.title}`;
    $<HTMLButtonElement>("play").disabled = !p;
  }

  // The two modes are one switch; the picked mode's line shows once, under it.
  const sayMode = () => {
    const picked = document.querySelector<HTMLButtonElement>(`.mode[data-mode="${mode}"] span`);
    $("modeSays").textContent = picked?.textContent ?? "";
  };
  for (const b of document.querySelectorAll<HTMLButtonElement>(".mode[data-mode]")) {
    b.addEventListener("click", () => {
      mode = b.dataset.mode as Mode;
      document.body.dataset.mode = mode;
      for (const o of document.querySelectorAll<HTMLButtonElement>(".mode[data-mode]")) o.setAttribute("aria-checked", String(o === b));
      sayMode();
      renderBank();
    });
  }
  sayMode();

  void listBank().then((r) => {
    bank = r.data ?? [];
    renderBank();
    if (r.error) startProblem(`The bank did not load: ${r.error}`);
  });

  $("play").addEventListener("click", async () => {
    if (!pick) return;
    $("startProblem").hidden = true;
    if (pick.kind === "starter") { scene = pick.starter.make(); openCast(); return; }
    const clip = pick.kind === "bank" ? pick.clip : bank[Math.floor(Math.random() * bank.length)];
    if (!clip) return;
    const r = await bankScene(clip, deps.clipVideo);
    if (r.error !== null) return startProblem(r.error);
    scene = r.data;
    openCast();
  });

  // ---- Submit your own: present but quiet ----

  $("submitForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = $<HTMLInputElement>("submitFile").files?.[0];
    const problem = $("submitProblem");
    const say = (text: string) => { problem.textContent = text; problem.hidden = false; };
    problem.hidden = true;
    if (!file) return say("Pick a clip to send.");
    if (!$<HTMLInputElement>("submitConsent").checked) return say("Tick the line about who is in it to send it.");
    const title = $<HTMLInputElement>("submitTitle").value.trim();
    if (!title) return say("Name the move or dance in your clip.");
    const send = $<HTMLButtonElement>("submitSend");
    const bar = $<HTMLProgressElement>("submitBar");
    send.disabled = true; bar.hidden = false; bar.value = 0;
    const credit = $<HTMLInputElement>("submitCredit").value.trim();
    const r = await submitClip(file, { title, ...(credit ? { credit } : {}) }, (share) => { bar.value = share; });
    send.disabled = false; bar.hidden = true;
    if (r.error !== null) return say(r.error);
    $("submitForm").hidden = true;
    $("submitThanks").hidden = false;
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
    game = new AbortController();
    const signal = game.signal;
    restartsLeft.clear();
    for (const n of cast) restartsLeft.set(n, RESTARTS_PER_PLAYER);
    running = true;
    try {
      if (mode === "watch") await watchFirst(scene);
      await runBlindGame(scene, cast, ui, { ...deps, getCamera: camera.getCamera, simMode: camera.simMode }, { speed, colors: playerColors(), theme: revealTheme() });
    } catch (err) {
      if (signal.aborted) return; // they left on purpose
      // Never stall silently: say what broke and offer a way back.
      console.error("The game stopped:", err);
      $("oopsText").textContent = (err as Error).message;
      show("oops");
    } finally {
      running = false;
    }
  }

  // ---- Play with friends online ----
  // Each player plays their own part on their own device, so there is no "pass the laptop" screen: the handover
  // is skipped, nobody's results are shown until everyone is in, then everyone sees the same reveal and results.

  const lobby = initRoomLobby({ clipVideo: deps.clipVideo, show: () => show("room"), goHome: () => goHome(), onRound: (room, round) => { void runOnline(room, round); } });

  /** The scene a round names: built in, from the bank, or the host's upload (the host has it; the others wait for it). */
  async function sceneForRound(room: LobbyRoom, round: OnlineRound): Promise<{ data: Scene; error: null } | { data: null; error: string }> {
    const make = ONLINE_SCENES[round.clipId as OnlineSceneId];
    if (make) return { data: make(), error: null };
    if (round.clipId.startsWith(BANK_PREFIX)) return sceneFromBank(round.clipId.slice(BANK_PREFIX.length), deps.clipVideo);
    if (round.clipId === UPLOAD_ID) {
      const mine = getHostUpload();
      if (room.isHost && mine) return { data: mine, error: null };
      return waitForUploadedScene(room as never);
    }
    return { data: null, error: "This clip is not one this copy of the game knows." };
  }

  async function runOnline(room: LobbyRoom, round: OnlineRound) {
    const made = await sceneForRound(room, round);
    if (made.error !== null) { startProblem(made.error); show("room"); return; }
    const played = made.data;
    scene = played;
    await Promise.all(["700 40px Gaegu", "400 40px Gaegu", "40px 'Titan One'"].map((f) => document.fonts.load(f).catch(() => [])));
    rows = [];
    videoUrl = null;
    game = new AbortController();
    restartsLeft.clear();
    restartsLeft.set(room.name, RESTARTS_PER_PLAYER);
    running = true;
    const colors = playerColors();
    const roster = room.roster() as { id: string; name: string }[];
    const colorOf = (id: string) => colors[Math.max(0, roster.findIndex((p) => p.id === id)) % colors.length]!;
    const onlineUi: BlindUi = { ...ui, handover: async () => {}, results: () => {} };
    try {
      const mine = await playMyRole(room as never, played, onlineUi, deps, { speed: round.extra?.speed ?? 1, colors: [colorOf(room.me)], theme: revealTheme(), reveal: false });
      await sendMyMedia(room as never, mine); // my face and cutouts go to the others in the room
      // Wait for the others, on the drum roll screen.
      while (!room.allDone) { live(); await ui.beat?.(); }
      await whenMediaIn(room as never); // their pictures, so the recap and the crowning show real people
      live();
      const standings = room.standings() as { id: string; name: string; score: number | null; timeline: unknown; media?: Record<string, string>; extra: { guideIndex: number; role: string; part?: string; lagMs?: number } | null }[];
      const results: RemoteResult[] = await Promise.all(standings.filter((s) => s.extra && played.guides[s.extra.guideIndex]).map(async (s) => ({
        name: s.name, color: colorOf(s.id), guideIndex: s.extra!.guideIndex, part: (s.extra!.part ?? "body") as BodyPart, score: s.score, tier: null, lagMs: s.extra!.lagMs ?? 0,
        timeline: s.timeline ? (deserializeTimeline(s.timeline) as unknown as RemoteResult["timeline"]) : null,
        // My own pictures are already here at full size; the others' arrive packed.
        cutouts: s.id === room.me ? [...(mine.layer?.cutouts ?? [])] : await unpackCutouts(s.media?.cuts),
        face: s.id === room.me ? mine.face : await unpackFace(s.media?.face),
      })));
      // What this device got from each player, for finding out why someone is missing from a recap.
      const summary = results.map((r) => ({ name: r.name, cutouts: r.cutouts?.length ?? 0, face: !!r.face, poseFrames: r.timeline?.frames.length ?? 0 }));
      console.info("[online] recap inputs", summary);
      (window as unknown as { __jesterRecap?: unknown }).__jesterRecap = summary;
      // The same reveal as a game on one laptop (title card, cast over the clip, side by side, cast card), then the
      // crowning and results. Remote players are drawn as their stick figures.
      await revealRemoteGame(played, results, ui, { speed: round.extra?.speed ?? 1, colors, theme: revealTheme() });
      live();
    } catch (err) {
      if (game?.signal.aborted) return; // they left on purpose
      console.error("The online game stopped:", err);
      $("oopsText").textContent = (err as Error).message;
      show("oops");
    } finally {
      running = false;
    }
  }

  // ---- Home, leaving, and starting a turn over ----

  /** The game under way: leaving aborts it, so its pending screens stop waiting and a new game never collides. */
  let game: AbortController | null = null;
  let running = false;
  const sig = () => game?.signal;
  const live = () => { if (game?.signal.aborted) throw left(); };
  /** The current turn's restart, kept so leaving mid-turn can end the turn at once. */
  let activeRestart: (() => void) | null = null;
  let restartTimer = 0;
  const restartsLeft = new Map<string, number>();
  let currentPlayer = "";

  function hideRestart() {
    clearTimeout(restartTimer);
    $("restart").hidden = true;
  }

  function goHome() {
    lobby.leave(); // out of any room too
    if (game && !game.signal.aborted) {
      game.abort();
      activeRestart?.(); // ends a turn in progress straight away
    }
    activeRestart = null;
    hideRestart();
    stopPodium();
    show("start");
  }

  const leaveDialog = $<HTMLDialogElement>("leaveDialog");
  $("home").addEventListener("click", () => {
    const screen = document.body.dataset.screen as ScreenName;
    // The crowning runs after the game itself has finished, so it is checked by name.
    if ((running && MID_GAME.includes(screen)) || screen === "crown") leaveDialog.showModal();
    else goHome();
  });
  $("leaveStay").addEventListener("click", () => leaveDialog.close());
  $("leaveGo").addEventListener("click", () => { leaveDialog.close(); goHome(); });

  $("restartGo").addEventListener("click", () => {
    const restart = activeRestart;
    if (!restart) return;
    restartsLeft.set(currentPlayer, Math.max(0, (restartsLeft.get(currentPlayer) ?? 0) - 1));
    hideRestart();
    $("partProblem").textContent = "Starting over. Take your time; that was your one start over this game.";
    $("partProblem").hidden = false;
    restart();
  });

  // ---- How to play ----

  $("howtoLink").addEventListener("click", () => show("howto"));
  $("howtoGo").addEventListener("click", () => {
    try { localStorage.setItem(HOWTO_SEEN, "1"); } catch { /* private window: it just shows again next time */ }
    show("start");
  });

  /** Watch first: the whole group watches the clip once (or more) before the parts are dealt. */
  async function watchFirst(s: Scene) {
    show("watch");
    const canvas = $<HTMLCanvasElement>("watchStage");
    canvas.height = Math.round(canvas.width * (s.height / s.width));
    const ctx = canvas.getContext("2d")!;
    let raf = 0;
    const play = () => {
      cancelAnimationFrame(raf);
      const t0 = performance.now();
      if (s.video) { s.video.currentTime = s.startMs / 1000; void playWithSound(s.video); }
      const frame = () => {
        const ms = performance.now() - t0;
        if (s.video) ctx.drawImage(s.video, 0, 0, canvas.width, canvas.height);
        else drawDemoScene(ctx, canvas.width, canvas.height, s, Math.min(ms, s.durationMs));
        if (ms < s.durationMs) raf = requestAnimationFrame(frame);
        else s.video?.pause();
      };
      raf = requestAnimationFrame(frame);
    };
    const again = $("watchAgain");
    again.addEventListener("click", play);
    play();
    try { await clicked($("watchGo"), sig()); }
    finally {
      again.removeEventListener("click", play);
      cancelAnimationFrame(raf);
      s.video?.pause();
    }
  }

  const ui: BlindUi = {
    async handover(player, previous) {
      live();
      camera.newTurn();
      activeRestart = null;
      hideRestart();
      show("handover");
      const screen = $("screen-handover");
      screen.style.setProperty("--who", player.color);
      letters($("handoverName"), player.name, player.color);
      $("handoverDone").textContent = previous ? `Nice one, ${previous.name}. Your score stays a secret until the end.` : "";
      $("handoverDone").hidden = !previous;
      const go = $<HTMLButtonElement>("handoverGo");
      go.querySelector(".ticket-text")!.textContent = `I'm ${player.name}`;
      go.focus();
      await clicked(go, sig());
    },

    async showPart(player, role) {
      live();
      activeRestart = null;
      hideRestart();
      // A start over keeps its own note; anything else clears it.
      const startingOver = currentPlayer === player.name && $("partProblem").textContent!.startsWith("Starting over");
      currentPlayer = player.name;
      show("turn");
      turn.dataset.state = "part";
      turn.style.setProperty("--who", player.color);
      $("turnName").textContent = `${player.name}'s turn`;
      $("turnSecret").textContent = mode === "watch" ? "You saw the clip. This shape is your part." : "What are you? You'll find out at the end.";
      // The game's own explanation is long; the screen says it in two lines.
      $("partText").textContent = "Copy this shape like a mirror. Move when it moves.";
      if (!startingOver || role.problem) {
        $("partProblem").textContent = role.problem ? camera.partNote() ?? role.problem : "";
        $("partProblem").hidden = !role.problem;
      }
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
      try { await clicked($("partGo"), sig()); }
      finally { watch.removeEventListener("click", onWatch); }
      $("partProblem").hidden = true;
      return chosen;
    },

    // Switch to the playing layout first (role left, you right), so the role is sized for its half.
    playStage: () => { turn.dataset.state = "play"; return { guideCanvas, playerCanvas, cam: deps.cam }; },

    async countdown(seconds) {
      // The countdown is the moment the turn starts (playStage has already switched to the playing layout).
      turn.dataset.state = "play";
      const el = $("count");
      el.hidden = false;
      for (let s = seconds; s > 0; s--) {
        el.textContent = String(s);
        el.classList.remove("tick");
        void el.offsetWidth; // restart the tick animation
        el.classList.add("tick");
        sfx.tick(s);
        try { await wait(1000, sig()); } catch (err) { el.hidden = true; throw err; }
      }
      el.hidden = true;
      sfx.go();
    },

    turnStarted(restart) {
      activeRestart = restart;
      if ((restartsLeft.get(currentPlayer) ?? 0) <= 0) return;
      // Only in the first few seconds: after that the moves have been seen, so no peeking and retrying.
      const box = $("restart");
      box.hidden = false;
      box.style.setProperty("--window", `${RESTART_WINDOW_MS}ms`);
      box.classList.remove("running");
      void box.offsetWidth;
      box.classList.add("running");
      clearTimeout(restartTimer);
      restartTimer = window.setTimeout(hideRestart, RESTART_WINDOW_MS);
    },

    async beat() {
      live();
      activeRestart = null;
      hideRestart();
      show("drumroll");
      say("beat");
      const roll = sfx.drumRoll();
      try { await waitOrSkip(1500, sig()); } finally { roll(); }
    },

    revealCanvas: () => revealCanvas,
    revealControl,

    progress(share) {
      $<HTMLProgressElement>("revealBar").value = share;
    },

    results(r) {
      live();
      setPace(1);
      rows = [...r].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
      // Load every player's jester while the reveal plays, so the crowning starts without a pop.
      preloadJesters(r.map((row) => variantOf(row)));
      show("reveal");
    },

    async revealReady(url) {
      if (game?.signal.aborted) return;
      videoUrl = url;
      // The game itself has finished; the crowning and results need no leave check.
      running = false;
      try { await crown(); } catch { return; /* left from the crowning */ }
      showResults();
    },
  };

  /** Each player wears the jester colourway that matches their colour (player 1 is p1, and so on). */
  function variantOf(row: ResultRow) {
    const i = playerColors().indexOf(row.color);
    return variantFor(i < 0 ? rows.indexOf(row) : i);
  }

  // ---- The crowning ----

  /**
   * Every player's jester stands on the stage wearing their face. A drum roll, a spotlight sweeps across them
   * and lands on the winner, who does the win dance while the rest slump. Resolves on "See the scores".
   */
  async function crown() {
    show("crown");
    // Stand them in seat order, not score order, so the spotlight has somewhere to travel.
    const seated = [...rows].sort((a, b) => playerColors().indexOf(a.color) - playerColors().indexOf(b.color));
    const castRow = $("crownCast");
    const jesters = seated.map((row) => {
      const j = new FaceJester(row.face, variantOf(row), 320);
      const slot = document.createElement("figure");
      slot.className = "cast-slot";
      slot.style.setProperty("--who", row.color);
      const name = document.createElement("figcaption");
      name.className = "tape";
      name.textContent = row.name;
      slot.append(j.canvas, name);
      return { row, j, slot };
    });
    castRow.replaceChildren(...jesters.map((x) => x.slot));
    const winners = rows.filter((r) => r.winner);
    const headline = winners.length === 0 ? "Everyone played!" : winners.length === 1 ? `${winners[0]!.name} wins!` : `${winners.map((w) => w.name).join(" and ")} tie!`;
    const spot = $("crownSpot");
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let cancel = false;
    // The drum roll plays while the spotlight sweeps; only the latest run may land the crash.
    let roll = () => {};
    let runs = 0;

    const run = async () => {
      cancel = false;
      const mine = ++runs;
      roll();
      roll = sfx.drumRoll();
      say("roll");
      $("crownWinner").hidden = true;
      $("crownAsk").hidden = false;
      $("crownDrum").hidden = false;
      $("screen-crown").dataset.phase = "roll";
      for (const x of jesters) { x.slot.classList.remove("won", "lost"); x.j.play("idle"); }
      const centre = (slot: HTMLElement) => {
        const a = slot.getBoundingClientRect(), b = $("crownStage").getBoundingClientRect();
        return ((a.left + a.width / 2 - b.left) / b.width) * 100;
      };
      const target = jesters.find((x) => x.row.winner) ?? jesters[0];
      if (!target) return;
      if (!reduce) {
        // The spotlight sweeps across everyone twice, slowing down, then settles on the winner.
        const stops = [...jesters, ...jesters].map((x) => centre(x.slot));
        stops.push(centre(target.slot));
        const legMs = (k: number) => 260 + k * 70;
        for (let k = 0; k < stops.length && !cancel; k++) {
          spot.style.transition = `left ${legMs(k)}ms cubic-bezier(.45, 0, .55, 1)`;
          spot.style.left = `${stops[k]}%`;
          await wait(legMs(k));
        }
        await wait(350);
      }
      if (cancel) return;
      if (mine === runs) {
        roll();
        sfx.crown();
        say(winners.length === 0 ? "nobody" : winners.length > 1 ? "tie" : "crown", { winner: winners.map((w) => w.name).join(" and ") });
      }
      spot.style.transition = "none";
      spot.style.left = `${centre(target.slot)}%`;
      $("screen-crown").dataset.phase = "won";
      $("crownDrum").hidden = true;
      $("crownAsk").hidden = true;
      letters($("crownWinner"), headline);
      $("crownWinner").hidden = false;
      for (const x of jesters) {
        const won = x.row.winner;
        x.slot.classList.add(won ? "won" : "lost");
        x.j.play(won ? "win" : "lose");
      }
    };

    const again = () => { cancel = true; void run(); };
    $("crownAgain").addEventListener("click", again);
    void run();
    try { await clicked($("crownGo"), sig()); }
    finally {
      cancel = true;
      roll();
      $("crownAgain").removeEventListener("click", again);
      for (const x of jesters) x.j.stop();
    }
  }

  // ---- Results ----

  /** The podium's animated jesters and the looping reveal video, stopped when the results screen is left. */
  let podiumJesters: FaceJester[] = [];
  const stopPodium = () => {
    for (const j of podiumJesters) j.stop();
    podiumJesters = [];
    // The video loops with its sound: without this it keeps playing under the next game.
    $<HTMLVideoElement>("resultsVideo").pause();
  };

  /**
   * Starts the reveal video on the results: with its sound, or muted where the browser will not allow sound
   * yet (the controls can unmute it). The recording normally has its length written in (cutout.ts); if it
   * does not, one jump to the end makes the browser find it, so the seek bar still works.
   */
  async function playResultsVideo(video: HTMLVideoElement) {
    const src = video.src;
    const findLength = () => {
      if (video.src !== src || Number.isFinite(video.duration)) return;
      const back = () => {
        if (!Number.isFinite(video.duration)) return;
        video.removeEventListener("durationchange", back);
        if (video.src === src) video.currentTime = 0;
      };
      video.addEventListener("durationchange", back);
      video.currentTime = 1e9;
    };
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) findLength();
    else video.addEventListener("loadedmetadata", findLength, { once: true });
    // Straight away, still inside the click on "See the scores", so browsers that want a click allow the sound.
    await playWithSound(video);
  }

  function showResults() {
    stopPodium();
    const winners = rows.filter((r) => r.winner);
    const headline = winners.length === 0 ? "Everyone played!"
      : winners.length === 1 ? `${winners[0]!.name} wins!`
      : `${winners.map((w) => w.name).join(" and ")} tie!`;
    letters($("resultsHeadline"), headline);
    const list = $("podium");
    list.innerHTML = "";
    // Everyone leaves with something: the crown, or an award from how they played.
    const awards = awardsFor(rows.map((r) => ({ score: r.score, winner: r.winner, motion: motionOf(r.timeline) })));
    rows.forEach((r, i) => {
      // Tied scores share a place.
      const place = 1 + rows.filter((o) => (o.score ?? -1) > (r.score ?? -1)).length;
      const li = document.createElement("li");
      li.className = "place" + (r.winner ? " won" : "");
      li.style.setProperty("--who", r.color);
      li.style.setProperty("--i", String(i));
      li.innerHTML = `<span class="badge"></span><span class="place-who"><span class="place-rank"></span><b class="tape"></b><span class="place-part"></span><span class="aside place-award"></span></span><span class="place-score"></span>`;
      li.querySelector(".place-rank")!.textContent = ordinal(place);
      // Each player's own jester, wearing their face: the winner holds the win pose, the rest their slump.
      const j = new FaceJester(r.face, variantOf(r), 200);
      j.canvas.setAttribute("aria-label", `${r.name} as a jester`);
      li.querySelector(".badge")!.appendChild(j.canvas);
      j.play(r.winner ? "win" : "lose");
      podiumJesters.push(j);
      li.querySelector("b")!.textContent = r.name;
      li.querySelector(".place-part")!.textContent = `was ${r.role}`;
      li.querySelector(".place-award")!.textContent = awards[i]!;
      const score = li.querySelector<HTMLElement>(".place-score")!;
      if (r.score == null) score.textContent = "no score";
      else countUp(score, r.score, 250 + i * 180);
      list.appendChild(li);
    });
    sfx.fanfare();
    // The host speaks once the fanfare has played.
    const top = winners[0];
    if (top) window.setTimeout(() => { if (document.body.dataset.screen === "results") say("results", { winner: winners.map((w) => w.name).join(" and "), title: rankFor(top.score).title }); }, 1800);
    const video = $<HTMLVideoElement>("resultsVideo");
    const save = $<HTMLAnchorElement>("resultsSave");
    if (videoUrl) {
      video.src = videoUrl;
      video.hidden = false;
      save.href = videoUrl;
      save.hidden = false;
      void playResultsVideo(video);
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

  $("again").addEventListener("click", () => { stopPodium(); if (scene) openCast(); else show("start"); });
  $("newClip").addEventListener("click", () => { stopPodium(); show("start"); });
  $("oopsBack").addEventListener("click", () => show("start"));

  // Every loading bar, here and in the practice area, gets the running jester.
  jesterBars(document);

  let seen = false;
  try { seen = localStorage.getItem(HOWTO_SEEN) === "1"; } catch { /* storage blocked: treat as seen, never trap them */ seen = true; }
  show(seen ? "start" : "howto");
}
