// Blind mode on one laptop.
//
// 1. A clip goes in: the demo scene (a dancer and a ball, works offline) or a video, read by the clip side
//    (`prepareVideo` and `subjectGuides`, one guide per subject, all over the same stretch of the clip).
// 2. Each player gets a secret role (a person or a thing) and a look: only the outline or only the stick
//    figure, never the clip. Things are always shown as their outline, and the player picks which body part
//    plays it.
// 3. Players take turns on the same laptop. Each turn is scored by the engine: the pose channel for a person,
//    the trajectory channel for a thing. Scores stay hidden until the end.
// 4. The reveal: one video of the clip with every player's cutout standing where their subject was, with
//    name tags and scores, recorded in the browser for download. Nothing is uploaded.
//
// This file is the game and makes no DOM of its own: the screens come in as a `BlindUi` (Aaron's look
// implements it in app/src/ui/; app/src/blindScreens.ts is the plain stand-in until then).

import { BODY_PARTS, fromWebcamFrames, scorePoseRound, scoreTrajectoryRound, type BodyPart, type LandmarkObject } from "../../engine/src/index.ts";
import { boxFromLandmarks, type Guide, type Outline } from "../../clip/src/index.ts";
import { DEMO_SEQUENCE, makeSequenceTimeline, sampleAt } from "../../spikes/pose-match/synthetic.mjs";
import { PLAYER_COLORS, winnerIndex } from "../../spikes/pose-match/reveal.mjs";
import { PerformanceRecorder } from "../../spikes/pose-match/recorder.mjs";
import { blindView, drawBlind, guideFrameAt, type Look } from "./clipside/blind.ts";
import { prepareVideo, subjectGuides } from "./clip.ts";
import { collectFrames, simulatedPlayer, type Player } from "./round.ts";
import { simulatedObjectPlayer, type ObjectClip } from "./objectClips.ts";
import { cutFrame, recordReveal, type Box, type Cutout, type RevealLayer } from "./cutout.ts";
import { drawFrame, fitCanvas } from "./draw.ts";

export interface Scene {
  name: string;
  width: number;
  height: number;
  /** Media time where the shared stretch starts, and its length. Every guide covers it. */
  startMs: number;
  durationMs: number;
  guides: Guide[];
  /** The clip's video, or null for the drawn demo scene. */
  video: HTMLVideoElement | null;
}

interface Seat {
  name: string;
  color: string;
  guide: Guide;
  look: Look;
  part: BodyPart;
  cutouts: Cutout[];
  result: { score: number | null; tier: string | null; lagMs: number } | null;
  /** The performance in Lisa's recorder format (pose only), for her stick figure reveal. */
  recording: unknown;
}

export interface BlindDeps {
  simMode: () => boolean;
  /** The wobble slider: simulated players copy with this much noise (and objects at 1 - noise/50 effort). */
  noise: () => number;
  getCamera: () => Promise<Player>;
}

/** A player as the screens show them. */
export interface PlayerInfo { name: string; color: string }

/** What a player is told about their secret role. */
export interface RoleInfo {
  label: string;
  kind: "person" | "thing";
  look: Look;
  /** One sentence, e.g. "You are the ball. You will see only its outline, never the clip. Move with it." */
  text: string;
  /** For a thing: the body parts the player can pick to play it (first is the whole body). Null for a person. */
  parts: { key: BodyPart; label: string }[] | null;
  /** Set when the last try failed (camera did not start), to show above the role. */
  problem?: string;
}

export interface ResultRow {
  name: string;
  color: string;
  /** "the ball, with the right hand" or "Person 2". */
  role: string;
  look: Look;
  score: number | null;
  tier: string | null;
  /** Best score; `tied` when more than one player has it. */
  winner: boolean;
  tied: boolean;
}

/**
 * The screens blind mode needs. Each Promise resolves when the player presses on. Ids and markup are the
 * UI's own; blind.ts only draws on the canvases it is given.
 */
