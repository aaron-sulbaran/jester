// Competing mode across devices ("duel"): a clip with ONE subject, every player copies it at the same
// moment on their own device, and they are ranked against each other. Wraps Lisa's Room (rooms.mjs)
// without editing it, like onlineBlind.ts does for blind mode.
//
// What a screen calls (see app/src/duel-lab.ts for all of it wired up):
//   const clips = await duelClips();                                   // bank clips with one subject, plus the starter
//   hostStartDuel(room, clipId, "blind" | "watch", { alive });         // host only; alive = null means everyone
//   room.on("start", async (round) => {
//     if (!isDuelRound(round)) return;
//     await playDuel(room, { kind: "camera", player }, video, hooks);  // loads the clip by id, plays, scores, sends
//     await whenAllDone(room);
//     const table = duelStandings(room);                                // places, waiting, out
//     const line = behindLine(table.ranked);                            // "Bo fell behind Ana around 0:07; ..."
//     const stop = playDuelReveal(canvas, await loadDuelClip(round.clipId, video), table.ranked);
//   });
//
// What crosses the network: the clip id, the look and who is still in (room.start), then each player's
// score, lag, a few bytes of per moment credits and the compact pose recording (room.submitResult).

import { serializeTimeline, deserializeTimeline } from "../../spikes/pose-match/serialize.mjs";
import { PerformanceRecorder } from "../../spikes/pose-match/recorder.mjs";
import { sampleAt, simulatedPlayerPose } from "../../spikes/pose-match/synthetic.mjs";
import { GRID_HZ, fromClipSamples, fromWebcamFrames, scorePoseRound, type ClipSample, type LandmarkObject, type WebcamFrame } from "../../engine/src/index.ts";
import type { Guide, View } from "../../clip/src/index.ts";
import { bucketCredits, clockText, fellBehind, modeFor, rankDuel } from "../../clip/src/match.ts";
import { listBank, loadBankGuides, type BankClip } from "./bank.ts";
import { bankSoloClip } from "./bankRound.ts";
import { blindView, drawBlind, guideFrameAt } from "./clipside/blind.ts";
import { starterClip, type Clip } from "./clip.ts";
import { drawReveal, type RevealRole } from "./composite.ts";
import { drawFrame } from "./draw.ts";
import type { Player } from "./round.ts";

type Result<T> = { data: T; error: null } | { data: null; error: string };

/** The built-in stick figure dance: always there, needs no network. */
export const STARTER_ID = "starter";
/** Duel clips are cut to this length so a recording fits in one room message. */
export const DUEL_MAX_MS = 20_000;
/** Supabase refuses messages over about 250 KB; keep the recording well under. */
const RECORDING_LIMIT_BYTES = 180_000;
const CREDIT_BUCKET_MS = 200;
const DEFAULT_DELAY_MS = 5000;
const WATCH_GAP_MS = 3000;

export type DuelLook = "blind" | "watch";

/** What the host puts in room.start's extra. The round number is the room's own `round.roundNo`. */
export interface DuelStartExtra { mode: "duel"; look: DuelLook; alive: string[] | null }

/** What each player sends with their score. */
export interface DuelResultExtra {
  mode: "duel";
  lagMs: number | null;
  tier: string | null;
  /** The limb the engine says was furthest off, from the player's own side ("left forearm"). */
  worst: string | null;
  /** Per moment credit 0..100 over the round's stretch, one per CREDIT_BUCKET_MS. */
  credits: (number | null)[];
  bucketMs: number;
  /** True for a player who is out (elimination) and sat this round out. */
  out?: boolean;
  /** A sentence when this device could not play the round. */
  error?: string;
}

export interface DuelRound { clipId: string; startAt: number; roundNo: number; extra?: unknown }

/** The parts of Lisa's Room this file uses. */
export interface DuelRoom {
  me: string;
  name: string;
  round: DuelRound | null;
  results: Map<string, { score: number | null; timeline: unknown; extra: unknown }>;
  allDone: boolean;
  roster(): { id: string; name: string }[];
  start(clipId: string, delayMs?: number, extra?: object): unknown;
  submitResult(r: { score: number | null; timeline?: unknown; extra?: unknown }): void;
  on(event: "update" | "start", fn: (arg: never) => void): () => void;
}

