// Blind mode on one laptop.
//
// 1. A clip goes in: the demo scene (a dancer and a ball, works offline) or a video, read by the clip side
//    (`prepareVideo` and `subjectGuides`, one guide per subject, all over the same stretch of the clip).
// 2. Each player gets a secret role (a person or a thing) and a look: only the outline or only the stick
//    figure, never the clip. The player is never told what the role is: before the turn they see only its
//    first frame, and for a thing they pick which body part copies it. The role is named only at the reveal.
// 3. Players take turns on the same laptop. Each turn is scored by the engine: the pose channel for a person,
//    the trajectory channel for a thing. Scores stay hidden until the end.
// 4. The reveal: one video of the clip with every player's cutout standing where their subject was, with
//    name tags and scores, recorded in the browser for download. Nothing is uploaded.
//
// This file is the game and makes no DOM of its own: the screens come in as a `BlindUi` (Aaron's look
// implements it in app/src/ui/; app/src/blindScreens.ts is the plain stand-in until then).

import { BODY_PARTS, fromWebcamFrames, scorePoseRound, scoreTrajectoryRound, type BodyPart, type LandmarkObject } from "../../engine/src/index.ts";
import { boxFromLandmarks, type Guide, type Outline } from "../../clip/src/index.ts";
import { DEMO_SEQUENCE, makeSequenceTimeline, makeStickPose, sampleAt } from "../../spikes/pose-match/synthetic.mjs";
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

/**
 * What a player is told before their turn. It deliberately leaves out what the role is (that is the point of
 * blind mode); the role is named only in `results`.
 */