export interface BlindUi {
  /** Pass the laptop to `player`; `previous` just finished (their score stays secret). Resolves when `player` is ready to see their role. */
  handover(player: PlayerInfo, previous: PlayerInfo | null): Promise<void>;
  /** Show the secret role. Resolves with the body part picked (always "body" for a person) when the player starts. */
  showPart(player: PlayerInfo, role: RoleInfo): Promise<BodyPart>;
  /** Where a turn is drawn: the role (outline or stick figure only) and the player's mirror view. */
  playStage(): { guideCanvas: HTMLCanvasElement; playerCanvas: HTMLCanvasElement; cam: HTMLVideoElement };
  countdown(seconds: number): Promise<void>;
  /** A short pause after the last turn, before the reveal (optional). */
  beat?(): Promise<void>;
  /** The canvas the reveal is drawn on while it records. */
  revealCanvas(): HTMLCanvasElement;
  /** Recording progress of the reveal, 0 to 1. */
  progress(share: number): void;
  /** The end: everyone's role and score. Called before the reveal starts recording on `revealCanvas`. */
  results(rows: ResultRow[]): void;
  /** The recorded reveal as a video URL to play and download, or null if this browser cannot record. */
  revealReady(videoUrl: string | null): void;
}

// ---- Scenes ----

const isThing = (g: Guide) => g.subject.kind === "thing";

/** A box as a closed ellipse, for things that have a box but no outline. */
function ellipseOutline(b: Box, n = 24): Outline {
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return [b.cx + (b.w / 2) * Math.cos(a), b.cy + (b.h / 2) * Math.sin(a)] as [number, number];
  });
}

/** Things always get an outline to show: their own, or an ellipse in their box. */
function withThingOutlines(g: Guide): Guide {
  if (!isThing(g)) return g;
  return { ...g, outlines: g.boxTrack.frames.map((f, i) => g.outlines[i] ?? (f.box ? ellipseOutline(f.box) : null)) };
}

/** The subject's box at replay time `ms` (from the start of the shared stretch). */
function boxAt(g: Guide, ms: number): Box | null {
  if (ms < 0) return null;
  return g.boxTrack.frames[guideFrameAt(g, g.range.startMs + ms)]?.box ?? null;
}

const DEMO_W = 1280, DEMO_H = 720, DEMO_HZ = 15;
const DEMO_BALL = (t: number): Box => ({ cx: 0.72, cy: 0.8 - 0.42 * Math.abs(Math.sin((Math.PI * t) / 1.2)), w: 0.07, h: 0.07 * (DEMO_W / DEMO_H) });