// ---- Clips ----

export interface DuelClipInfo { id: string; title: string; credit: string; durationMs: number; poster: string | null }

export interface DuelClip {
  id: string;
  title: string;
  credit: string;
  /** Engine ready samples on the video's own time, cut to the stretch. */
  clip: Clip;
  /** The one subject: drawn in the blind look and used to place players in the reveal. */
  guide: Guide;
  /** The clip's video, or null for the starter (drawn, not filmed). */
  video: HTMLVideoElement | null;
  /** The stretch everyone plays, in media ms. */
  startMs: number;
  endMs: number;
  aspect: number;
}

const STARTER_INFO: DuelClipInfo = { id: STARTER_ID, title: "Starter dance (built in)", credit: "Jester", durationMs: DUEL_MAX_MS, poster: null };
const NOT_IN_BANK = "That clip is not in the bank any more. Pick another clip.";
const NOT_A_DUEL = "This clip has more than one subject, so it plays as a cast (blind roles), not a duel.";

/** Clips a duel can use: the starter, then every bank clip with exactly one subject. A bank that does not load just leaves the starter. */
export async function duelClips(): Promise<{ data: DuelClipInfo[]; error: string | null }> {
  const listed = await listBank();
  if (listed.error !== null) return { data: [STARTER_INFO], error: listed.error };
  const bank = listed.data
    .filter((c) => modeFor(c.people + c.things, 2) === "duel" && c.people === 1)
    .map((c) => ({ id: c.id, title: c.title, credit: c.credit, durationMs: Math.min(c.durationMs, DUEL_MAX_MS), poster: c.poster }));
  return { data: [STARTER_INFO, ...bank], error: null };
}

/** Samples cut to end at `endMs`, with the engine timeline rebuilt from them. */
function cut(clip: Clip, endMs: number): Clip {
  const samples = clip.samples.filter((s) => s.t * 1000 <= endMs + 1);
  return { ...clip, samples, durationMs: endMs, timeline: fromClipSamples(samples, { width: clip.width, height: clip.height, timeUnit: "s" }) };
}

function starterDuel(): DuelClip {
  const clip = starterClip();
  const endMs = Math.min(clip.durationMs, DUEL_MAX_MS);
  // The reveal only needs the timeline and range; the starter has no boxes or outlines.
  const guide = { timeline: clip.timeline, range: { startMs: 0, endMs } } as unknown as Guide;
  return { id: STARTER_ID, title: STARTER_INFO.title, credit: STARTER_INFO.credit, clip: cut(clip, endMs), guide, video: null, startMs: 0, endMs, aspect: clip.width / clip.height };
}

const loaded = new Map<string, DuelClip>();

/** Every device loads the same clip and guide by id (no analysis). `video` is the element the clip plays in. */
export async function loadDuelClip(clipId: string, video: HTMLVideoElement): Promise<Result<DuelClip>> {
  const cached = loaded.get(clipId);
  if (cached && (cached.video === null || cached.video === video)) return { data: cached, error: null };
  if (clipId === STARTER_ID) {
    const starter = starterDuel();
    loaded.set(clipId, starter);
    return { data: starter, error: null };
  }
  const listed = await listBank();
  if (listed.error !== null) return listed;
  const entry: BankClip | undefined = listed.data.find((c) => c.id === clipId);
  if (!entry) return { data: null, error: NOT_IN_BANK };
  const guides = await loadBankGuides(entry);
  if (guides.error !== null) return guides;
  if (modeFor(guides.data.length, 2) !== "duel") return { data: null, error: NOT_A_DUEL };
  const guide = guides.data[0]!;
  const solo = await bankSoloClip(entry, guide, video);
  if (solo.error !== null) return solo;
  const startMs = guide.range.startMs;
  const endMs = Math.min(guide.range.endMs, startMs + DUEL_MAX_MS);
  const duel: DuelClip = {
    id: entry.id, title: entry.title, credit: entry.credit, clip: cut(solo.data, endMs), guide, video,
    startMs, endMs, aspect: guide.source.width / guide.source.height,
  };
  loaded.set(clipId, duel);
  return { data: duel, error: null };
}

// ---- Starting and playing a round ----

