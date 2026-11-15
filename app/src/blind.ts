// Blind mode on one laptop.
//
// 1. A clip goes in: the demo scene (a dancer and a ball, works offline) or a video, read by the clip side
//    (`prepareVideo` and `subjectGuides`, one guide per subject, all over the same stretch of the clip).
// 2. Each player gets a secret role (a person or a thing) and a look: only the outline or only the stick
//    figure, never the clip. The player is never told what the role is: before the turn they see only its
//    first frame, and they pick which body part copies it (a person with the whole body is scored limb by
//    limb; any role with a hand or the head is scored as that part following the role's movement). The role is named only at the reveal.
// 3. Players take turns on the same laptop. Each turn is scored by the engine: the pose channel for a person,
//    the trajectory channel for a thing. Scores stay hidden until the end.
// 4. The reveal: one video of the clip with every player's cutout standing where their subject was, with
//    name tags and scores, recorded in the browser for download. Nothing is uploaded.
//
// This file is the game and makes no DOM of its own: the screens come in as a `BlindUi` (Aaron's look
// implements it in app/src/ui/; app/src/blindScreens.ts is the plain stand-in until then).

import { BODY_PARTS, fromWebcamFrames, scorePoseRound, scoreTrajectoryRound, smoothTimeline, type BodyPart, type LandmarkObject } from "../../engine/src/index.ts";
import { boxFromLandmarks, type Guide, type Outline } from "../../clip/src/index.ts";
import { DEMO_SEQUENCE, makeSequenceTimeline, makeStickPose, sampleAt } from "../../spikes/pose-match/synthetic.mjs";
import { PLAYER_COLORS, winnerIndex } from "../../spikes/pose-match/reveal.mjs";
import { PerformanceRecorder } from "../../spikes/pose-match/recorder.mjs";
import { blindView, drawBlind, guideFrameAt, type Look } from "./clipside/blind.ts";
import { prepareVideo, subjectGuides } from "./clip.ts";
import { collectFrames, simulatedPlayer, type Player } from "./round.ts";
import { simulatedObjectPlayer, type ObjectClip } from "./objectClips.ts";
import { stance, displayedHeight, scaleView, SizeMatcher } from "../../spikes/pose-match/fit.mjs";
import { Calibrator } from "../../spikes/pose-match/calibration.mjs";
import { cutFrame, drawLayers, recordSegments, type Box, type Cutout, type RevealLayer, type Segment, type SegmentClock } from "./cutout.ts";
import { drawFrame, fitCanvas } from "./draw.ts";
import { cropFace } from "./ui/faceBadge.ts";

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
  /** The role as played (slowed to the game's speed). */
  guide: Guide;
  /** The same role at the clip's own speed: turns are scored against this. */
  original: Guide;
  look: Look;
  part: BodyPart;
  cutouts: Cutout[];
  /** A still of the player's face from the start of their turn, for the results badges. Never leaves the device. */
  face: HTMLCanvasElement | null;
  /** `lagMs` is in the clip's own time. */
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
  /** The body parts the player can copy it with (first is the whole body). Offered for every role, so it gives nothing away. */
  parts: { key: BodyPart; label: string }[];
  /** Plays the role once on `playStage().guideCanvas`, unscored, at the game's speed, then shows the first frame again. */
  preview(): Promise<void>;
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
  /** The role's guide at the clip's own speed, and the player's pose recording in clip media ms: what Lisa's drawReveal (composite.ts) takes. */
  guide: Guide;
  timeline: { aspect: number; frames: { t: number; landmarks: unknown[] }[] } | null;
  /** The player's face from the start of their turn (null with no camera). */
  face: HTMLCanvasElement | null;
  /** The player's cutouts placed on their role, in reveal ms from the start of the stretch: drawLayers takes it (used by linkReveal.ts). */
  layer?: RevealLayer;
}

export interface GameOptions {
  /**
   * Playback speed of every turn: 1 is the clip's own speed, 0.5 half speed. First-time players keep up
   * better slowed down. Scoring is against the slowed role, and the reveal plays at the clip's own speed
   * with each player's cutout sped up to match.
   */
  speed?: number;
  /** How far ahead (ms of play time) the faint look-ahead copy of the role runs; 0 turns it off. */
  leadMs?: number;
  /** Player colours in turn order (default PLAYER_COLORS). Set by the look. */
  colors?: readonly string[];
  /** How the recorded reveal looks (default: the dark card). Set by the look. */
  theme?: Partial<RevealTheme>;
  /**
   * Record the reveal video at the end (default true). Online blind mode turns it off: each device plays
   * one role, so the group reveal is drawn from everyone's results once they are all in.
   */
  reveal?: boolean;
}