/** The demo: the starter dancer on the left of a wide frame and a bouncing ball on the right. */
export function demoScene(): Scene {
  const aspect = DEMO_W / DEMO_H, starterAspect = 4 / 3;
  const samples = makeSequenceTimeline(DEMO_SEQUENCE, { idleDegrees: 2, aspect: starterAspect });
  const durationMs = Math.floor(samples[samples.length - 1].t * 1000);
  const source = { width: DEMO_W, height: DEMO_H, durationMs, sampleHz: DEMO_HZ };
  const poseFrames = [], personBoxes = [], ballBoxes = [];
  for (let tMs = 0; tMs <= durationMs; tMs += 1000 / DEMO_HZ) {
    const s = sampleAt(samples, tMs / 1000);
    // Shrink to 80% and move to the left third. A uniform scale and shift keeps every limb angle.
    const lms = s?.landmarks
      ? (s.landmarks as LandmarkObject[]).map((l) => [((l.x * starterAspect - starterAspect / 2) * 0.8 + 0.3 * aspect) / aspect, 0.12 + 0.8 * l.y, l.visibility ?? 1] as const)
      : null;
    poseFrames.push({ tMs, landmarks: lms });
    personBoxes.push({ tMs, box: lms ? boxFromLandmarks(lms) : null });
    ballBoxes.push({ tMs, box: DEMO_BALL(tMs / 1000) });
  }
  const base = { schema: "guide/1" as const, fingerprint: "demo", source, range: { startMs: 0, endMs: durationMs }, keyMoments: [], pace: "medium" as const, warnings: [], check: null };
  const dancer: Guide = {
    ...base, subject: { kind: "person", label: "the dancer" }, channel: "pose",
    timeline: { schema: "pose-timeline/1", source: { width: DEMO_W, height: DEMO_H, mirrored: false }, frames: poseFrames },
    boxTrack: { schema: "box-track/1", source: { width: DEMO_W, height: DEMO_H }, frames: personBoxes },
    outlines: poseFrames.map(() => null),
  };
  const ball: Guide = {
    ...base, subject: { kind: "thing", label: "the ball" }, channel: "trajectory", timeline: null,
    boxTrack: { schema: "box-track/1", source: { width: DEMO_W, height: DEMO_H }, frames: ballBoxes },
    outlines: ballBoxes.map(() => null),
  };
  return { name: "Demo scene", width: DEMO_W, height: DEMO_H, startMs: 0, durationMs, guides: [dancer, ball].map(withThingOutlines), video: null };
}

/** A video read by the clip side. Returns the sentence why not when it has no one to copy. */
export async function videoScene(file: File, video: HTMLVideoElement, onProgress: (share: number) => void): Promise<Scene | string> {
  const prepared = await prepareVideo(file, video, onProgress);
  if (prepared.error !== null) return prepared.error;
  const { guides, skipped } = subjectGuides(prepared.data);
  if (guides.length === 0) return skipped[0]?.reason ?? "No one to copy in this clip.";
  const g = guides[0]!;
  return {
    name: file.name, width: g.source.width, height: g.source.height,
    startMs: g.range.startMs, durationMs: g.range.endMs - g.range.startMs,
    guides: guides.map(withThingOutlines), video,
  };
}

// ---- Roles ----

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a;
}

/** Every player gets a role; roles repeat only when there are more players than subjects. */
export function deal(names: string[], guides: Guide[]): Seat[] {
  let pool: Guide[] = [];
  return names.map((name, i) => {
    if (pool.length === 0) pool = shuffle(guides);
    const guide = pool.pop()!;
    const hasOutline = guide.outlines.some((o) => o !== null);
    const look: Look = isThing(guide) || (hasOutline && Math.random() < 0.5) ? "outline" : "stick";
    return { name, color: PLAYER_COLORS[i % PLAYER_COLORS.length], guide, look, part: "body", cutouts: [], result: null, recording: null };
  });
}

/** What a player is told about their role. */
function roleText(s: Seat): string {
  const what = s.look === "outline" ? "its outline" : "its stick figure";
  return isThing(s.guide)
    ? `You are ${s.guide.subject.label}. You will see only ${what}, never the clip. Move with it.`
    : `You are ${s.guide.subject.label}. You will see only ${what}, never the clip. Copy it like a mirror.`;
}

// ---- A turn ----

/** A simulated player for a role, so the whole mode can be tried without a camera. */
function simulatedFor(s: Seat, scene: Scene, deps: BlindDeps): Player {
  if (isThing(s.guide)) {
    const like = { boxAt: (ms: number) => boxAt(s.guide, ms), durationMs: scene.durationMs } as unknown as ObjectClip;
    return simulatedObjectPlayer(like, () => 1 - deps.noise() / 50, s.part);
  }
  const frames = s.guide.timeline?.frames ?? [];
  const samples = frames.map((f) => ({ t: f.tMs / 1000, landmarks: f.landmarks ? f.landmarks.map(([x, y, v]) => ({ x, y, z: 0, visibility: v })) : null }));
  return simulatedPlayer({ samples, width: scene.width, height: scene.height }, deps.noise);
}