/** Host only. Starts a duel round on `clipId` for everyone (or only `alive`, in elimination). */
export function hostStartDuel(room: DuelRoom, clipId: string, look: DuelLook, { alive = null, delayMs = DEFAULT_DELAY_MS }: { alive?: string[] | null; delayMs?: number } = {}) {
  const extra: DuelStartExtra = { mode: "duel", look, alive };
  return room.start(clipId, delayMs, extra);
}

export function isDuelRound(round: DuelRound | null): round is DuelRound & { extra: DuelStartExtra } {
  return !!round && (round.extra as Partial<DuelStartExtra> | undefined)?.mode === "duel";
}

/** Who plays on this device: the camera, or a stand-in that copies the clip with some wobble (for one person testing in two tabs). */
export type DuelPerformer = { kind: "camera"; player: Player } | { kind: "simulated"; noiseDegrees: number };

export interface DuelFrame {
  phase: "watch" | "play";
  mediaMs: number;
  /** This player's pose (camera or simulated); null while watching or when nobody is found. */
  player: LandmarkObject[] | null;
  playerAspect: number;
  clip: DuelClip;
}

export interface DuelHooks {
  /** A short line for the screen: "Loading the clip...", "Watch it once", "3", "Go!", "Scoring...". */
  onStatus?(text: string): void;
  /** Each drawn frame while the clip runs (only while the page is visible). Draw the subject with drawDuelSubject. */
  onFrame?(f: DuelFrame): void;
}

export interface DuelOutcome { score: number | null; lagMs: number | null; out: boolean; error: string | null }

const sleepUntil = (perfMs: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, perfMs - performance.now())));
const toPerf = (wallMs: number) => performance.now() + (wallMs - Date.now());

async function countdown(untilPerf: number, say: (t: string) => void, label: (s: number) => string) {
  while (performance.now() < untilPerf - 50) {
    say(label(Math.max(1, Math.ceil((untilPerf - performance.now()) / 1000))));
    await sleepUntil(Math.min(untilPerf, performance.now() + 250));
  }
}

/**
 * Runs the clip's stretch on the wall clock from `fromPerf` (performance.now() at the stretch's start), so
 * every device stays together and a background tab still finishes on time. The video only follows the clock.
 */
