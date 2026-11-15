// The game's screens: start, cast, pass the laptop, your shape, play, the drum roll, the reveal, results.
// This file is Aaron's look and flow. It implements `BlindUi` for Alex's game (../blind.ts), which owns the
// rules, the camera, scoring and the reveal recording, and makes no DOM of its own.

import type { BodyPart } from "../../../engine/src/index.ts";
import { demoScene, dribbleScene, revealRemoteGame, runBlindGame, SPEEDS, videoScene, type BlindDeps, type BlindUi, type RemoteResult, type ResultRow, type Scene } from "../blind.ts";
import { listBank, type BankClip } from "../bank.ts";
import { castLine, playersFor, sentInBy } from "../castWords.ts";
import { bankScene } from "../bankRound.ts";
import { submitClip } from "../submit.ts";
import { rememberSubmission, watchSubmissions } from "../submissionWatch.ts";
import { playWithSound } from "../sound.ts";
import { FaceJester, preloadJesters, variantFor, variantOfColour, VARIANTS } from "./faceJester.ts";
import { JESTER_COLOURS } from "../clipside/puppet.ts";
import { jesterBars } from "./jesterBar.ts";
import { countUp, guardCamera, installFeel, waitOrSkip } from "./feel.ts"; // GAME FEEL (sounds, camera card, keys)
import { awardsFor, headlineFor, motionOf, rankFor, winnersOf } from "../feelText.ts";
import { DUEL_WINNER_AWARD, duelHeadline, podiumOrder } from "../duelPlay.ts";
import { say } from "../host.ts";
import * as sfx from "../sfx.ts";
import { PLAYER_COLORS } from "../../../spikes/pose-match/reveal.mjs";
import { deserializeTimeline } from "../../../spikes/pose-match/serialize.mjs";
import { BANK_PREFIX, UPLOAD_ID, getHostUpload, sceneFromBank, waitForUploadedScene } from "../onlineClip.ts";
import { initRoomLobby, ONLINE_SCENES, type LobbyRoom, type OnlineRound, type OnlineSceneId } from "./room.ts";
import { playMyRole, sendMyMedia, whenMediaIn } from "../onlineBlind.ts";
import { unpackCutouts, unpackFace } from "../packMedia.ts";
import { keepFinished, sameDancer } from "../recapRules.ts";

/** A CSS custom property from the skin, or the fallback. */
const cssVar = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/** Player colours come from the skin (--p1 to --p4), so the cast, the turn and the reveal all match it. */
const playerColors = () => [1, 2, 3, 4].map((i) => cssVar(`--p${i}`, PLAYER_COLORS[i - 1]!));
/** Every jester colour a player can pick: the skin's four player colours first, then the other colourways. */
const colourChoices = () => {
  const players = playerColors();
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  return [...players, ...JESTER_COLOURS.map((c) => c.main).filter((m) => !players.some((p) => same(p, m)))];
};
const colourName = (color: string) => JESTER_COLOURS.find((c) => c.main.toLowerCase() === color.trim().toLowerCase())?.name ?? "Your";

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

const SCREENS = ["howto", "start", "submit", "room", "reading", "cast", "handover", "turn", "drumroll", "reveal", "crown", "results", "oops"] as const;
type ScreenName = (typeof SCREENS)[number];
/** Screens where a game is under way: leaving from these asks first. */
const MID_GAME: readonly ScreenName[] = ["handover", "turn", "drumroll", "reveal"];

/** Shows one screen and hides the rest. The body carries the name too, so the look can theme per screen. */
function show(name: ScreenName) {
  for (const s of SCREENS) $(`screen-${s}`).hidden = s !== name;
  document.body.dataset.screen = name;
  // Home shows everywhere except the start screen and How to play; How to play's tag only on the start screen.
  $("gameNav").hidden = name === "start" || name === "howto";
  $("howtoLink").hidden = name !== "start";
  window.scrollTo(0, 0);
}

/** How many times each player may start their turn over, per game, and for how long after the countdown. */
const RESTARTS_PER_PLAYER = 1;
const RESTART_WINDOW_MS = 5000;
const HOWTO_SEEN = "jester.howtoSeen";

interface StarterClip { id: string; title: string; hint: string; make: () => Scene }

/** Blind: you only see your shape, everyone finds out at the end. Normal: you dance along with the clip itself. */
type Mode = "blind" | "normal";
/** What the Play ticket will start. A surprise is a random bank clip nobody sees first. */
type Pick = { kind: "bank"; clip: BankClip } | { kind: "starter"; starter: StarterClip } | { kind: "surprise" };

/** Lower case, accents and punctuation gone, so "BESTie" and "bestie" and "love-options" all match. */
const searchable = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

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
  // Letters are grouped by word (each word keeps its trailing space), so a long line such as "Lisa and Aaron
  // tie!" wraps between words on a phone, never in the middle of one.
  let word: HTMLSpanElement | null = null;
  [...text].forEach((ch, i) => {
    if (!word) { word = document.createElement("span"); word.className = "word"; wrap.appendChild(word); }
    const span = document.createElement("span");
    span.textContent = ch === " " ? "\u00a0" : ch;
    span.style.setProperty("--c", ch === " " ? "transparent" : color ?? STICKER_COLORS[i % STICKER_COLORS.length]!);
    span.style.setProperty("--r", `${TILT[i % TILT.length]}deg`);
    span.style.setProperty("--y", `${BOB[i % BOB.length]}px`);
    span.style.setProperty("--n", String(i));
    word.appendChild(span);
    if (ch === " ") word = null;
  });
  el.removeAttribute("aria-label");
  el.replaceChildren(said, wrap);
}