async function playTurn(s: Seat, scene: Scene, deps: BlindDeps, ui: BlindUi): Promise<void> {
  const player = deps.simMode() ? simulatedFor(s, scene, deps) : await deps.getCamera();
  const g = s.guide;
  const stage = ui.playStage();
  fitCanvas(stage.guideCanvas, scene.width / scene.height);
  // A person is centred and sized to fill the view; a thing keeps its place so its travel shows.
  const view = blindView(g, stage.guideCanvas, isThing(g) ? "exact" : "fit");
  const style = { background: "#16161d", color: s.color };
  let clipMs = -1;
  let pose: LandmarkObject[] | null = null, aspect = 4 / 3;
  const paint = () => {
    drawBlind(stage.guideCanvas, g, guideFrameAt(g, g.range.startMs + Math.max(0, clipMs)), s.look, view, style);
    fitCanvas(stage.playerCanvas, aspect);
    drawFrame(stage.playerCanvas, deps.simMode() ? null : stage.cam, pose, { mirror: true, color: s.color });
  };
  // A timer, not requestAnimationFrame, so it keeps drawing in a background tab.
  const painter = window.setInterval(paint, 1000 / 30);
  paint();
  await ui.countdown(3);
  // Cutouts at about 15 a second: plenty for the replay, and four players' worth stays small.
  s.cutouts = [];
  let lastCut = -Infinity;
  player.setCapture?.((f) => {
    if (f.clipMs - lastCut < 60) return;
    const image = cutFrame(f.source, f.width, f.height, f.landmarks, isThing(g) ? s.part : "body", f.mask);
    if (image) { s.cutouts.push({ clipMs: f.clipMs, image }); lastCut = f.clipMs; }
  });
  const frames = await collectFrames(scene.durationMs, null, player, (f) => { clipMs = f.clipMs; pose = f.player; aspect = f.playerAspect; });
  player.setCapture?.(null);
  clearInterval(painter);
  clipMs = -1; pose = null; paint();

  // recorder.mjs is plain JS; TypeScript misreads its option types from the defaults.
  const rec = new PerformanceRecorder() as unknown as { add(f: unknown, t: number): boolean; finish(o: { durationMs: number; aspect: number }): unknown };
  for (const f of frames) rec.add({ landmarks: f.landmarks }, f.clipTimeMs ?? -1);
  s.recording = rec.finish({ durationMs: scene.durationMs, aspect });

  const playerTimeline = fromWebcamFrames(frames);
  const r = isThing(g) || !g.timeline
    ? scoreTrajectoryRound(g.boxTrack, playerTimeline, { bodyPart: s.part })
    : scorePoseRound(g.timeline, playerTimeline);
  s.result = { score: r.score, tier: r.tier, lagMs: r.lagMs };
}

// ---- The reveal ----

const DEMO_BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]] as const;