export const SPEEDS = [1, 0.75, 0.5] as const;

/**
 * The screens blind mode needs. Each Promise resolves when the player presses on. Ids and markup are the
 * UI's own; blind.ts only draws on the canvases it is given.
 */
export interface BlindUi {
  /** Pass the laptop to `player`; `previous` just finished (their score stays secret). Resolves when `player` is ready to see their role. */
  handover(player: PlayerInfo, previous: PlayerInfo | null): Promise<void>;
  /**
   * Show how to play (never what the role is) while `playStage().guideCanvas` holds the role's first frame.
   * Resolves with the body part picked when the player starts.
   */
  showPart(player: PlayerInfo, role: RoleInfo): Promise<BodyPart>;
  /** Where a turn is drawn: the role (outline or stick figure only) and the player's mirror view. */
  playStage(): { guideCanvas: HTMLCanvasElement; playerCanvas: HTMLCanvasElement; cam: HTMLVideoElement };
  countdown(seconds: number): Promise<void>;
  /** A short pause after the last turn, before the reveal (optional). */
  beat?(): Promise<void>;
  /**
   * Called when a turn's moves start counting (right after the countdown), with a way to start the turn over.
   * Calling `restart` stops the turn and goes back to `showPart` for the same player. The look decides when and
   * how often to offer it (Jester: only in the first 5 seconds, once per player per game).
   */
  turnStarted?(restart: () => void): void;
  /** The canvas the reveal is drawn on while it records. */
  revealCanvas(): HTMLCanvasElement;
  /** Optional: set `speed` above 1 while the reveal records to fast forward it (16 skips it); the UI's buttons own this. */
  revealControl?: { speed: number };
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

/**
 * Hides the clip's own subjects at replay time `ms` so the players can stand in their place: each
 * subject's outline (grown a little, or an ellipse round its box when there is none) is filled with a
 * heavily blurred copy of the frame underneath.
 */
function eraseSubjects(c: CanvasRenderingContext2D, W: number, H: number, video: HTMLVideoElement, guides: readonly Guide[], ms: number) {
  if (ms < 0) return;
  for (const g of guides) {
    const i = guideFrameAt(g, g.range.startMs + ms);
    const outline = g.outlines[i] ?? null, box = g.boxTrack.frames[i]?.box ?? null;
    if (!box && !outline) continue;
    c.save();
    c.beginPath();
    if (outline && outline.length >= 3) {
      const mx = outline.reduce((a, p) => a + p[0], 0) / outline.length, my = outline.reduce((a, p) => a + p[1], 0) / outline.length;
      outline.forEach(([x, y], k) => {
        const px = (mx + (x - mx) * 1.15) * W, py = (my + (y - my) * 1.08) * H;
        if (k === 0) c.moveTo(px, py); else c.lineTo(px, py);
      });
      c.closePath();
    } else if (box) {
      // 1.45 and 1.3 reach past the box corners.
      c.ellipse(box.cx * W, box.cy * H, (box.w * W) / 2 * 1.45, (box.h * H) / 2 * 1.3, 0, 0, Math.PI * 2);
    }
    c.clip();
    // Blur from a frame drawn larger than the canvas, so the blur pulls in colour from around the subject.
    c.filter = `blur(${Math.round(W / 25)}px)`;
    c.drawImage(video, -W * 0.05, -H * 0.05, W * 1.1, H * 1.1);
    c.filter = "none";
    c.fillStyle = "rgba(0,0,0,0.2)";
    c.fillRect(0, 0, W, H);
    c.restore();
  }
}

/** Below this, a limb is not drawn (clipside/blind.ts and draw.ts). */
const DRAWN_VISIBILITY = 0.5;

/**
 * A person role made steady: jitter softened, and every frame with no person filled with a best guess
 * (a straight line between the poses either side, or the nearest pose held at the ends). Its box follows
 * the steadied pose, so the reveal never loses its place either.
 */
function steadyRole(g: Guide): Guide {
  if (!g.timeline || isThing(g)) return g;
  const timeline = smoothTimeline(g.timeline, { maxFill: Infinity, holdEnds: true });
  const frames = g.boxTrack.frames;
  const boxTrack = timeline.frames.length !== frames.length ? g.boxTrack : {
    ...g.boxTrack,
    frames: frames.map((f, i) => {
      const lms = timeline.frames[i]!.landmarks;
      return { ...f, box: (lms && boxFromLandmarks(lms)) ?? f.box };
    }),
  };
  return { ...g, timeline, boxTrack };
}

/** The role as drawn: every point shown, using the tracker's best guess where it was unsure. Scoring keeps the real visibility. */
function fullFigure(g: Guide): Guide {
  if (!g.timeline || isThing(g)) return g;
  return {
    ...g,
    timeline: { ...g.timeline, frames: g.timeline.frames.map((f) => ({ ...f, landmarks: f.landmarks && f.landmarks.map(([x, y, v]) => [x, y, Math.max(v, DRAWN_VISIBILITY)] as const) })) },
  };
}

/** The same guide played slower: every time stretched by 1 / speed. `range.startMs` stays the clip's media start. */
function slowGuide(g: Guide, speed: number): Guide {
  if (speed === 1) return g;
  const k = 1 / speed;
  return {
    ...g,
    source: { ...g.source, sampleHz: g.source.sampleHz * speed, durationMs: g.source.durationMs * k },
    range: { startMs: g.range.startMs, endMs: g.range.startMs + (g.range.endMs - g.range.startMs) * k },
    timeline: g.timeline && { ...g.timeline, frames: g.timeline.frames.map((f) => ({ ...f, tMs: f.tMs * k })) },
    boxTrack: { ...g.boxTrack, frames: g.boxTrack.frames.map((f) => ({ ...f, tMs: f.tMs * k })) },
    keyMoments: g.keyMoments.map((m) => ({ ...m, tMs: m.tMs * k })),
  };
}

/** The scene as played: slowed to `speed`. */
export function slowScene(scene: Scene, speed: number): Scene {
  return speed === 1 ? scene : { ...scene, durationMs: scene.durationMs / speed, guides: scene.guides.map((g) => slowGuide(g, speed)) };
}

/**
 * A one-frame guide blended between the two samples around play time `ms`, so the role moves smoothly even
 * when slowed (guides are sampled about 15 times a second). Draw it with index 0.
 */
function guideAt(g: Guide, ms: number): Guide {
  const frameMs = 1000 / g.source.sampleHz;
  const last = g.boxTrack.frames.length - 1;
  const pos = Math.min(last, Math.max(0, ms / frameMs));
  const i = Math.floor(pos), j = Math.min(last, i + 1), u = pos - i;
  const lerp = (a: number, b: number) => a + (b - a) * u;
  const b0 = g.boxTrack.frames[i]!.box, b1 = g.boxTrack.frames[j]!.box;
  const box = b0 && b1 ? { cx: lerp(b0.cx, b1.cx), cy: lerp(b0.cy, b1.cy), w: lerp(b0.w, b1.w), h: lerp(b0.h, b1.h) } : b0;
  const o0 = g.outlines[i] ?? null, o1 = g.outlines[j] ?? null;
  const outline = o0 && o1 && o0.length === o1.length ? o0.map(([x, y], k) => [lerp(x, o1[k]![0]), lerp(y, o1[k]![1])] as [number, number]) : u < 0.5 ? o0 : o1 ?? o0;
  const l0 = g.timeline?.frames[i]?.landmarks ?? null, l1 = g.timeline?.frames[j]?.landmarks ?? null;
  const landmarks = l0 && l1 ? l0.map(([x, y, v], k) => [lerp(x, l1[k]![0]), lerp(y, l1[k]![1]), Math.min(v, l1[k]![2])] as const) : l0;
  return {
    ...g,
    boxTrack: { ...g.boxTrack, frames: [{ tMs: ms, box }] },
    outlines: [outline],
    timeline: g.timeline && { ...g.timeline, frames: [{ tMs: ms, landmarks }] },
  };
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
export function deal(names: string[], guides: Guide[], colors: readonly string[] = PLAYER_COLORS): Seat[] {
  let pool: Guide[] = [];
  return names.map((name, i) => {
    if (pool.length === 0) pool = shuffle(guides);
    const guide = pool.pop()!;
    // People are always a stick figure (a moving outline is too hard to read); things are their outline.
    const look: Look = isThing(guide) ? "outline" : "stick";
    return { name, color: colors[i % colors.length]!, guide, original: guide, look, part: "body", cutouts: [], face: null, result: null, recording: null };
  });
}

/** What a player is told. It never names the role or describes it: the first frame is all they get. */
function roleText(): string {
  return "This is the first frame of what you will copy. You will see only this, moving, never the clip. Pick what you will copy it with, then start. With your whole body, copy it like a mirror.";
}

/**
 * True when the player copies the role's box with one body part (a thing, or a person played with a hand or
 * the head); false when a person is copied limb by limb with the whole body.
 */
const followsBox = (s: Seat) => isThing(s.guide) || s.part !== "body";

// ---- A turn ----

/** A simulated player for a role, so the whole mode can be tried without a camera. */
function simulatedFor(s: Seat, scene: Scene, deps: BlindDeps): Player {
  if (followsBox(s)) {
    const like = { boxAt: (ms: number) => boxAt(s.guide, ms), durationMs: scene.durationMs } as unknown as ObjectClip;
    return simulatedObjectPlayer(like, () => 1 - deps.noise() / 50, s.part);
  }
  const frames = s.guide.timeline?.frames ?? [];
  const samples = frames.map((f) => ({ t: f.tMs / 1000, landmarks: f.landmarks ? f.landmarks.map(([x, y, v]) => ({ x, y, z: 0, visibility: v })) : null }));
  return simulatedPlayer({ samples, width: scene.width, height: scene.height }, deps.noise);
}

/** How a role is drawn for its player: a person centred and sized to fill the view, a thing in its place so its travel shows. */
function roleView(s: Seat, canvas: HTMLCanvasElement, scene: Scene) {
  // A person fills whatever space the screen gives the role (half the stage while playing); a thing keeps
  // the clip's shape, so where it travels stays true.
  const shown = canvas.clientWidth > 0 && canvas.clientHeight > 0 ? canvas.clientWidth / canvas.clientHeight : 0;
  fitCanvas(canvas, !isThing(s.guide) && shown ? shown : scene.width / scene.height);
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

/**
 * Draws the role at play time `ms` on `canvas`, with a faint copy `leadMs` ahead so the next move shows
 * coming (it hides behind the role when nothing changes).
 */
function paintRole(canvas: HTMLCanvasElement, s: Seat, view: ReturnType<typeof roleView>, ms: number, leadMs: number, scratch: HTMLCanvasElement) {
  if (leadMs > 0) {
    scratch.width = canvas.width; scratch.height = canvas.height;
    drawBlind(scratch, guideAt(s.guide, ms + leadMs), 0, s.look, view.view, view.style);
  }
  drawBlind(canvas, guideAt(s.guide, ms), 0, s.look, view.view, view.style);
  if (leadMs > 0) {
    const ctx = canvas.getContext("2d")!;
    ctx.save(); ctx.globalAlpha = 0.3; ctx.globalCompositeOperation = "lighter"; ctx.drawImage(scratch, 0, 0); ctx.restore();
  }
}

/**
 * Before a whole-body turn: shows the camera and waits until the player's whole body (shoulders, hips, knees and
 * ankles) has been in view for about 0.7 s, telling them what to do ("Step back until your knees and ankles are in
 * view"). After 12 s the hint becomes clickable ("click to start anyway") for a room too small to fit in.
 */
async function waitForFraming(player: Player, stage: { guideCanvas: HTMLCanvasElement; playerCanvas: HTMLCanvasElement }, onFrame: (f: { landmarks: LandmarkObject[] | null; aspect: number }) => void) {
  const host = stage.guideCanvas.parentElement!;
  const hint = document.createElement("div");
  hint.style.cssText = "position:absolute;left:0;right:0;bottom:6%;text-align:center;font:800 clamp(18px,3vw,34px) system-ui,sans-serif;color:#fff;text-shadow:0 2px 8px #000,0 0 3px #000;padding:0 14px;z-index:6;pointer-events:none";
  hint.textContent = "Step into view so your whole body is in the picture.";
  host.appendChild(hint);
  stage.playerCanvas.style.opacity = "1"; // the camera is hidden until the countdown; bring it in so they can position themselves
  const calibrator = new Calibrator();
  await new Promise<void>((resolve) => {
    let finished = false;
    const done = () => { if (!finished) { finished = true; resolve(); } };
    const late = window.setTimeout(() => { hint.style.pointerEvents = "auto"; hint.style.cursor = "pointer"; hint.onclick = done; hint.dataset.late = "1"; }, 12000);
    player.start((f) => {
      onFrame({ landmarks: f.landmarks as LandmarkObject[] | null, aspect: f.aspect });
      const r = calibrator.update(f.landmarks as never, 30);
      hint.textContent = r.passed ? "Got you." : r.message + (hint.dataset.late ? " (Click here to start anyway.)" : "");
      if (r.passed) { clearTimeout(late); done(); }
    }, () => -1);
  });
  player.stop();
  hint.remove();
  stage.playerCanvas.style.opacity = "";
}

/** Stops a preview still playing when the turn starts. */
let stopPreview: (() => void) | null = null;

/** Plays the role once on the stage, unscored, then shows its first frame again. */
async function previewRole(s: Seat, scene: Scene, ui: BlindUi, leadMs: number) {
  stopPreview?.();
  const { guideCanvas } = ui.playStage();
  const view = roleView(s, guideCanvas, scene);
  const scratch = document.createElement("canvas");
  const started = performance.now();
  const finished = await new Promise<boolean>((resolve) => {
    const timer = window.setInterval(() => {
      const ms = performance.now() - started;
      paintRole(guideCanvas, s, view, Math.min(ms, scene.durationMs), leadMs, scratch);
      if (ms >= scene.durationMs) { clearInterval(timer); stopPreview = null; resolve(true); }
    }, 1000 / 30);
    stopPreview = () => { clearInterval(timer); stopPreview = null; resolve(false); };
  });
  if (finished) drawFirstFrame(s, scene, ui);
}

async function playTurn(s: Seat, scene: Scene, speed: number, deps: BlindDeps, ui: BlindUi, leadMs: number): Promise<void> {
  stopPreview?.();
  const player = deps.simMode() ? simulatedFor(s, scene, deps) : await deps.getCamera();
  const g = s.guide;
  const stage = ui.playStage();
  const view = roleView(s, stage.guideCanvas, scene);
  const scratch = document.createElement("canvas");
  let clipMs = -1;
  let pose: LandmarkObject[] | null = null, aspect = 4 / 3;
  // The shape to copy follows how big you look: closer to the camera makes it bigger, further makes it smaller.
  const matcher = new SizeMatcher();
  const sizeToPlayer = !followsBox(s) && !isThing(g);
  const shownHeight = (c: HTMLCanvasElement) => {
    const r = c.getBoundingClientRect();
    return displayedHeight(r.width, r.height, c.width, c.height, getComputedStyle(c).objectFit === "cover" ? "cover" : "contain");
  };
  const sizedView = (): typeof view => {
    if (!sizeToPlayer || clipMs < 0 || !pose) return view;
    const mine = stance(pose, aspect, 1); // torso in image heights
    const frame = guideAt(g, clipMs).timeline?.frames[0]?.landmarks;
    const ref = frame ? stance(frame, g.source.width, g.source.height) : null;
    if (!mine || !ref) return view;
    const gc = stage.guideCanvas, pc = stage.playerCanvas;
    const playerPx = mine.torso * shownHeight(pc);
    const guidePx = ref.torso * view.view.scale * (shownHeight(gc) / gc.height); // on screen at the base scale
    const k = matcher.update(playerPx, guidePx);
    const ax = ref.hipX * view.view.scale + view.view.offsetX, ay = ref.hipY * view.view.scale + view.view.offsetY;
    return { ...view, view: scaleView(view.view, k, ax, ay) };
  };
  const paint = () => {
    paintRole(stage.guideCanvas, s, sizedView(), Math.max(0, clipMs), clipMs >= 0 ? leadMs : 0, scratch);
    fitCanvas(stage.playerCanvas, aspect);
    drawFrame(stage.playerCanvas, deps.simMode() ? null : stage.cam, pose, { mirror: true, color: s.color });
  };
  // A timer, not requestAnimationFrame, so it keeps drawing in a background tab.
  const painter = window.setInterval(paint, 1000 / 30);
  paint();
  // A whole-body turn waits until the player is fully in view; a simulated player is always in view.
  if (!deps.simMode() && !followsBox(s)) {
    try { await waitForFraming(player, stage, (f) => { pose = f.landmarks; aspect = f.aspect; }); pose = null; }
    catch { /* no camera frames: just carry on to the countdown */ }
  }
  await ui.countdown(3);
  // Cutouts at about 15 a second: plenty for the replay, and four players' worth stays small.
  s.cutouts = [];
  s.face = null;
  let lastCut = -Infinity;
  player.setCapture?.((f) => {
    if (!s.face && f.source) s.face = cropFace(f.source, f.width, f.height, f.landmarks, 256);
    if (f.clipMs - lastCut < 60) return;
    const image = cutFrame(f.source, f.width, f.height, f.landmarks, s.part, f.mask);
    if (image) { s.cutouts.push({ clipMs: f.clipMs, image }); lastCut = f.clipMs; }
  });
  // The look may offer a restart while the moves count; it ends this turn at once and plays nothing back.
  let restart: () => void = () => {};
  const restarted = new Promise<"restart">((resolve) => { restart = () => resolve("restart"); });
  ui.turnStarted?.(restart);
  const frames = await Promise.race([
    collectFrames(scene.durationMs, null, player, (f) => { clipMs = f.clipMs; pose = f.player; aspect = f.playerAspect; }),
    restarted,
  ]);
  player.setCapture?.(null);
  clearInterval(painter);
  clipMs = -1; pose = null; paint();
  if (frames === "restart") { player.stop(); throw new RestartTurn(); }

  // recorder.mjs is plain JS; TypeScript misreads its option types from the defaults.
  const rec = new PerformanceRecorder() as unknown as { add(f: unknown, t: number): boolean; finish(o: { durationMs: number; aspect: number }): unknown };
  for (const f of frames) rec.add({ landmarks: f.landmarks }, f.clipTimeMs ?? -1);
  s.recording = rec.finish({ durationMs: scene.durationMs, aspect });

  // Score in the clip's own time: a slowed turn is sped back up and compared with the role at its real
  // speed, so slow motion neither lowers the effort the engine sees nor changes what counts as on time.
  const o = s.original;
  const playerTimeline = fromWebcamFrames(frames.map((f) => ({ ...f, clipTimeMs: (f.clipTimeMs ?? -1) < 0 ? -1 : f.clipTimeMs! * speed })));
  const r = followsBox(s) || !o.timeline
    ? scoreTrajectoryRound(o.boxTrack, playerTimeline, { bodyPart: s.part })
    : scorePoseRound(o.timeline, playerTimeline);
  s.result = { score: r.score, tier: r.tier, lagMs: r.lagMs };
}

/** Thrown inside a turn when the player starts it over; the turn loop shows their part again. */
class RestartTurn extends Error {}

// ---- The reveal ----

const DEMO_BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]] as const;

/** The demo scene's own picture at `ms`: the dancer and the ball, as the clip would show them. */
export function drawDemoScene(ctx: CanvasRenderingContext2D, W: number, H: number, scene: Scene, ms: number) {
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

/** A playing video as a segment clock, from clip media time `fromMs`. */
function videoClock(video: HTMLVideoElement, fromMs: number): SegmentClock {
  return {
    async start() {
      video.muted = true;
      video.pause();
      const seeked = new Promise((r) => { video.addEventListener("seeked", r, { once: true }); setTimeout(r, 1500); });
      video.currentTime = fromMs / 1000;
      await seeked;
      await video.play();
    },
    now: () => video.currentTime * 1000 - fromMs,
    stop: () => { video.pause(); video.playbackRate = 1; },
    setSpeed: (speed) => { video.playbackRate = Math.min(16, Math.max(0.25, speed)); },
  };
}

/** How the recorded reveal looks. The look sets it per game through `GameOptions.theme`. */
export interface RevealTheme { card: string; ink: string; soft: string; accent: string; font: string; title: string; glow: number }
export const REVEAL_THEME: RevealTheme = { card: "#16161d", ink: "#f2f2f5", soft: "#a0a3b1", accent: "#f5c542", font: "system-ui, -apple-system, sans-serif", title: "Blind mode", glow: 12 };
let theme: RevealTheme = { ...REVEAL_THEME };
const font = (H: number, k: number, weight = 600) => `${weight} ${Math.round(H * k)}px ${theme.font}`;

/** The opening card. */
function drawTitle(ctx: CanvasRenderingContext2D, W: number, H: number, sceneName: string, players: number, ms: number) {
  ctx.fillStyle = theme.card; ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = Math.min(1, ms / 400);
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = theme.accent; ctx.font = font(H, 0.12, 800); ctx.fillText(theme.title, W / 2, H * 0.4);
  ctx.fillStyle = theme.ink; ctx.font = font(H, 0.05); ctx.fillText(`${players} players. Nobody knew who they were playing.`, W / 2, H * 0.56);
  ctx.fillStyle = theme.soft; ctx.font = font(H, 0.04, 400); ctx.fillText(sceneName, W / 2, H * 0.66);
  ctx.globalAlpha = 1;
}

/** The closing card: who played what, how well, and who won. Each player's picture is their own cutout. */
function drawCastCard(ctx: CanvasRenderingContext2D, W: number, H: number, rows: ResultRow[], faces: (HTMLCanvasElement | null)[], ms: number) {
  ctx.fillStyle = theme.card; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = "middle";
  ctx.textAlign = "center"; ctx.fillStyle = theme.accent; ctx.font = font(H, 0.08, 800); ctx.fillText("The cast", W / 2, H * 0.13);
  const rowH = Math.min(H * 0.17, (H * 0.78) / Math.max(1, rows.length));
  rows.forEach((r, i) => {
    // Rows slide in one after another.
    const t = Math.min(1, Math.max(0, (ms - 300 - i * 450) / 350));
    if (t <= 0) return;
    const y = H * 0.25 + i * rowH + rowH / 2;
    ctx.globalAlpha = t;
    const x0 = W * 0.08 + (1 - t) * W * 0.05, face = rowH * 0.85;
    ctx.fillStyle = "#23232d"; ctx.fillRect(x0, y - face / 2, face, face);
    const img = faces[i];
    if (img) ctx.drawImage(img, x0, y - face / 2, face, face);
    ctx.strokeStyle = r.color; ctx.lineWidth = 3; ctx.strokeRect(x0, y - face / 2, face, face);
    ctx.textAlign = "left";
    ctx.fillStyle = r.color; ctx.font = font(H, 0.05, 700); ctx.fillText(r.name, x0 + face + W * 0.025, y - rowH * 0.15);
    ctx.fillStyle = theme.ink; ctx.font = font(H, 0.038, 400); ctx.fillText(`as ${r.role}`, x0 + face + W * 0.025, y + rowH * 0.2);
    ctx.textAlign = "right";
    ctx.fillStyle = r.winner ? theme.accent : theme.ink; ctx.font = font(H, 0.07, 800);
    ctx.fillText(r.score == null ? "-" : String(r.score), W * 0.92, y - rowH * 0.08);
    ctx.fillStyle = r.winner ? theme.accent : theme.soft; ctx.font = font(H, 0.032, 600);
    ctx.fillText(r.winner ? (r.tied ? "Tied for first" : "Winner") : r.tier ?? "", W * 0.92, y + rowH * 0.27);
  });
  ctx.globalAlpha = 1;
}

/**
 * Records the reveal: a title card, the cast over the clip at the clip's own speed, the busiest few seconds
 * side by side with the original, and a closing cast card. `played` is the scene as the turns were played
 * (slowed to `speed`); reveal time ms is play time ms / speed, so each cutout is sped up to match the clip.
 */
/** Each player's cutouts placed on their role, in reveal ms (the clip's own speed) from the start of the stretch. */
function revealLayers(seats: Seat[], speed: number): RevealLayer[] {
  const toPlay = (ms: number) => ms / speed;
  // Players who drew the same role stand side by side around it instead of on top of each other.
  const shiftOf = (s: Seat) => {
    const same = seats.filter((o) => o.guide === s.guide);
    const k = same.indexOf(s);
    return same.length < 2 ? 0 : (k - (same.length - 1) / 2) * 1.3;
  };
  return seats.map((s) => ({
    cutouts: s.cutouts, lagMs: (s.result?.lagMs ?? 0) / speed, timeScale: 1 / speed, kind: followsBox(s) ? "thing" : "person",
    boxAt: (ms: number) => boxAt(s.guide, toPlay(ms)), spread: shiftOf(s),
    color: s.color, tag: `${s.name} ${s.result?.score ?? "-"}`, glow: theme.glow, tagFont: theme.font,
  }));
}

async function recordGroupReveal(seats: Seat[], rows: ResultRow[], played: Scene, speed: number, canvas: HTMLCanvasElement, onProgress: (share: number) => void, control?: { speed: number }): Promise<string | null> {
  const scene = played;
  // Keep the longest side near 1280 px: a tall clip no longer becomes 960 x 1700, which blew each 256 px cutout up
  // about 7 times. Wide clips stay 960 wide.
  canvas.width = scene.width >= scene.height ? 960 : Math.round((1280 * scene.width) / scene.height);
  canvas.height = Math.round(canvas.width * (scene.height / scene.width));
  const W = canvas.width, H = canvas.height;
  const toPlay = (ms: number) => ms / speed;
  const layers = revealLayers(seats, speed);
  const video = scene.video;
  const realMs = scene.durationMs * speed;
  /** The clip with no players at reveal time ms (`from` ms into the stretch, for a video that was seeked there). */
  const background = (from: number) => (c: CanvasRenderingContext2D, ms: number) => {
    if (video) { c.fillStyle = "#000"; c.fillRect(0, 0, W, H); c.drawImage(video, 0, 0, W, H); }
    else drawDemoScene(c, W, H, scene, toPlay(from + ms));
  };
  // The roles someone played: in a video their own subjects are hidden, so each player replaces one.
  const roles = [...new Set(seats.map((s) => s.guide))];
  const withoutSubjects = (from: number) => (c: CanvasRenderingContext2D, ms: number) => {
    background(from)(c, ms);
    if (video) eraseSubjects(c, W, H, video, roles, toPlay(from + ms));
  };
  // A label at the top centre, clear of the stage's valance, readable on any clip.
  const caption = (c: CanvasRenderingContext2D, text: string, color: string) => {
    c.save();
    c.font = font(H, 0.065, 800); c.textAlign = "center"; c.textBaseline = "top";
    c.lineJoin = "round"; c.lineWidth = Math.max(4, H / 90); c.strokeStyle = "rgba(0,0,0,0.75)"; c.strokeText(text, W / 2, H * 0.1);
    c.fillStyle = color; c.fillText(text, W / 2, H * 0.1);
    c.restore();
  };
  // Each player's picture on the cast card: a cutout from the middle of their turn.
  const faces = seats.map((s) => s.cutouts[Math.floor(s.cutouts.length / 2)]?.image ?? null);
  const segments: Segment[] = [
    { durationMs: 2200, draw: (c, ms) => drawTitle(c, W, H, scene.name, seats.length, ms) },
    {
      // The clip as it was, so everyone sees what they were copying.
      durationMs: realMs, clock: video ? videoClock(video, scene.startMs) : undefined,
      draw: (c, ms) => { background(0)(c, ms); caption(c, "The original", "#ffffff"); },
    },
    {
      // The same clip with each player standing in for the subject they played.
      durationMs: realMs, clock: video ? videoClock(video, scene.startMs) : undefined,
      draw: (c, ms) => { withoutSubjects(0)(c, ms); drawLayers(c, W, H, layers, ms); caption(c, "Your cast", theme.accent); },
    },
    { durationMs: 1200 + rows.length * 450 + 3000, draw: (c, ms) => drawCastCard(c, W, H, rows, faces, ms) },
  ];
  return recordSegments(canvas, segments, onProgress, control);
}

// ---- The game ----

/** The player's recording with times moved from play time to the clip's media time. */
function mediaTimeline(s: Seat, scene: Scene, speed: number): ResultRow["timeline"] {
  const rec = s.recording as { aspect: number; frames: { t: number; landmarks: unknown[] }[] } | null;
  if (!rec) return null;
  return { ...rec, frames: rec.frames.map((f) => ({ ...f, t: scene.startMs + f.t * speed })) };
}

function roleOf(s: Seat, scene: Scene, ui: BlindUi, leadMs: number): RoleInfo {
  return {
    look: s.look, text: roleText(),
    parts: Object.entries(BODY_PARTS).map(([key, p]) => ({ key: key as BodyPart, label: p.label.toLowerCase() })),
    preview: () => previewRole(s, scene, ui, leadMs),
  };
}

/** Play one game: deal roles, one turn each on this laptop, then the reveal. Resolves with the results. */
export async function runBlindGame(clip: Scene, names: string[], ui: BlindUi, deps: BlindDeps, options: GameOptions = {}): Promise<ResultRow[]> {
  const speed = options.speed ?? 1, leadMs = options.leadMs ?? 400;
  // Tracking from a real video jitters and loses people; steady every person role once (scored as is) and
  // draw a copy with every limb shown, so the figure never cuts out.
  clip = { ...clip, guides: clip.guides.map(steadyRole) };
  const scene = slowScene({ ...clip, guides: clip.guides.map(fullFigure) }, speed);
  theme = { ...REVEAL_THEME, ...options.theme };
  const seats = deal(names, scene.guides, options.colors ?? PLAYER_COLORS);
  for (const s of seats) s.original = clip.guides[scene.guides.indexOf(s.guide)]!;
  (window as any).__jesterBlind = { seats, scene, speed };
  for (let i = 0; i < seats.length; i++) {
    const s = seats[i]!;
    await ui.handover(s, i > 0 ? seats[i - 1]! : null);
    let problem: string | undefined;
    for (;;) {
      drawFirstFrame(s, scene, ui);
      s.part = await ui.showPart(s, { ...roleOf(s, scene, ui, leadMs), problem });
      try { await playTurn(s, scene, speed, deps, ui, leadMs); break; }
      catch (err) {
        if (err instanceof RestartTurn) { problem = undefined; continue; }
        problem = "Camera did not start: " + (err as Error).message + ". Tick 'Simulated player' to try without one.";
      }
    }
  }
  await ui.beat?.();

  const scores = seats.map((s) => s.result?.score ?? null);
  const win = winnerIndex(scores);
  const top = win >= 0 ? scores[win] : null;
  const tied = scores.filter((x) => x !== null && x === top).length > 1;
  const rows: ResultRow[] = seats.map((s, i) => ({
    name: s.name, color: s.color, look: s.look,
    role: s.part !== "body" ? `${s.guide.subject.label}, with the ${BODY_PARTS[s.part].label.toLowerCase()}` : s.guide.subject.label,
    score: s.result?.score ?? null, tier: s.result?.tier ?? null,
    winner: top !== null && scores[i] === top, tied,
    guide: s.original,
    timeline: mediaTimeline(s, scene, speed),
    face: s.face,
  }));
  revealLayers(seats, speed).forEach((layer, i) => { rows[i]!.layer = layer; });
  ui.results(rows);
  if (options.reveal === false) return rows;
  if (ui.revealControl) ui.revealControl.speed = 1;
  const url = await recordGroupReveal(seats, rows, scene, speed, ui.revealCanvas(), (share) => ui.progress(share), ui.revealControl);
  (window as any).__jesterBlindReveal = url;
  ui.revealReady(url);
  return rows;
}
