// "Play with anyone": the start screen's second button. You wait in the open lobby (lobby.ts); the matchmaker
// puts up to four of you in one room (an ordinary Room that ignores everyone else), everyone copies the same
// one subject clip at the same moment on their own device (onlineDuel.ts's playDuel), and ghosts of earlier
// rounds on that clip (ghosts.ts) fill the empty places. Alone after 8 seconds: you play the ghosts.
// No server: the lobby and the room are Supabase Realtime channels, the ghosts come from the `rounds` table.
//
// Scores are worked out in each player's browser, so a player could send any score they like. Accepted for the
// hackathon.

import { MemoryBus, Room, broadcastChannelTransport, makeRoomCode } from "../../spikes/pose-match/rooms.mjs";
import { PLAYER_COLORS } from "../../spikes/pose-match/reveal.mjs";
import { ghostRecords, ghostRows } from "./ghostSource.ts";
import { GHOST_NOTE, ghostName, ghostNames, ghostScoreAt, ghostStanding, isGhost, makeGhost, pickClip, pickGhosts, withGhosts, type Ghost } from "./ghosts.ts";
import { Lobby, MATCH_SIZE, MATCH_WAIT_MS, type Accepted, type MatchPlan, type Waiter } from "./lobby.ts";
import { lobbyTransport } from "./lobbyTransport.ts";
import {
  STARTER_ID, behindLine, drawDuelSubject, duelClips, duelLengthMs, duelStandings, loadDuelClip, playDuel, playDuelReveal, whenAllDone,
  type DuelClip, type DuelLook, type DuelPerformer, type DuelRoom, type DuelStanding,
} from "./onlineDuel.ts";
import { drawFrame, fitCanvas } from "./draw.ts";
import { hostedTransportFromEnv } from "./supabaseTransport.ts";
import type { Player } from "./round.ts";
import "./anyone.css";

export interface AnyoneDeps {
  getCamera(): Promise<Player>;
  /** True to play with a stand-in that copies the clip (the page's "nocam" setting), for testing in two tabs. */
  simMode(): boolean;
  clipVideo: HTMLVideoElement;
  cam: HTMLVideoElement;
}

/** From the match message to the start: time to join the room, measure the matchmaker's clock and load the clip. */
const MATCH_START_MS = 10_000;
/** Alone there is no one to wait for, only the clip to load. */
const ALONE_START_MS = 5_000;
const NAME_KEY = "jester.anyoneName";

type State = "join" | "waiting" | "play" | "results";
type AnyoneRoom = DuelRoom & {
  join(): void;
  leave(): void;
  adoptRound(o: { clipId: string; roundNo?: number; extra?: object; lengthMs?: number | null; from: string; startAt: number; estimate?: number }): unknown;
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const cssVar = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
const colors = () => [1, 2, 3, 4].map((i) => cssVar(`--p${i}`, PLAYER_COLORS[i - 1]!));
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};
const newId = () => "p" + Math.random().toString(36).slice(2, 8);
/** "Ana", "Ana and Bo", "Ana, Bo and Cy" */
const listed = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