/** The demo scene's own picture at `ms`: the dancer and the ball, as the clip would show them. */
function drawDemoScene(ctx: CanvasRenderingContext2D, W: number, H: number, scene: Scene, ms: number) {
  ctx.fillStyle = "#1d2230"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#2a3242"; ctx.fillRect(0, H * 0.86, W, H * 0.14);
  for (const g of scene.guides) {
    const i = guideFrameAt(g, g.range.startMs + ms);
    if (isThing(g)) {
      const b = g.boxTrack.frames[i]?.box;
      if (!b) continue;
      ctx.fillStyle = "#e85d3a";
      ctx.beginPath(); ctx.ellipse(b.cx * W, b.cy * H, (b.w * W) / 2, (b.h * H) / 2, 0, 0, Math.PI * 2); ctx.fill();
      continue;
    }
    const lms = g.timeline?.frames[i]?.landmarks;
    if (!lms) continue;
    ctx.strokeStyle = "#c9d1e0"; ctx.lineWidth = H * 0.025; ctx.lineCap = "round";
    for (const [a, b] of DEMO_BONES) {
      ctx.beginPath(); ctx.moveTo(lms[a]![0] * W, lms[a]![1] * H); ctx.lineTo(lms[b]![0] * W, lms[b]![1] * H); ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(lms[0]![0] * W, lms[0]![1] * H, H * 0.04, 0, Math.PI * 2); ctx.stroke();
  }
}

async function recordGroupReveal(seats: Seat[], scene: Scene, canvas: HTMLCanvasElement, onProgress: (share: number) => void): Promise<string | null> {
  canvas.height = Math.round(canvas.width * (scene.height / scene.width));
  const W = canvas.width, H = canvas.height;
  const layers: RevealLayer[] = seats.map((s) => ({
    cutouts: s.cutouts, lagMs: s.result?.lagMs ?? 0, kind: isThing(s.guide) ? "thing" : "person",
    boxAt: (ms: number) => boxAt(s.guide, ms), color: s.color,
    tag: `${s.name} ${s.result?.score ?? "-"}`,
  }));
  const video = scene.video;
  return recordReveal({
    canvas, durationMs: scene.durationMs, layers, onProgress,
    drawBackground: (ctx, ms) => {
      if (video) { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H); ctx.drawImage(video, 0, 0, W, H); }
      else drawDemoScene(ctx, W, H, scene, ms);
    },
    clock: video ? {
      async start() {
        video.muted = true;
        video.currentTime = scene.startMs / 1000;
        await new Promise((r) => video.addEventListener("seeked", r, { once: true }));
        await video.play();
      },
      now: () => video.currentTime * 1000 - scene.startMs,
      stop: () => video.pause(),
    } : undefined,
  });
}

// ---- The game ----

function roleOf(s: Seat): RoleInfo {
  return {
    label: s.guide.subject.label, kind: s.guide.subject.kind, look: s.look, text: roleText(s),
    parts: isThing(s.guide) ? Object.entries(BODY_PARTS).map(([key, p]) => ({ key: key as BodyPart, label: p.label.toLowerCase() })) : null,
  };
}

/** Play one game: deal roles, one turn each on this laptop, then the reveal. Resolves with the results. */
export async function runBlindGame(scene: Scene, names: string[], ui: BlindUi, deps: BlindDeps): Promise<ResultRow[]> {
  const seats = deal(names, scene.guides);
  (window as any).__jesterBlind = { seats, scene };
  for (let i = 0; i < seats.length; i++) {
    const s = seats[i]!;
    await ui.handover(s, i > 0 ? seats[i - 1]! : null);
    let problem: string | undefined;
    for (;;) {
      s.part = await ui.showPart(s, { ...roleOf(s), problem });
      if (!isThing(s.guide)) s.part = "body";
      try { await playTurn(s, scene, deps, ui); break; }
      catch (err) { problem = "Camera did not start: " + (err as Error).message + ". Tick 'Simulated player' to try without one."; }
    }
  }
  await ui.beat?.();

  const scores = seats.map((s) => s.result?.score ?? null);
  const win = winnerIndex(scores);
  const top = win >= 0 ? scores[win] : null;
  const tied = scores.filter((x) => x !== null && x === top).length > 1;
  const rows: ResultRow[] = seats.map((s, i) => ({
    name: s.name, color: s.color, look: s.look,
    role: isThing(s.guide) && s.part !== "body" ? `${s.guide.subject.label}, with the ${BODY_PARTS[s.part].label.toLowerCase()}` : s.guide.subject.label,
    score: s.result?.score ?? null, tier: s.result?.tier ?? null,
    winner: top !== null && scores[i] === top, tied,
  }));
  ui.results(rows);
  const url = await recordGroupReveal(seats, scene, ui.revealCanvas(), (share) => ui.progress(share));
  (window as any).__jesterBlindReveal = url;
  ui.revealReady(url);
  return rows;
}