export interface RoleInfo {
  look: Look;
  /** One or two sentences on how to play, never what the role is. */
  text: string;
  /** For a thing: the body parts the player can copy it with (first is the whole body). Null for a person. */
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
  /**
   * Show how to play (never what the role is) while `playStage().guideCanvas` holds the role's first frame.
   * Resolves with the body part picked (always "body" for a person) when the player starts.
   */
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

const DEMO_W = 1280, DEMO_H = 720, DEMO_HZ = 15, DEMO_ASPECT = DEMO_W / DEMO_H;
type Tuple = readonly [number, number, number];
const toTuples = (lms: readonly LandmarkObject[]): Tuple[] => lms.map((l) => [l.x, l.y, l.visibility ?? 1] as const);

/** A drawn scene from functions of time: each person a pose, each thing a box. One guide per subject. */
function syntheticScene(
  name: string, durationMs: number,
  people: { label: string; poseAt: (tMs: number) => Tuple[] | null }[],
  things: { label: string; boxAt: (tMs: number) => Box | null }[],
): Scene {
  const source = { width: DEMO_W, height: DEMO_H, durationMs, sampleHz: DEMO_HZ };
  const times: number[] = [];
  for (let tMs = 0; tMs <= durationMs; tMs += 1000 / DEMO_HZ) times.push(tMs);
  const base = { schema: "guide/1" as const, fingerprint: `demo:${name}`, source, range: { startMs: 0, endMs: durationMs }, keyMoments: [], pace: "medium" as const, warnings: [], check: null };
  const size = { width: DEMO_W, height: DEMO_H };
  const guides: Guide[] = [
    ...people.map(({ label, poseAt }): Guide => {
      const frames = times.map((tMs) => ({ tMs, landmarks: poseAt(tMs) }));
      return {
        ...base, subject: { kind: "person", label }, channel: "pose",
        timeline: { schema: "pose-timeline/1", source: { ...size, mirrored: false }, frames },
        boxTrack: { schema: "box-track/1", source: size, frames: frames.map((f) => ({ tMs: f.tMs, box: f.landmarks ? boxFromLandmarks(f.landmarks) : null })) },
        outlines: frames.map(() => null),
      };
    }),
    ...things.map(({ label, boxAt: at }): Guide => {
      const frames = times.map((tMs) => ({ tMs, box: at(tMs) }));
      return {
        ...base, subject: { kind: "thing", label }, channel: "trajectory", timeline: null,
        boxTrack: { schema: "box-track/1", source: size, frames }, outlines: frames.map(() => null),
      };
    }),
  ];
  return { name, width: DEMO_W, height: DEMO_H, startMs: 0, durationMs, guides: guides.map(withThingOutlines), video: null };
}

/** The demo: the starter dancer on the left of a wide frame and a bouncing ball on the right. */
export function demoScene(): Scene {
  const starterAspect = 4 / 3;
  const samples = makeSequenceTimeline(DEMO_SEQUENCE, { idleDegrees: 2, aspect: starterAspect });
  const durationMs = Math.floor(samples[samples.length - 1].t * 1000);
  return syntheticScene("Demo scene", durationMs, [{
    label: "the dancer",
    poseAt: (tMs) => {
      const s = sampleAt(samples, tMs / 1000);
      // Shrink to 80% and move to the left third. A uniform scale and shift keeps every limb angle.
      return s?.landmarks
        ? (s.landmarks as LandmarkObject[]).map((l) => [((l.x * starterAspect - starterAspect / 2) * 0.8 + 0.3 * DEMO_ASPECT) / DEMO_ASPECT, 0.12 + 0.8 * l.y, l.visibility ?? 1] as const)
        : null;
    },
  }], [{
    label: "the ball",
    boxAt: (tMs) => ({ cx: 0.72, cy: 0.8 - 0.42 * Math.abs(Math.sin((Math.PI * tMs) / 1200)), w: 0.07, h: 0.07 * DEMO_ASPECT }),
  }]);
}

const smooth = (a: number, b: number, t: number) => { const u = Math.min(1, Math.max(0, (t - a) / (b - a))); return u * u * (3 - 2 * u); };

/**
 * An interactive scene: a player dribbling a ball. The ball leaves the hand, hits the floor and comes back
 * to it, so the two roles only line up in the reveal if both players kept the beat.
 * 0 to 6 s slow dribble; 6 to 11 s fast and low (knees bent); 11 to 14 s walking right while dribbling;
 * 14 to 17 s walking back; 17 to 20 s slow again.
 */
export function dribbleScene(): Scene {
  const durationMs = 20000, groundY = 0.9, ballH = 0.085;
  // The dribble's phase, integrated over time so the beat can speed up without jumping.
  const periodAt = (t: number) => 0.9 - 0.4 * (smooth(5.5, 6.5, t) - smooth(10.5, 11.5, t));
  const phase: number[] = [];
  let ph = 0;
  for (let i = 0; i * (1000 / DEMO_HZ) <= durationMs + 1; i++) { phase.push(ph); ph += 1 / DEMO_HZ / periodAt(i / DEMO_HZ); }
  const phaseAt = (tMs: number) => phase[Math.min(phase.length - 1, Math.round(tMs / (1000 / DEMO_HZ)))]!;
  const frameAt = (tMs: number) => {
    const t = tMs / 1000, u = phaseAt(tMs) % 1;
    const low = smooth(5.5, 6.5, t) - smooth(10.5, 11.5, t);
    const centerX = 0.42 + 0.16 * (smooth(11, 14, t) - smooth(14, 17, t));
    // Right hand (image left) pushes down at u = 0 and rises while the ball is away; left arm out for balance.
    const spec = {
      rightUpperArm: -20 - 10 * low, rightForearm: -35 + 25 * Math.cos(2 * Math.PI * u),
      leftUpperArm: 35, leftForearm: 50,
      leftThigh: 5 + 35 * low, leftShin: -20 * low, rightThigh: -5 - 35 * low, rightShin: 20 * low, lean: 0,
    };
    const opts = { centerX, groundY, scale: 0.85, aspect: DEMO_ASPECT };
    const pose = makeStickPose(spec, opts) as LandmarkObject[];
    // Where the hand meets the ball: the wrist at the bottom of the push.
    const contact = (makeStickPose({ ...spec, rightForearm: -10 }, opts) as LandmarkObject[])[16]!;
    const top = contact.y + ballH / 2 + 0.01, floor = groundY - ballH / 2;
    const box: Box = { cx: contact.x, cy: top + (floor - top) * Math.sin(Math.PI * u), w: ballH / DEMO_ASPECT, h: ballH };
    return { pose, box };
  };
  return syntheticScene("Dribble", durationMs,
    [{ label: "the dribbler", poseAt: (tMs) => toTuples(frameAt(tMs).pose) }],
    [{ label: "the basketball", boxAt: (tMs) => frameAt(tMs).box }]);
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

/** What a player is told. It never names the role or describes it: the first frame is all they get. */
function roleText(s: Seat): string {
  return isThing(s.guide)
    ? "This is the first frame of what you will copy. You will see only this, moving, never the clip. Pick what you will copy it with, then start."
    : "This is the first frame of what you will copy. You will see only this, moving, never the clip. Copy it like a mirror.";
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

/** How a role is drawn for its player: a person centred and sized to fill the view, a thing in its place so its travel shows. */
function roleView(s: Seat, canvas: HTMLCanvasElement, scene: Scene) {
  fitCanvas(canvas, scene.width / scene.height);
  return { view: blindView(s.guide, canvas, isThing(s.guide) ? "exact" : "fit"), style: { background: "#16161d", color: s.color } };
}

/** The role's first frame, the only thing the player sees of it before the turn. */
function drawFirstFrame(s: Seat, scene: Scene, ui: BlindUi) {
  const { guideCanvas } = ui.playStage();
  const { view, style } = roleView(s, guideCanvas, scene);
  const g = s.guide;
  // The first frame where the subject is visible.
  const first = Math.max(0, g.boxTrack.frames.findIndex((f) => f.box !== null));
  drawBlind(guideCanvas, g, first, s.look, view, style);
}

async function playTurn(s: Seat, scene: Scene, deps: BlindDeps, ui: BlindUi): Promise<void> {
  const player = deps.simMode() ? simulatedFor(s, scene, deps) : await deps.getCamera();
  const g = s.guide;
  const stage = ui.playStage();
  const { view, style } = roleView(s, stage.guideCanvas, scene);
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
    look: s.look, text: roleText(s),
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
      drawFirstFrame(s, scene, ui);
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