export function initAnyone(deps: AnyoneDeps) {
  const screen = $("screen-anyone");
  const clipCanvas = $<HTMLCanvasElement>("anyoneClip");
  const youCanvas = $<HTMLCanvasElement>("anyoneYou");
  const revealCanvas = $<HTMLCanvasElement>("anyoneReveal");
  const count = $("anyoneCount");

  /** Bumped by every new search and by leaving, so the steps of an older one stop where they are. */
  let run = 0;
  let lobby: Lobby | null = null;
  let room: AnyoneRoom | null = null;
  let stopReveal: (() => void) | null = null;
  let camera: Promise<Player | null> | null = null;
  let waitTimer = 0;
  let previewRaf = 0;
  let lastPlayFrame = 0;

  const setState = (s: State) => { screen.dataset.state = s; };
  const status = (text: string) => { $("anyoneStatus").textContent = text; };
  const problem = (text: string | null) => { $("anyoneProblem").textContent = text ?? ""; $("anyoneProblem").hidden = !text; };

  // ---- Opening and leaving ----

  function open() {
    for (const s of document.querySelectorAll<HTMLElement>("#game > .screen")) s.hidden = s !== screen;
    screen.hidden = false;
    document.body.dataset.screen = "anyone";
    $("gameNav").hidden = false;
    window.scrollTo(0, 0);
    leaveMatch();
    setState("join");
    status("");
    problem(null);
    $("anyoneAgain").hidden = true;
    $("anyoneResults").hidden = true;
    let saved = "";
    try { saved = localStorage.getItem(NAME_KEY) ?? ""; } catch { /* private window: no saved name */ }
    $<HTMLInputElement>("anyoneName").value = saved;
    startCamera();
    startPreview();
    $<HTMLInputElement>("anyoneName").focus();
  }

  /** Leaves the lobby or the room and stops anything still drawing. The camera stays on, as in the rest of the game. */
  function leaveMatch() {
    run++;
    clearInterval(waitTimer);
    lobby?.close(); lobby = null;
    room?.leave(); room = null;
    stopReveal?.(); stopReveal = null;
    count.hidden = true;
  }

  function close() {
    leaveMatch();
    cancelAnimationFrame(previewRaf);
    screen.hidden = true;
  }

  function startCamera() {
    if (deps.simMode() || camera) return;
    camera = deps.getCamera().catch((err: Error) => {
      camera = null;
      problem(`The camera did not start (${err.message}). Allow the camera and try again, or add ?nocam to the address to try with a stand-in player.`);
      return null;
    });
  }

  /** Your mirror while nothing is playing, so you can check you are in view. */
  function startPreview() {
    cancelAnimationFrame(previewRaf);
    const draw = () => {
      if (screen.hidden) return;
      if (performance.now() - lastPlayFrame > 250) {
        if (deps.simMode()) { fitCanvas(youCanvas, 4 / 3); drawFrame(youCanvas, null, null); }
        else if (deps.cam.videoWidth) { fitCanvas(youCanvas, deps.cam.videoWidth / deps.cam.videoHeight); drawFrame(youCanvas, deps.cam, null, { mirror: true }); }
      }
      previewRaf = requestAnimationFrame(draw);
    };
    draw();
  }

  // ---- The lobby ----

  function find() {
    leaveMatch();
    const token = run;
    problem(null);
    $("anyoneAgain").hidden = true;
    $("anyoneResults").hidden = true;
    const id = newId();
    const name = $<HTMLInputElement>("anyoneName").value.trim().slice(0, 20) || `Player ${id.slice(-3).toUpperCase()}`;
    try { localStorage.setItem(NAME_KEY, name); } catch { /* not kept: fine */ }
    setState("waiting");
    const { transport, online } = lobbyTransport(id);
    const l = new Lobby({ transport, me: id, name, plan: planMatch });
    lobby = l;
    let waiting: Waiter[] = [{ id, name, since: l.since }];
    const say = () => {
      if (token !== run) return;
      const others = waiting.length - 1;
      const iMatch = waiting[0]?.id === id;
      const left = Math.max(1, Math.ceil((MATCH_WAIT_MS - (Date.now() - l.since)) / 1000));
      const where = online ? "" : " (this browser only: no connection settings, so only other tabs here can join)";
      if (!iMatch) status(`${waiting.length} here. ${waiting[0]!.name} has waited longest and starts the match.${where}`);
      else if (others === 0) status(Date.now() - l.since >= MATCH_WAIT_MS ? "Nobody else came. Getting the ghosts ready..." : `Looking for players${where}. Nobody else yet; if nobody comes, you play ghosts of earlier rounds in ${left} s.`);
      else status(`${waiting.length} here. Starting with whoever is here in ${left} s, or as soon as there are ${MATCH_SIZE}.`);
      renderWho(waiting, id);
    };
    l.onWaiting((list) => { waiting = list; say(); });
    l.onMatch((a) => {
      if (token !== run) return;
      clearInterval(waitTimer);
      lobby = null;
      void playMatch(token, id, name, a);
    });
    l.start();
    say();
    waitTimer = window.setInterval(say, 500);
  }

  function renderWho(waiting: Waiter[], me: string) {
    $("anyoneWho").replaceChildren(...waiting.map((w) => el("li", w.id === me ? "me" : "", w.id === me ? `${w.name} (you)` : w.name)));
  }

  /** The matchmaker's choices: a clip with one subject, the look picked on the start screen, ghosts for the empty places. */
  async function planMatch(members: Waiter[]): Promise<MatchPlan> {
    const [clips, rows] = await Promise.all([duelClips(), ghostRows()]);
    const pool = rows.data ?? [];
    const clip = pickClip(clips.data, pool, { alone: members.length === 1, starterId: STARTER_ID });
    if (!clip) throw new Error("No clip to play.");
    const look: DuelLook = document.body.dataset.mode === "watch" ? "watch" : "blind";
    return {
      // Longer than a hand-typed room code, so two matches never share a room.
      code: makeRoomCode() + makeRoomCode(), clipId: clip.id, look, lengthMs: duelLengthMs(clip.durationMs, look),
      ghosts: pickGhosts(pool, clip.id, Math.max(0, MATCH_SIZE - members.length)),
      startInMs: members.length > 1 ? MATCH_START_MS : ALONE_START_MS,
    };
  }

  // ---- The match ----

  async function performer(): Promise<DuelPerformer | null> {
    // A fresh wobble each round so two stand-ins do not tie.
    if (deps.simMode()) return { kind: "simulated", noiseDegrees: 8 + Math.random() * 22 };
    startCamera();
    const player = await camera;
    return player ? { kind: "camera", player } : null;
  }

  async function playMatch(token: number, me: string, name: string, { match, estimate }: Accepted) {
    setState("play");
    problem(null);
    const others = match.members.filter((p) => p.id !== me).map((p) => p.name || "someone");
    const ghostCount = match.ghosts.length;
    const company = [...others, ...(ghostCount ? [ghostCount === 1 ? "a ghost" : `${ghostCount} ghosts`] : [])];
    status(company.length ? `Matched with ${listed(company)}. Loading the clip...` : "Nobody to play against yet: no saved rounds on this clip. You play it alone this time.");

    const transport = match.members.length === 1 ? new MemoryBus().transport() : (hostedTransportFromEnv(match.code) ?? broadcastChannelTransport(match.code));
    // rooms.mjs is plain JavaScript, so its constructor's options are cast here.
    const r = new (Room as unknown as new (o: object) => AnyoneRoom)({ transport, code: match.code, playerId: me, name, members: match.members });
    room = r;
    r.join();
    r.adoptRound({
      clipId: match.clipId, roundNo: 1, extra: { mode: "duel", look: match.look, alive: null, match: match.id },
      lengthMs: match.lengthMs, from: match.from, startAt: match.startAt, estimate,
    });

    // Everything loads while the countdown runs.
    const names = ghostNames(match.ghosts);
    const [clipGot, ghostGot, who] = await Promise.all([loadDuelClip(match.clipId, deps.clipVideo), ghostRecords(match.ghosts), performer()]);
    if (token !== run) return;
    const dc = clipGot.data;
    const ghosts = (ghostGot.data ?? []).map((rec) => makeGhost(rec, names[match.ghosts.indexOf(rec.id)] ?? ghostName(rec.id)));
    if (ghostGot.error && ghostCount) problem(`${ghostGot.error} Playing without them.`);
    if (!who) { leaveMatch(); setState("join"); return; } // the camera problem is on screen already

    const bars = renderBars(r, me, ghosts);
    const off = r.on("update", () => { if (token === run) bars.people(); });
    window.__jesterRoundContext = { bankId: match.clipId, ...(dc ? { title: dc.title } : {}), ...(dc?.guide.subject ? { subject: dc.guide.subject.label } : {}) };
    let outcome;
    try {
      outcome = await playDuel(r, who, deps.clipVideo, {
        onStatus: (t) => {
          if (token !== run) return;
          const n = /^\D*(\d+)$/.exec(t);
          count.hidden = !n;
          if (n) count.textContent = n[1]!;
          status(t);
        },
        onFrame: (f) => {
          if (token !== run) return;
          fitCanvas(clipCanvas, f.clip.aspect);
          drawDuelSubject(clipCanvas, f.clip, match.look, f.phase, f.mediaMs);
          if (f.phase !== "play") return;
          lastPlayFrame = performance.now();
          const color = colors()[Math.max(0, match.members.findIndex((p) => p.id === me)) % 4]!;
          if (who.kind === "camera") { fitCanvas(youCanvas, deps.cam.videoWidth / (deps.cam.videoHeight || 1) || 4 / 3); drawFrame(youCanvas, deps.cam, f.player, { mirror: true, color }); }
          else { fitCanvas(youCanvas, f.clip.aspect); drawFrame(youCanvas, null, f.player, { mirror: true, color }); }
          bars.ghosts(f.mediaMs);
        },
      });
    } finally {
      delete window.__jesterRoundContext;
    }
    count.hidden = true;
    if (token !== run) { off(); return; }
    if (outcome.error) problem(outcome.error);
    if (!r.allDone) status("Waiting for the others to finish...");
    await whenAllDone(r);
    off();
    if (token !== run) return;
    showResults(r, me, dc, ghosts);
  }

  /** The score bars: players fill when their score arrives, ghosts fill as the clip plays. */
  function renderBars(r: AnyoneRoom, me: string, ghosts: Ghost[]) {
    const palette = colors();
    // Ghosts take no player colour (the look draws them as a pencil tracing); --p1 to --p4 stay for people.
    const row = (name: string, color: string | null, ghost: boolean) => {
      const li = el("li", "anyone-bar" + (ghost ? " ghost" : ""));
      if (color) li.style.setProperty("--who", color);
      const fill = el("span", "fill");
      const track = el("span", "track");
      track.append(fill);
      const out = el("output", "", "0");
      const note = el("small");
      li.append(el("b", "", name), out, track, note);
      return { li, fill, out, note };
    };
    const seats = r.roster().map((p, i) => ({ id: p.id, ...row(p.id === me ? `${p.name} (you)` : p.name, palette[i % palette.length]!, false) }));
    const haunts = ghosts.map((g) => ({ g, ...row(g.name, null, true) }));
    for (const h of haunts) h.note.textContent = GHOST_NOTE;
    $("anyoneBars").replaceChildren(...seats.map((s) => s.li), ...haunts.map((h) => h.li));
    const set = (b: { fill: HTMLElement; out: HTMLElement }, score: number | null) => {
      b.fill.style.width = `${Math.max(0, Math.min(100, score ?? 0))}%`;
      b.out.textContent = score === null ? "-" : String(score);
    };
    const people = () => {
      const here = new Set(r.roster().map((p) => p.id));
      for (const s of seats) {
        const result = r.results.get(s.id);
        if (result) { set(s, result.score); s.note.textContent = result.score === null ? "could not be scored" : "finished"; }
        else { set(s, 0); s.out.textContent = ""; s.note.textContent = here.has(s.id) ? "playing" : "left"; }
      }
    };
    people();
    return { people, ghosts: (mediaMs: number) => { for (const h of haunts) set(h, ghostScoreAt(h.g, mediaMs)); } };
  }

  function showResults(r: AnyoneRoom, me: string, dc: DuelClip | null, ghosts: Ghost[]) {
    setState("results");
    const table = withGhosts(duelStandings(r), dc ? ghosts.map((g) => ghostStanding(g, dc.startMs, dc.endMs)) : []);
    const firsts = table.ranked.filter((x) => x.place === 1);
    const top = firsts[0];
    status(!top ? "Nobody could be scored this time." : firsts.length > 1 ? "A tie for first." : top.id === me ? "You win!" : `${top.name} wins.`);
    const palette = colors();
    const seat = (row: DuelStanding) => r.roster().findIndex((p) => p.id === row.id);
    const items = table.ranked.map((row) => {
      const ghost = isGhost(row.id);
      const li = el("li", (ghost ? "ghost" : "") + (row.place === 1 ? " first" : ""));
      if (!ghost) li.style.setProperty("--who", palette[Math.max(0, seat(row)) % palette.length]!);
      const who = el("span", "anyone-name", row.id === me ? `${row.name} (you)` : row.name);
      const why = ghost ? GHOST_NOTE : row.error ?? (row.score === null ? "could not be scored" : "");
      if (why) who.append(el("small", "", why));
      li.append(el("span", "rank", String(row.place)), who, el("span", "score", row.score === null ? "-" : String(row.score)));
      return li;
    });
    for (const name of table.waiting) {
      const li = el("li");
      const who = el("span", "anyone-name", name);
      who.append(el("small", "", "did not finish in time"));
      li.append(el("span", "rank", ""), who, el("span", "score", "-"));
      items.push(li);
    }
    $("anyonePodium").replaceChildren(...items);
    $("anyoneBehind").textContent = behindLine(table.ranked) ?? "";
    $("anyoneResults").hidden = false;
    $("anyoneAgain").hidden = false;
    if (dc) {
      fitCanvas(revealCanvas, dc.aspect);
      stopReveal?.();
      stopReveal = playDuelReveal(revealCanvas, dc, table.ranked);
    }
  }

  // ---- Wiring ----

  $("anyoneOpen").addEventListener("click", open);
  $("anyoneJoin").addEventListener("submit", (e) => { e.preventDefault(); find(); });
  $("anyoneAgain").addEventListener("click", find);
  // Home (game.ts) goes back to the start; this screen only has to let go of its lobby or room.
  $("anyoneBack").addEventListener("click", () => $("home").click());
  $("home").addEventListener("click", () => { if (!screen.hidden) close(); });
}