function runStretch(dc: DuelClip, fromPerf: number, onTick: (mediaMs: number) => void): Promise<void> {
  const lengthMs = dc.endMs - dc.startMs;
  const mediaNow = () => dc.startMs + (performance.now() - fromPerf);
  const video = dc.video;
  if (video) {
    video.currentTime = dc.startMs / 1000;
    void video.play().catch(() => undefined);
  }
  return new Promise((resolve) => {
    let done = false;
    const tick = () => {
      if (done) return;
      const ms = Math.min(dc.endMs, mediaNow());
      if (video && Math.abs(video.currentTime * 1000 - ms) > 300) video.currentTime = ms / 1000;
      onTick(ms);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    setTimeout(() => { done = true; video?.pause(); resolve(); }, Math.max(0, fromPerf + lengthMs - performance.now()));
  });
}

/** The simulated player's pose at media time `ms` (null before the subject appears). */
function simulatedPose(dc: DuelClip, ms: number, noiseDegrees: number): LandmarkObject[] | null {
  const lagSeconds = 0.15;
  const sample = sampleAt(dc.clip.samples as never, ms / 1000 - lagSeconds) as { landmarks: unknown } | null;
  if (!sample?.landmarks) return null;
  return simulatedPlayerPose(dc.clip.samples as never, ms / 1000, { lagSeconds, noiseDegrees, aspect: dc.aspect }) as LandmarkObject[];
}

/** The recording in the compact form, skipping more frames until it fits in one room message. */
export function packRecording(timeline: unknown, limitBytes = RECORDING_LIMIT_BYTES) {
  let every = 2;
  let packed = serializeTimeline(timeline as never, { every });
  while (JSON.stringify(packed).length > limitBytes && every < 12) packed = serializeTimeline(timeline as never, { every: ++every });
  return packed;
}

/**
 * Plays this device's part of the room's current duel round: loads the clip by id, waits for the shared
 * start, (watch look) plays it once to watch, then plays it for real with this device's performer,
 * scores it with the engine exactly as a solo round does, and sends score, lag and recording to the room.
 * Always sends something, so the room never waits on a device that failed.
 */
export async function playDuel(room: DuelRoom, performer: DuelPerformer, video: HTMLVideoElement, hooks: DuelHooks = {}): Promise<DuelOutcome> {
  const round = room.round;
  const say = (t: string) => hooks.onStatus?.(t);
  const send = (score: number | null, timeline: unknown, extra: Partial<DuelResultExtra>) =>
    room.submitResult({ score, timeline, extra: { mode: "duel", lagMs: null, tier: null, worst: null, credits: [], bucketMs: CREDIT_BUCKET_MS, ...extra } satisfies DuelResultExtra });
  if (!isDuelRound(round)) return { score: null, lagMs: null, out: false, error: "This round is not a duel." };
  const { look, alive } = round.extra;
  if (alive && !alive.includes(room.me)) {
    send(null, null, { out: true });
    say("You are out. Watch the others play.");
    return { score: null, lagMs: null, out: true, error: null };
  }

  say("Loading the clip...");
  const got = await loadDuelClip(round.clipId, video);
  if (got.error !== null) {
    send(null, null, { error: got.error });
    say(got.error);
    return { score: null, lagMs: null, out: false, error: got.error };
  }
  const dc = got.data;
  const lengthMs = dc.endMs - dc.startMs;
  // Everyone works from the host's start time, so devices stay together even if one loaded slowly.
  const startPerf = toPerf(round.startAt);
  const watchFirst = look === "watch";
  await countdown(startPerf, say, (s) => (watchFirst ? `Watch it once in ${s}` : `Copy it in ${s}`));

  const aspectOf = performer.kind === "camera" ? 4 / 3 : dc.aspect;
  if (watchFirst) {
    say("Watch it once. Next time, copy it.");
    await runStretch(dc, Math.max(startPerf, performance.now()), (mediaMs) => hooks.onFrame?.({ phase: "watch", mediaMs, player: null, playerAspect: aspectOf, clip: dc }));
  }
  const playPerf = Math.max(watchFirst ? startPerf + lengthMs + WATCH_GAP_MS : startPerf, performance.now());
  if (watchFirst) await countdown(playPerf, say, (s) => `Your turn in ${s}`);

  say("Go! Copy it as if it were a mirror.");
  const recorder = new PerformanceRecorder();
  const frames: WebcamFrame[] = [];
  let latest: { landmarks: LandmarkObject[] | null; aspect: number } = { landmarks: null, aspect: aspectOf };
  const clipClock = () => (performance.now() < playPerf ? -1 : Math.min(dc.endMs, dc.startMs + (performance.now() - playPerf)));
  if (performer.kind === "camera") {
    performer.player.start((f) => {
      const ms = f.clipTimeMs ?? -1;
      if (ms < 0) return;
      frames.push(f);
      recorder.add({ landmarks: f.landmarks, outline: null }, ms);
      latest = { landmarks: (f.landmarks as LandmarkObject[] | null) ?? null, aspect: f.aspect };
    }, clipClock);
  }
  await runStretch(dc, playPerf, (mediaMs) => {
    const pose = performer.kind === "camera" ? latest.landmarks : simulatedPose(dc, mediaMs, performer.noiseDegrees);
    hooks.onFrame?.({ phase: "play", mediaMs, player: pose, playerAspect: latest.aspect, clip: dc });
  });
  if (performer.kind === "camera") performer.player.stop();
  else {
    // Made after the fact at 30 frames a second, so a simulated tab in the background scores the same.
    for (let ms = dc.startMs; ms <= dc.endMs; ms += 1000 / 30) {
      const landmarks = simulatedPose(dc, ms, performer.noiseDegrees);
      frames.push({ t: ms, landmarks, aspect: dc.aspect, mirrored: false, clipTimeMs: ms });
      recorder.add({ landmarks, outline: null }, ms);
    }
  }

  say("Scoring...");
  const result = scorePoseRound(dc.clip.timeline, fromWebcamFrames(frames));
  const recording = recorder.finish({ durationMs: dc.endMs, aspect: frames.find((f) => f.landmarks)?.aspect ?? aspectOf } as never);
  const packed = frames.some((f) => f.landmarks) ? packRecording(recording) : null;
  const lagMs = result.score === null ? null : Math.round(result.lagMs);
  send(result.score, packed, {
    lagMs, tier: result.tier, worst: result.worstLimb?.label ?? null,
    credits: bucketCredits(result.frameCredits, dc.startMs, dc.endMs, 1000 / GRID_HZ, CREDIT_BUCKET_MS),
  });
  say(result.score === null ? "Tracking was too poor to score. Stand back so your whole body is in view." : `Your score: ${result.score}. Waiting for the others...`);
  return { score: result.score, lagMs, out: false, error: null };
}

/** Resolves once every player in the room has sent a result for this round. */
export function whenAllDone(room: DuelRoom): Promise<void> {
  return new Promise((resolve) => {
    if (room.allDone) return resolve();
    const off = room.on("update", () => { if (room.allDone) { off(); resolve(); } });
  });
}

// ---- Standings ----

export interface DuelStanding {
  id: string;
  name: string;
  place: number;
  score: number | null;
  lagMs: number | null;
  worst: string | null;
  credits: (number | null)[];
  bucketMs: number;
  timeline: unknown;
  error: string | null;
}

export interface DuelTable {
  /** Players who played this round, best first (place 1 is best; exact ties share a place). */
  ranked: DuelStanding[];
  /** Names still playing. */
  waiting: string[];
  /** Ids sitting this round out (elimination). */
  out: string[];
}

export function duelStandings(room: DuelRoom): DuelTable {
  const roster = room.roster();
  const played: Omit<DuelStanding, "place">[] = [];
  const waiting: string[] = [], out: string[] = [];
  for (const p of roster) {
    const r = room.results.get(p.id);
    if (!r) { waiting.push(p.name); continue; }
    const extra = (r.extra ?? {}) as Partial<DuelResultExtra>;
    if (extra.out) { out.push(p.id); continue; }
    played.push({
      id: p.id, name: p.name, score: r.score ?? null, lagMs: extra.lagMs ?? null, worst: extra.worst ?? null,
      credits: extra.credits ?? [], bucketMs: extra.bucketMs ?? CREDIT_BUCKET_MS, timeline: r.timeline ?? null, error: extra.error ?? null,
    });
  }
  const byId = new Map(played.map((p) => [p.id, p]));
  const ranked = rankDuel(played).map((pl) => ({ ...byId.get(pl.id)!, place: pl.place }));
  return { ranked, waiting, out };
}

/** One line on where last place fell behind first place, or null when there is nothing useful to say. */
export function behindLine(ranked: readonly DuelStanding[]): string | null {
  if (ranked.length < 2) return null;
  const first = ranked[0]!, last = ranked[ranked.length - 1]!;
  if (last.place === first.place) return "A dead heat: same score, same timing.";
  if (last.score === null) return last.error ?? `${last.name} could not be scored. Stand back so your whole body is in view.`;
  const at = fellBehind(first.credits, last.credits, last.bucketMs);
  const limb = last.worst ? ` Their ${last.worst} was furthest off.` : "";
  if (at === null) return last.worst ? `${last.name} was close all the way.${limb}` : null;
  return `${last.name} fell behind ${first.name} around ${clockText(at)}.${limb}`;
}

// ---- Drawing ----

const views = new WeakMap<HTMLCanvasElement, { key: string; view: View }>();

/** The subject at `mediaMs` as this round's look shows it: the clip itself when watching, only its stick figure when blind. */
export function drawDuelSubject(canvas: HTMLCanvasElement, dc: DuelClip, look: DuelLook, phase: "watch" | "play", mediaMs: number) {
  if (!dc.video) {
    const sample = sampleAt(dc.clip.samples as never, mediaMs / 1000) as ClipSample | null;
    drawFrame(canvas, null, (sample?.landmarks ?? null) as LandmarkObject[] | null);
    return;
  }
  if (look === "watch" || phase === "watch") { drawFrame(canvas, dc.video, null); return; }
  const key = `${dc.id}:${canvas.width}x${canvas.height}`;
  let cached = views.get(canvas);
  if (!cached || cached.key !== key) { cached = { key, view: blindView(dc.guide, canvas, "fit") }; views.set(canvas, cached); }
  drawBlind(canvas, dc.guide, guideFrameAt(dc.guide, mediaMs), "stick", cached.view);
}

/** Every player's recording, placed on the subject, in drawReveal's shape. A gap is left in the middle for the subject. */
function revealRoles(dc: DuelClip, ranked: readonly DuelStanding[]): { roles: RevealRole[]; rows: (DuelStanding | null)[] } {
  const rows: (DuelStanding | null)[] = ranked.filter((r) => r.timeline);
  if (rows.length % 2 === 1) rows.splice(Math.floor(rows.length / 2) + 1, 0, null); // keeps the centre free when there is an odd count
  const empty = { frames: [] };
  const roles = rows.map((r) => (r
    ? { name: r.name, score: r.score, guide: dc.guide, timeline: deserializeTimeline(r.timeline) as RevealRole["timeline"] }
    : { name: "", score: null, guide: dc.guide, timeline: empty }));
  return { roles, rows };
}

/**
 * The head to head reveal: the original clip plays (the starter's figure in grey) with every player's
 * recording standing beside the subject, each labelled with place, name and score. Returns a stop function.
 */
export function playDuelReveal(canvas: HTMLCanvasElement, dc: DuelClip, ranked: readonly DuelStanding[]): () => void {
  const { roles, rows } = revealRoles(dc, ranked);
  const winner = rows.findIndex((r) => r?.place === 1 && ranked.filter((x) => x.place === 1).length === 1);
  const scratch = document.createElement("canvas");
  const lengthMs = dc.endMs - dc.startMs;
  const started = performance.now();
  let raf = 0;
  if (dc.video) { dc.video.currentTime = dc.startMs / 1000; void dc.video.play().catch(() => undefined); }
  const spread = Math.min(0.6, 0.9 / Math.max(2, roles.length));
  const tick = () => {
    let ms = dc.startMs + ((performance.now() - started) % Math.max(1, lengthMs));
    if (dc.video) {
      if (dc.video.currentTime * 1000 >= dc.endMs || dc.video.ended) { dc.video.currentTime = dc.startMs / 1000; void dc.video.play().catch(() => undefined); }
      ms = dc.video.currentTime * 1000;
      drawFrame(canvas, dc.video, null);
    } else {
      const sample = sampleAt(dc.clip.samples as never, ms / 1000) as ClipSample | null;
      drawFrame(canvas, null, (sample?.landmarks ?? null) as LandmarkObject[] | null, { color: "#777" });
    }
    scratch.width = canvas.width; scratch.height = canvas.height;
    const { figures } = drawReveal(scratch, roles, ms, { clipAspect: dc.aspect, winner, spreadX: spread });
    const ctx = canvas.getContext("2d")!;
    // The reveal's dark background drops out over the video; only the figures show.
    ctx.globalCompositeOperation = "lighten";
    ctx.drawImage(scratch, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.font = `bold ${Math.round(canvas.height * 0.045)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    (figures as { pose: { x: number; y: number }[] | null; color: string }[]).forEach((fig, i) => {
      const row = rows[i];
      if (!row || !fig.pose) return;
      const top = Math.min(...fig.pose.map((p) => p.y));
      const x = fig.pose[0]!.x * canvas.width, y = Math.max(canvas.height * 0.06, (top - 0.06) * canvas.height);
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      const text = `${row.place}. ${row.name}  ${row.score ?? "no score"}`;
      const w = ctx.measureText(text).width + 12;
      ctx.fillRect(x - w / 2, y - canvas.height * 0.045, w, canvas.height * 0.06);
      ctx.fillStyle = fig.color;
      ctx.fillText(text, x, y);
    });
    raf = requestAnimationFrame(tick);
  };
  tick();
  return () => { cancelAnimationFrame(raf); dc.video?.pause(); };
}

/** The colour each ranked player gets in the reveal, for a legend beside it. */
export function revealColors(dc: DuelClip, ranked: readonly DuelStanding[], palette: readonly string[]): Map<string, string> {
  const { rows } = revealRoles(dc, ranked);
  const out = new Map<string, string>();
  rows.forEach((r, i) => { if (r) out.set(r.id, palette[i % palette.length]!); });
  return out;
}