const ordinal = (n: number) => (n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`);

/** One player may play alone; a new cast still starts with two, since it is a party game. */
const MIN_PLAYERS = 1;
const MAX_PLAYERS = 4;

export function initGame(deps: GameDeps) {
  let scene: Scene | null = null;
  let mode: Mode = "blind";
  let bank: BankClip[] = [];
  let pick: Pick | null = null;
  /** The bank clip being cast, and its scene with every part; `scene` leaves out the things when they are off. */
  let castClip: BankClip | null = null;
  let fullScene: Scene | null = null;
  let names: string[] = ["", "", ""];
  /** Each seat's jester colour, picked on the cast screen; seats start on different colours. */
  let seatColors: string[] = [];
  /** The colours of the game being played, in seat order: the picked ones here, the roster's online. */
  let gameColors: string[] = [];
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
  const revealControl: { speed: number; skip?: boolean } = { speed: 1 };
  const setPace = (speed: number) => { revealControl.speed = speed; $("revealFastLabel").textContent = `${speed}x`; };
  $("revealFast").addEventListener("click", () => { const steps = [1, 2, 4]; setPace(steps[(steps.indexOf(revealControl.speed) + 1) % steps.length] ?? 1); });
  // Skip ends the recap at once and goes to the results (the video shows what was recorded so far).
  $("revealSkip").addEventListener("click", () => { revealControl.skip = true; setPace(16); });
  const turn = $("screen-turn");

  // ---- Start ----

  const bankBox = $("bank");
  document.body.dataset.mode = mode;
  // Team tools (the testing upload, the practice area, the empty bank note) show only on a local dev server
  // or with ?dev=1, never to visitors on the live site. ?dev=0 shows the visitor's page on a dev server.
  const devParam = new URLSearchParams(location.search).get("dev");
  document.body.classList.toggle("dev", devParam !== null ? devParam !== "0" : ["localhost", "127.0.0.1"].includes(location.hostname));

  const keyOf = (p: Pick) => (p.kind === "surprise" ? "surprise" : p.kind === "bank" ? `bank:${p.clip.id}` : `starter:${p.starter.id}`);

  // How you play: how many are playing (remembered), and for two or more how: taking turns on this laptop, a duel,
  // or each on your own device (the online room). Then a name to look for in the library.
  type How = "turns" | "duel" | "online";
  const PLAYERS_KEY = "jester.players";
  const HOW_KEY = "jester.how";
  const saved = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
  const keep = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* private mode: not remembered */ } };
  // A first visit starts at one player: a judge trying it alone is the likeliest first player.
  let count = Math.min(4, Math.max(1, Number(saved(PLAYERS_KEY)) || 1));
  let how: How = (["turns", "duel", "online"] as const).find((h) => h === saved(HOW_KEY)) ?? "turns";
  let query = "";
  /** The library first shows the clips made for this many players; this shows the rest too. */
  let showAll = false;
  /** Each clip with a thing in it (a ball, a dog) plays the thing as a part unless the cast screen turns it off. */
  const thingsOff = new Set<string>();
  const withThingsFor = (c: BankClip) => !thingsOff.has(c.id);
  const partsOf = (c: BankClip) => playersFor(c.people, c.things, withThingsFor(c));
  const isDuel = () => count >= 2 && how === "duel";
  const isOnline = () => count >= 2 && how === "online";
  // Made for this many: one player gets one-part clips, a duel one-person clips, taking turns a part each.
  const madeFor = (c: BankClip) => (isDuel() ? c.people === 1 : count === 1 ? partsOf(c) === 1 : partsOf(c) >= count);
  // The rest, behind "Show bigger clips too" (one player plays one part) or "Show smaller clips too" (some share).
  // A duel needs one person, so it has no rest.
  const fits = (c: BankClip) => madeFor(c) || (showAll && !isDuel());
  /** The clips the library shows right now, the ones made for this many first. */
  const shown = () => bank.filter((c) => fits(c) && (!query || searchable(c.title).includes(query))).sort((x, y) => Number(madeFor(y)) - Number(madeFor(x)));
  /** Surprise me draws from what the library shows, the name search aside. */
  const surprises = () => bank.filter(fits);
  /** "for 2 players", "for a duel". */
  const forPick = () => (isDuel() ? "for a duel" : `for ${count} ${count === 1 ? "player" : "players"}`);

  /** Little performers on a lit backdrop: one per person, and a ball for the clip's things when they are parts. */
  function performers(c: BankClip): string {
    const people = Math.min(5, c.people);
    const things = withThingsFor(c) ? Math.min(2, c.things) : 0;
    const w = people * 46 + things * 30 + 8;
    const figs = Array.from({ length: people }, (_, i) => `<use href="/art.svg#player" x="${4 + i * 46}" y="4" width="46" height="62" />`).join("")
      + Array.from({ length: things }, (_, i) => `<use href="/art.svg#ball" x="${8 + people * 46 + i * 30}" y="44" width="22" height="22" />`).join("");
    return `<svg class="clip-cast" viewBox="0 0 ${w} 70" preserveAspectRatio="xMidYMax meet">${figs}</svg>`;
  }

  /** One taped photo per clip. In Blind the picture stays hidden and its performers stand in for it. */
  function card(p: Pick, i: number): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "clip";
    b.dataset.key = keyOf(p);
    const tape = ["mint", "dots", "pink"][i % 3]!;
    b.style.setProperty("--pic", tape === "mint" ? "var(--p4)" : tape === "dots" ? "var(--ticket)" : "var(--p1)");
    const art = p.kind === "bank" ? performers(p.clip) : `<span class="clip-q">?</span>`;
    b.innerHTML = `<span class="washi w-${tape}" aria-hidden="true"></span><span class="clip-pic" aria-hidden="true">${art}</span><span class="clip-name"></span><span class="clip-hint"></span><span class="clip-credit"></span><svg class="clip-star" aria-hidden="true"><use href="#star" /></svg>`;
    if (p.kind === "bank" && p.clip.poster) {
      // The poster url comes from the bank, so set it as an attribute rather than writing it into markup.
      const img = document.createElement("img");
      img.src = p.clip.poster;
      img.alt = "";
      b.querySelector(".clip-pic")!.prepend(img);
    }
    const [name, hint, credit] = p.kind === "bank" ? [p.clip.title, castLine(p.clip.people, p.clip.things, p.clip.durationMs, withThingsFor(p.clip)), sentInBy(p.clip.credit)]
      : p.kind === "starter" ? [p.starter.title, p.starter.hint, ""] : ["", "", ""];
    b.querySelector(".clip-name")!.textContent = name;
    b.querySelector(".clip-hint")!.textContent = hint;
    b.querySelector(".clip-credit")!.textContent = credit;
    b.addEventListener("click", () => choose(p));
    return b;
  }

  const surpriseCard = $<HTMLButtonElement>("surpriseCard");
  surpriseCard.addEventListener("click", () => choose({ kind: "surprise" }));

  function renderBank() {
    const list = shown();
    const picks: Pick[] = bank.length ? list.map((clip): Pick => ({ kind: "bank", clip })) : STARTERS.map((starter): Pick => ({ kind: "starter", starter }));
    bankBox.replaceChildren(...picks.map(card));
    // Surprise me needs the bank: the starters are only two, and nobody needs a surprise between two.
    surpriseCard.hidden = bank.length === 0;
    $("startOr").hidden = bank.length === 0;
    surpriseCard.disabled = surprises().length === 0;
    // In Blind a library pick still shows its name; a surprise keeps even that from whoever picked it.
    $("surpriseHint").textContent = `Any clip ${isDuel() ? "with one person" : showAll ? "shown here" : forPick()}.` + (mode === "blind" ? " Not even you know which." : "");
    $("libraryHead").hidden = bank.length === 0;
    $("libraryCount").textContent = `${list.length} ${list.length === 1 ? "clip" : "clips"}`;
    const rest = bank.filter((c) => !madeFor(c)).length;
    const more = $<HTMLButtonElement>("libraryMore");
    more.hidden = isDuel() || rest === 0;
    more.textContent = showAll ? (count === 1 ? "Hide bigger clips" : "Hide smaller clips") : (count === 1 ? "Show bigger clips too" : "Show smaller clips too");
    // Each on your own device: the room has its own clip pick, so the library steps aside.
    $("screen-start").dataset.how = isOnline() ? "online" : "here";
    const none = $("libraryNone");
    none.hidden = !bank.length || list.length > 0;
    const wanted = $<HTMLInputElement>("clipSearch").value.trim();
    none.textContent = `No clip${wanted ? ` called "${wanted}"` : ""} ${forPick()} yet.`;
    // A note for the team only: visitors just see the starter clips.
    const note = $("bankNote");
    note.hidden = bank.length > 0 || !document.body.classList.contains("dev");
    note.textContent = "The bank is empty. Add clips with the bank tool. Until then, here are the starter clips.";
    // Keep the pick if it is still on screen, else Surprise me, else the first card.
    const onScreen = (p: Pick) => (p.kind === "surprise" ? !surpriseCard.hidden && !surpriseCard.disabled : picks.some((q) => keyOf(q) === keyOf(p)));
    const first: Pick | null = !surpriseCard.hidden && !surpriseCard.disabled ? { kind: "surprise" } : picks[0] ?? null;
    choose(pick && onScreen(pick) ? pick : first);
    fitRows();
  }

  // On a laptop the library is as tall as the room left on screen, cut down to whole rows: a photo cut in half at
  // its bottom edge reads as broken. It then scrolls a row at a time. A phone has one sideways row instead.
  const laptop = matchMedia("(min-width: 761px)");
  function fitRows() {
    const start = $("screen-start");
    bankBox.style.maxHeight = "";
    delete start.dataset.library;
    const first = bankBox.querySelector<HTMLElement>(".clip");
    if (!laptop.matches || !first || start.hidden) return;
    // Measured while the library still fills the room the page leaves it.
    const look = getComputedStyle(bankBox);
    const gap = parseFloat(look.rowGap) || 0;
    const pad = (parseFloat(look.paddingTop) || 0) + (parseFloat(look.paddingBottom) || 0);
    const row = first.offsetHeight + gap;
    const rows = Math.max(1, Math.floor((bankBox.clientHeight - pad + gap) / row));
    bankBox.style.maxHeight = `${rows * row - gap + pad}px`;
    start.dataset.library = "fitted";
  }
  addEventListener("resize", fitRows);
  new MutationObserver(fitRows).observe($("screen-start"), { attributes: true, attributeFilter: ["hidden"] });
  void document.fonts.ready.then(fitRows);

  function choose(p: Pick | null) {
    pick = p;
    for (const b of $("screen-start").querySelectorAll<HTMLButtonElement>(".clip")) b.setAttribute("aria-pressed", String(!!p && b.dataset.key === keyOf(p)));
    $("playLabel").textContent = isOnline() ? "Make or join a room" : !p ? "Play" : p.kind === "surprise" ? "Play a surprise clip" : `Play ${p.kind === "bank" ? p.clip.title : p.starter.title}`;
    $<HTMLButtonElement>("play").disabled = !p && !isOnline();
  }

  /** Shows `clip` in the library: the name search is cleared, and the pick changes to fit it if it has to. */
  function showInLibrary(clip: BankClip) {
    query = "";
    $<HTMLInputElement>("clipSearch").value = "";
    if (!fits(clip)) { showAll = true; if (isDuel() || isOnline()) setHow("turns"); }
    renderBank();
  }

  // The name search redraws the library as you type; a pick that drops out of view falls back to Surprise me.
  $<HTMLInputElement>("clipSearch").addEventListener("input", (e) => {
    query = searchable((e.target as HTMLInputElement).value);
    renderBank();
  });

  // The lines under the picks: the mode's, and for two or more, what the How? pick means.
  const sayMode = () => {
    const line = (text: string) => { const s = document.createElement("span"); s.textContent = text; return s; };
    const howSays = document.querySelector<HTMLButtonElement>(`[data-how="${how}"]`)?.dataset.says ?? "";
    // The room plays in the mode picked here too, so its line stays for every How?.
    const modeLine = line(document.querySelector(`.mode[data-mode="${mode}"] span`)?.textContent ?? "");
    $("modeSays").replaceChildren(modeLine, ...(count >= 2 ? [line(count === 2 ? howSays.replace("You all", "You both") : howSays)] : []));
  };
  function setCount(n: number) {
    count = n;
    showAll = false;
    keep(PLAYERS_KEY, String(n));
    for (const o of document.querySelectorAll<HTMLButtonElement>("[data-players]")) o.setAttribute("aria-checked", String(Number(o.dataset.players) === n));
    $("howPick").hidden = n < 2;
    sayMode();
  }
  function setHow(h: How) {
    how = h;
    keep(HOW_KEY, h);
    for (const o of document.querySelectorAll<HTMLButtonElement>("[data-how]")) o.setAttribute("aria-checked", String(o.dataset.how === h));
    sayMode();
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-players]")) {
    b.addEventListener("click", () => { setCount(Number(b.dataset.players)); renderBank(); });
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-how]")) {
    b.addEventListener("click", () => { setHow(b.dataset.how as How); renderBank(); });
  }
  $("libraryMore").addEventListener("click", () => { showAll = !showAll; renderBank(); });
  for (const b of document.querySelectorAll<HTMLButtonElement>(".mode[data-mode]")) {
    b.addEventListener("click", () => {
      mode = b.dataset.mode as Mode;
      document.body.dataset.mode = mode;
      for (const o of document.querySelectorAll<HTMLButtonElement>(".mode[data-mode]")) o.setAttribute("aria-checked", String(o === b));
      sayMode();
      renderBank();
    });
  }
  setHow(how);
  setCount(count);

  void listBank().then((r) => {
    bank = r.data ?? [];
    renderBank();
    if (r.error) startProblem(`The bank did not load: ${r.error}`);
  });

  // ---- Your clip is in: a clip sent from this tab joined the bank (submissionWatch.ts) ----
  let readyClip: BankClip | null = null;
  /** Playing it starts from the start screen, so mid-round the notice waits for the round to end. */
  const syncReady = () => {
    if (!readyClip) return;
    const between = document.body.dataset.screen === "start" || document.body.dataset.screen === "results";
    $("clipReadyText").textContent = between
      ? `Good news! "${readyClip.title}" is in the bank. The Chamberlain let it in.`
      : `Good news! "${readyClip.title}" is in the bank. It's on the start screen after this round.`;
    $("clipReadyPlay").hidden = !between;
  };
  new MutationObserver(syncReady).observe(document.body, { attributes: true, attributeFilter: ["data-screen"] });
  watchSubmissions((clip) => {
    if (!bank.some((c) => c.id === clip.id)) bank = [...bank, clip];
    renderBank();
    readyClip = clip;
    $("clipReady").hidden = false;
    syncReady();
  });
  $("clipReadyPlay").addEventListener("click", () => {
    const clip = readyClip;
    readyClip = null;
    $("clipReady").hidden = true;
    if (!clip) return;
    if (document.body.dataset.screen !== "start") show("start");
    // The library shows the new clip when it is picked.
    showInLibrary(clip);
    choose({ kind: "bank", clip });
  });
  $("clipReadyLater").addEventListener("click", () => {
    readyClip = null;
    $("clipReady").hidden = true;
  });

  $("play").addEventListener("click", async () => {
    // Each on your own device: the online room takes over from here, with its own clip pick.
    if (isOnline()) { $("playOnline").click(); return; }
    if (!pick) return;
    $("startProblem").hidden = true;
    if (pick.kind === "starter") { castClip = null; fullScene = scene = pick.starter.make(); openCast(); return; }
    // A surprise comes from the clips that fit how many of you there are.
    const from = surprises().length ? surprises() : bank;
    const clip = pick.kind === "bank" ? pick.clip : from[Math.floor(Math.random() * from.length)];
    if (!clip) return;
    // Loaded with its things; the cast screen's switch plays them as parts or leaves them out (sceneFor).
    const r = await bankScene(clip, deps.clipVideo);
    if (r.error !== null) return startProblem(r.error);
    castClip = clip;
    fullScene = r.data;
    scene = sceneFor();
    openCast();
  });

  /** The clip being cast, with its things as parts or people only, by its switch: what bankScene's withThings does. */
  function sceneFor(): Scene | null {
    if (!fullScene || !castClip || withThingsFor(castClip)) return fullScene;
    return { ...fullScene, guides: fullScene.guides.filter((g) => g.subject.kind === "person") };
  }
  /** A duel needs a clip with exactly one person and at least two of you. */
  const duelGame = () => isDuel() && castClip?.people === 1 && names.length >= 2;

  // ---- Send in a clip: an invite under the Play ticket opens its own screen ----

  $("submitOpen").addEventListener("click", () => {
    // After a clip went in, the next visit starts with an empty form again.
    if (!$("submitThanks").hidden) {
      $<HTMLFormElement>("submitForm").reset();
      $("submitForm").hidden = false;
      $("submitThanks").hidden = true;
      $("submitProblem").hidden = true;
    }
    show("submit");
  });
  $("submitBack").addEventListener("click", () => show("start"));

  $("submitForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = $<HTMLInputElement>("submitFile").files?.[0];
    const problem = $("submitProblem");
    const say = (text: string) => { problem.textContent = text; problem.hidden = false; };
    problem.hidden = true;
    if (!file) return say("Pick a clip to send.");
    const title = $<HTMLInputElement>("submitTitle").value.trim();
    if (!title) return say("Give your clip a name.");
    const send = $<HTMLButtonElement>("submitSend");
    const bar = $<HTMLProgressElement>("submitBar");
    send.disabled = true; bar.hidden = false; bar.value = 0;
    const credit = $<HTMLInputElement>("submitCredit").value.trim();
    const r = await submitClip(file, { title, ...(credit ? { credit } : {}) }, (share) => { bar.value = share; });
    send.disabled = false; bar.hidden = true;
    if (r.error !== null) return say(r.error);
    // This tab watches the bank for it, and says so when it is let in (submissionWatch.ts).
    void rememberSubmission(file, title);
    $("submitForm").hidden = true;
    $("submitThanks").hidden = false;
  });

  // Send another: the form comes back empty, and the clip just sent is still watched (submissionWatch.ts).
  $("submitAgain").addEventListener("click", () => {
    $<HTMLFormElement>("submitForm").reset();
    $("submitProblem").hidden = true;
    $("submitThanks").hidden = true;
    $("submitForm").hidden = false;
    $<HTMLInputElement>("submitFile").focus();
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
      castClip = null;
      fullScene = scene = s;
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

  /**
   * Opens "Who's playing?". The cast starts with the number of players picked on the start screen; with no pick,
   * one player per part of the clip (so a one-person clip opens with one player). `again` keeps the cast as it
   * was, for Play again. Add a player and One fewer still change it.
   */
  function openCast(again = false) {
    if (!scene) return;
    $("startProblem").hidden = true;
    // As many seats as the start screen's pick; more players than parts share them, fewer leave some out.
    const want = again && names.length ? names.length : Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, count));
    names = Array.from({ length: want }, (_, i) => names[i] ?? "");
    renderCast();
    show("cast");
    ($("castNames").querySelector("input") as HTMLInputElement | null)?.focus();
  }

  /** Gives every seat a colour no other seat has, keeping the ones already picked. */
  function settleColors() {
    const choices = colourChoices();
    seatColors = seatColors.slice(0, names.length);
    names.forEach((_, i) => {
      const taken = seatColors.slice(0, i);
      if (!seatColors[i] || taken.includes(seatColors[i]!)) seatColors[i] = choices.find((c) => !taken.includes(c) && !seatColors.slice(i + 1).includes(c)) ?? choices[i % choices.length]!;
    });
  }

  /** Seat `i` moves on to the next colour nobody else is wearing. */
  function nextColor(i: number) {
    const choices = colourChoices();
    const others = seatColors.filter((_, k) => k !== i);
    const at = choices.indexOf(seatColors[i]!);
    for (let step = 1; step <= choices.length; step++) {
      const c = choices[(at + step) % choices.length]!;
      if (!others.includes(c)) { seatColors[i] = c; return; }
    }
  }

  function renderCast() {
    const parts = scene?.guides.length ?? names.length;
    const extra = names.length - parts;
    $("castParts").textContent = (duelGame()
      ? `${names.length === 2 ? "You both" : "You all"} copy the same person. Best copy wins.`
      : (parts === 1 ? "This clip has 1 part." : `This clip has ${parts} parts.`)
        + (names.length === 1 && parts > 1 ? " You play one of them." : extra === 1 ? " Two of you will share one." : extra > 1 ? " Some of you will share." : extra < 0 ? " Not every part gets played." : ""))
      + " Tap your dot to change your jester's colour.";
    // A clip with a thing in it: play the thing as a part, or people only. Not in a duel, where everyone is the person.
    $("castThing").hidden = !castClip || castClip.things === 0 || duelGame();
    for (const o of document.querySelectorAll<HTMLButtonElement>("[data-things]")) o.setAttribute("aria-checked", String((o.dataset.things === "on") === (!castClip || withThingsFor(castClip))));
    settleColors();
    const box = $("castNames");
    box.innerHTML = "";
    names.forEach((value, i) => {
      const row = document.createElement("label");
      row.className = "who";
      row.style.setProperty("--who", seatColors[i]!);
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "who-dot";
      dot.setAttribute("aria-label", `${colourName(seatColors[i]!)} jester. Change colour`);
      dot.title = "Change your jester's colour";
      dot.addEventListener("click", (e) => {
        e.preventDefault();
        nextColor(i);
        renderCast();
        box.querySelectorAll<HTMLButtonElement>(".who-dot")[i]?.focus();
      });
      const label = document.createElement("span");
      label.className = "who-label";
      label.textContent = `Player ${i + 1}`;
      row.append(dot, label);
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
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-things]")) {
    b.addEventListener("click", () => {
      if (!castClip) return;
      if (b.dataset.things === "on") thingsOff.delete(castClip.id); else thingsOff.add(castClip.id);
      scene = sceneFor();
      renderCast();
      // The clip's card on the start screen counts its players the same way.
      renderBank();
    });
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
    soloGame = cast.length === 1;
    game = new AbortController();
    const signal = game.signal;
    restartsLeft.clear();
    for (const n of cast) restartsLeft.set(n, RESTARTS_PER_PLAYER);
    running = true;
    try {
      settleColors();
      gameColors = seatColors.slice(0, cast.length);
      await runBlindGame(scene, cast, ui, { ...deps, getCamera: camera.getCamera, simMode: camera.simMode }, { speed, colors: seatColors.slice(0, cast.length), theme: revealTheme(), showClip: mode === "normal", ...(duelGame() ? { duel: true } : {}) });
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

  const lobby = initRoomLobby({ clipVideo: deps.clipVideo, mode: () => mode, show: () => show("room"), goHome: () => goHome(), onRound: (room, round) => { void runOnline(room, round); } });

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
    soloGame = false; // a room waits for the others on the drum roll, even with one player in it
    game = new AbortController();
    restartsLeft.clear();
    restartsLeft.set(room.name, RESTARTS_PER_PLAYER);
    running = true;
    const colors = playerColors();
    gameColors = colors;
    const roster = room.roster() as { id: string; name: string }[];
    const colorOf = (id: string) => colors[Math.max(0, roster.findIndex((p) => p.id === id)) % colors.length]!;
    const onlineUi: BlindUi = { ...ui, handover: async () => {}, results: () => {} };
    try {
      const mine = await playMyRole(room as never, played, onlineUi, deps, { speed: round.extra?.speed ?? 1, colors: [colorOf(room.me)], theme: revealTheme(), reveal: false, showClip: round.extra?.mode === "normal" });
      await sendMyMedia(room as never, mine); // my face and cutouts go to the others in the room
      // Wait for the others, on the drum roll screen.
      while (!room.allDone) { live(); await ui.beat?.(); }
      type Standing = { id: string; name: string; score: number | null; timeline: unknown; media?: Record<string, string>; extra: { guideIndex: number; role: string; part?: string; lagMs?: number } | null };
      // Everyone who finished, as of now: the room forgets a player it drops while their pictures are still coming.
      const finished = room.standings() as Standing[];
      await whenMediaIn(room as never); // their pictures, so the recap and the crowning show real people
      live();
      const standings = keepFinished(finished, room.standings() as Standing[]);
      const results: RemoteResult[] = await Promise.all(standings.filter((s) => s.extra && played.guides[s.extra.guideIndex]).map(async (s) => ({
        name: s.name, color: colorOf(s.id), guideIndex: s.extra!.guideIndex, part: (s.extra!.part ?? "body") as BodyPart, score: s.score, tier: null, lagMs: s.extra!.lagMs ?? null,
        timeline: s.timeline ? (deserializeTimeline(s.timeline) as unknown as RemoteResult["timeline"]) : null,
        // My own pictures are already here at full size; the others' arrive packed.
        cutouts: s.id === room.me ? [...(mine.layer?.cutouts ?? [])] : await unpackCutouts(s.media?.cuts),
        face: s.id === room.me ? mine.face : await unpackFace(s.media?.face),
      })));
      // What this device got from each player, for finding out why someone is missing from a recap.
      const summary = results.map((r) => ({ name: r.name, role: r.guideIndex, cutouts: r.cutouts?.length ?? 0, face: !!r.face, poseFrames: r.timeline?.frames.length ?? 0 }));
      console.info("[online] recap inputs", summary);
      // A dealt role with nobody on it in the recap: that dancer stays as filmed, neither covered nor replaced.
      const dealt = Object.keys(round.extra?.assign ?? {});
      const missing = dealt.filter((id) => !standings.some((s) => s.id === id));
      if (missing.length) console.warn("[online] dealt a role but missing from the recap:", missing, "players now:", standings.map((s) => s.id));
      // Two roles that follow the same dancer (a tracking slip in the clip) stack both players on one dancer.
      const people = played.guides.map((g, i) => ({ i, g })).filter(({ g }) => g.subject.kind === "person");
      for (let a = 0; a < people.length; a++) for (let b = a + 1; b < people.length; b++) {
        const share = sameDancer(people[a]!.g.boxTrack.frames.map((f) => f.box), people[b]!.g.boxTrack.frames.map((f) => f.box));
        if (share > 0.2) console.warn(`[online] roles ${people[a]!.i} and ${people[b]!.i} are on the same dancer in ${Math.round(share * 100)}% of the clip`);
      }
      (window as unknown as { __jesterRecap?: unknown }).__jesterRecap = summary;
      // The same reveal as a game on one laptop (title card, cast over the clip, side by side, cast card), then the
      // crowning and results. Remote players are drawn as their stick figures.
      // Only the host's laptop plays the recap's sound aloud, so laptops side by side do not play it twice, out of step.
      await revealRemoteGame(played, results, ui, { speed: round.extra?.speed ?? 1, colors, theme: revealTheme(), revealAloud: !!room.isHost });
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
  /** One player on their own: no passing the laptop, and the drum roll says so. */
  let soloGame = false;
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

  // ---- Sound: one switch for the game's sounds and the host's voice (sfx.ts keeps it, default on) ----

  const soundButton = $<HTMLButtonElement>("soundToggle");
  const showSound = () => {
    const on = sfx.soundOn();
    soundButton.setAttribute("aria-pressed", String(on));
    // Only the words change; the horn icon beside them follows aria-pressed in style.css.
    $("soundSay").textContent = on ? "Sound: on" : "Sound: off";
  };
  soundButton.addEventListener("click", () => { sfx.setSound(!sfx.soundOn()); showSound(); });
  showSound();

  // ---- How to play ----

  $("howtoLink").addEventListener("click", () => show("howto"));
  $("howtoGo").addEventListener("click", () => {
    try { localStorage.setItem(HOWTO_SEEN, "1"); } catch { /* private window: it just shows again next time */ }
    show("start");
  });

  const ui: BlindUi = {
    async handover(player, previous) {
      live();
      camera.newTurn();
      activeRestart = null;
      hideRestart();
      if (soloGame) return; // one player: nobody to pass the laptop to
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
      $("turnSecret").textContent = mode === "normal" ? "Dance along with the clip. Your part is in your colour." : "What are you? You'll find out at the end.";
      // The game's own explanation is long; the screen says it in two lines.
      $("partText").textContent = "Copy this shape like a mirror. Move when it moves.";
      if (!startingOver || role.problem) {
        $("partProblem").textContent = role.problem ? camera.partNote() ?? role.problem : "";
        $("partProblem").hidden = !role.problem;
      }
      const chips = $("partChips");
      chips.innerHTML = "";
      // A duel is copied with the whole body only: no part to pick, so a hand is never ranked against a whole body.
      chips.hidden = !!role.duel;
      turn.querySelector<HTMLElement>(".part-ask")!.hidden = !!role.duel;
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
      $("drumrollTitle").textContent = soloGame ? "That's the show!" : "That's everyone!";
      $("drumrollNote").textContent = soloGame ? "Here comes what you actually did." : "Gather round. Here comes what you all actually did.";
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
      revealControl.skip = false;
      rows = [...r].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
      // Load every player's jester while the reveal plays, so the crowning starts without a pop.
      preloadJesters(r.map((row) => variantOf(row)));
      // A fresh show: the curtains open and the picture is up (the last game left them shut).
      $("screen-reveal").classList.remove("leaving");
      $("screen-reveal").querySelector(".box")?.classList.remove("closed");
      show("reveal");
    },

    async revealReady(url) {
      if (game?.signal.aborted) return;
      videoUrl = url;
      // The game itself has finished; the crowning and results need no leave check.
      running = false;
      try { await curtainCall(); await crown(); } catch { return; /* left from the curtain call or the crowning */ }
      showResults();
    },
  };

  /** Each player wears the jester colourway that matches their colour (player 1 is p1, and so on). */
  function variantOf(row: ResultRow) {
    const own = variantOfColour(row.color);
    if (own) return own;
    // A colour with no rendered jester gets the first colourway nobody else at the table is wearing, so two
    // players never crown as the same jester.
    const taken = new Set(rows.map((r) => variantOfColour(r.color)).filter((v): v is string => v !== null));
    const free = VARIANTS.filter((v) => !taken.has(v));
    const unmatched = rows.filter((r) => variantOfColour(r.color) === null);
    return free[unmatched.indexOf(row)] ?? variantFor(rows.indexOf(row));
  }

  // ---- Between the reveal and the crowning: the curtain call ----

  /** How long the curtains take to close or open; style.css uses the same length (.drapes, #revealStage). */
  const CURTAIN_MS = 900;
  const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  /**
   * The show is over: the reveal's curtains close while the picture goes dark, a beat with them shut, then the
   * screen fades out. The crowning then fades in with its own curtains shut and opens them (see crown()).
   * With reduced motion the crowning simply follows, as before.
   */
  async function curtainCall() {
    if (calm()) return;
    const screen = $("screen-reveal");
    screen.querySelector(".box")?.classList.add("closed");
    await wait(CURTAIN_MS + 250, sig());
    screen.classList.add("leaving");
    await wait(220, sig());
  }

  // ---- The crowning ----

  /**
   * Every player's jester stands on the stage wearing their face. A drum roll, a spotlight sweeps across them
   * and lands on the winner, who does the win dance while the rest slump. Resolves on "See the scores".
   */
  async function crown() {
    // The crowning arrives with its curtains shut, as the reveal left them, and opens them before the drum roll.
    const crownScreen = $("screen-crown");
    const crownBox = crownScreen.querySelector(".box");
    const opening = !calm();
    crownBox?.classList.toggle("closed", opening);
    crownScreen.classList.toggle("arriving", opening);
    show("crown");
    // Stand them in seat order, not score order, so the spotlight has somewhere to travel.
    const seatOf = (row: ResultRow) => { const i = gameColors.indexOf(row.color); return i < 0 ? gameColors.length + rows.indexOf(row) : i; };
    const seated = [...rows].sort((a, b) => seatOf(a) - seatOf(b));
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
    const winners = winnersOf(rows);
    const headline = rows.some((r) => r.duel) ? duelHeadline(winners.map((w) => w.name)) : headlineFor(rows);
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
        say(rows.length === 1 ? "solo" : winners.length === 0 ? "nobody" : winners.length > 1 ? "tie" : "crown", { winner: rows.length === 1 ? rows[0]!.name : winners.map((w) => w.name).join(" and ") });
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
    let done = false;
    // The curtains part once the screen has faded in; the drum roll and spotlight start about two thirds open.
    const begin = async () => {
      if (opening) {
        await wait(220, sig());
        crownScreen.classList.remove("arriving");
        crownBox?.classList.remove("closed");
        await wait(Math.round(CURTAIN_MS * 0.65), sig());
      }
      if (!done) void run();
    };
    void begin().catch(() => { /* left mid-opening */ });
    try { await clicked($("crownGo"), sig()); }
    finally {
      done = true;
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
    // A duel lists players by their place (timing breaks a tie on score), so the crowned player is first.
    const duel = rows.some((r) => r.duel);
    const podium = podiumOrder(rows);
    const listed = podium.map((p) => p.row);
    const winners = winnersOf(listed);
    letters($("resultsHeadline"), duel ? duelHeadline(winners.map((w) => w.name)) : headlineFor(rows));
    const list = $("podium");
    list.innerHTML = "";
    // Everyone leaves with something: the crown, or an award from how they played.
    const awards = awardsFor(listed.map((r) => ({ score: r.score, winner: r.winner, motion: motionOf(r.timeline) })))
      .map((award, i) => (duel && listed[i]!.winner && !listed[i]!.tied ? DUEL_WINNER_AWARD : award));
    listed.forEach((r, i) => {
      const place = podium[i]!.place;
      const li = document.createElement("li");
      li.className = "place" + (r.winner ? " won" : "");
      li.style.setProperty("--who", r.color);
      li.style.setProperty("--i", String(i));
      li.innerHTML = `<span class="badge"></span><span class="place-who"><span class="place-rank"></span><b class="tape"></b><span class="place-part"></span><span class="aside place-award"></span></span><span class="place-score"></span>`;
      li.querySelector(".place-rank")!.textContent = rows.length === 1 ? "" : ordinal(place); // no "1st" of one
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
      // The final score is on the element from the start, so anything reading it mid count-up gets the real one.
      score.dataset.score = r.score == null ? "" : String(r.score);
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

  $("again").addEventListener("click", () => { stopPodium(); if (scene) openCast(true); else show("start"); });
  $("newClip").addEventListener("click", () => { stopPodium(); show("start"); });
  $("oopsBack").addEventListener("click", () => show("start"));

  // Every loading bar, here and in the practice area, gets the running jester.
  jesterBars(document);

  let seen = false;
  try { seen = localStorage.getItem(HOWTO_SEEN) === "1"; } catch { /* storage blocked: treat as seen, never trap them */ seen = true; }
  show(seen ? "start" : "howto");
}
