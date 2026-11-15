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

import { BODY_PARTS, fromWebcamFrames, scorePoseRound, scoreTrajectoryRound, smoothTimeline, type BodyPart, type LandmarkObject, type WebcamFrame } from "../../engine/src/index.ts";
import { boxFromLandmarks, hideUnsureJoints, type Guide, type Outline } from "../../clip/src/index.ts";
import { DEMO_SEQUENCE, makeSequenceTimeline, makeStickPose, sampleAt } from "../../spikes/pose-match/synthetic.mjs";
import { PLAYER_COLORS, winnerIndex } from "../../spikes/pose-match/reveal.mjs";
import { PerformanceRecorder } from "../../spikes/pose-match/recorder.mjs";
import { blindView, drawBlind, guideFrameAt, type Look } from "./clipside/blind.ts";
import { prepareVideo, subjectGuides } from "./clip.ts";
import { simulatedPlayer, type Player } from "./round.ts";
import { simulatedObjectPlayer, type ObjectClip } from "./objectClips.ts";
import { stance, displayedHeight, scaleView, SizeMatcher } from "../../spikes/pose-match/fit.mjs";
import { Calibrator } from "../../spikes/pose-match/calibration.mjs";
import { cutAnchor, cutFrame, drawLayers, recordSegments, type Box, type Cutout, type RevealLayer, type Segment, type SegmentClock, type Torso } from "./cutout.ts";
import { playWithSound, setAloud } from "./sound.ts";
import { castRowShare } from "./recapRules.ts";
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
  /** Normal mode: the clip itself plays under the role during the turn (no effect on a drawn scene with no video). */
  withClip?: boolean;
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
  /** The body part they played it with, and their timing lag in the clip's own ms: a game played on several devices sends these so every device can draw the same reveal. */
  part?: BodyPart;
  lagMs?: number;
}

export interface GameOptions {
  /**
   * Playback speed of every turn: 1 is the clip's own speed, 0.5 half speed. First-time players keep up
   * better slowed down. Scoring is against the slowed role, and the reveal plays at the clip's own speed
   * with each player's cutout sped up to match.
   */
  speed?: number;
  /** How far ahead (ms of play time) a faint look-ahead copy of the role runs; 0 (the default) shows a clean figure only. */
  leadMs?: number;
  /** Player colours in turn order (default PLAYER_COLORS). Set by the look. */
  colors?: readonly string[];
  /** How the recorded reveal looks (default: the dark card). Set by the look. */
  theme?: Partial<RevealTheme>;
  /**
   * Play the reveal's sound on this device's speakers (default true). Online, only the host's laptop does, so two
   * laptops side by side do not play it twice; every device's recorded reveal still has the sound.
   */
  revealAloud?: boolean;
  /**
   * Record the reveal video at the end (default true). Online blind mode turns it off: each device plays
   * one role, so the group reveal is drawn from everyone's results once they are all in.
   */
  reveal?: boolean;
  /**
   * Normal mode (default false, Blind): during each turn the clip's own video plays on the role's side, in time
   * with the turn's clock, with the role drawn over it so the player knows who to copy. A drawn scene with no
   * video plays as in Blind. Scoring is the same either way.
   */
  showClip?: boolean;
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
  // Blended between the two samples around ms (guides are sampled about 15 times a second), so
  // whatever is placed on the role glides instead of stepping.
  const frames = g.boxTrack.frames;
  const pos = Math.min(frames.length - 1, Math.max(0, (ms * g.source.sampleHz) / 1000));
  const i = Math.floor(pos), j = Math.min(frames.length - 1, i + 1), u = pos - i;
  const a = frames[i]?.box ?? null, b = frames[j]?.box ?? null;
  if (!a || !b) return a ?? b;
  return { cx: a.cx + (b.cx - a.cx) * u, cy: a.cy + (b.cy - a.cy) * u, w: a.w + (b.w - a.w) * u, h: a.h + (b.h - a.h) * u };
}

/** The subject's shoulder and hip centres at replay time `ms`, from its steadied pose, or null. */
function torsoAt(g: Guide, ms: number): Torso | null {
  if (ms < 0) return null;
  const l = guideAt(g, ms).timeline?.frames[0]?.landmarks;
  if (!l || l.length < 25) return null;
  const mid = (a: number, b: number) => ({ x: (l[a]![0] + l[b]![0]) / 2, y: (l[a]![1] + l[b]![1]) / 2 });
  return { shoulder: mid(11, 12), hip: mid(23, 24) };
}

/** How far the cover reaches past a subject's outline, and how soft its rim is, as shares of the frame height. */
const COVER_GROW = 0.028, COVER_FEATHER = 0.009;

/**
 * The subject's outlines at the two samples around play time `ms` (both, so a moving subject is covered all the
 * way between them), or its box as an ellipse where a sample has no outline.
 */
function subjectOutlines(g: Guide, ms: number): Outline[] {
  if (ms < 0) return [];
  const frames = g.boxTrack.frames;
  const pos = Math.min(frames.length - 1, Math.max(0, (ms * g.source.sampleHz) / 1000));
  const i = Math.floor(pos), j = Math.min(frames.length - 1, i + 1);
  const out: Outline[] = [];
  for (const k of i === j ? [i] : [i, j]) {
    const box = frames[k]?.box;
    const o = g.outlines[k] ?? (box ? ellipseOutline(box) : null);
    if (o && o.length >= 3) out.push(o);
  }
  return out;
}

/** Paints the subjects' outlines on `c` (w by h), each grown by `grow` px. False when there was nothing to paint. */
function paintSubjects(c: CanvasRenderingContext2D, w: number, h: number, guides: readonly Guide[], ms: number, grow: number): boolean {
  c.fillStyle = c.strokeStyle = "#000";
  c.lineJoin = "round"; c.lineWidth = 2 * grow;
  let any = false;
  for (const g of guides) {
    // One path per outline: two outlines in one path could cancel where they overlap.
    for (const o of subjectOutlines(g, ms)) {
      c.beginPath();
      o.forEach(([x, y], n) => (n ? c.lineTo(x * w, y * h) : c.moveTo(x * w, y * h)));
      c.closePath(); c.fill(); c.stroke();
      any = true;
    }
  }
  return any;
}

const scratchCanvases = new Map<string, HTMLCanvasElement>();
function scratch(name: string, w: number, h: number): HTMLCanvasElement {
  let s = scratchCanvases.get(name);
  if (!s) { s = document.createElement("canvas"); scratchCanvases.set(name, s); }
  if (s.width !== w || s.height !== h) { s.width = w; s.height = h; }
  return s;
}

/**
 * The cover's shape at play time `ms`: every subject's outline, grown and with a soft rim, drawn at a quarter
 * of the frame's size (it is scaled up smoothly). Null when no subject is in view.
 */
function coverMask(W: number, H: number, guides: readonly Guide[], ms: number): HTMLCanvasElement | null {
  const mw = Math.max(1, Math.round(W / 4)), mh = Math.max(1, Math.round(H / 4));
  const a = scratch("maskShape", mw, mh), ac = a.getContext("2d")!;
  ac.clearRect(0, 0, mw, mh);
  if (!paintSubjects(ac, mw, mh, guides, ms, COVER_GROW * mh)) return null;
  const b = scratch("maskSoft", mw, mh), bc = b.getContext("2d")!;
  bc.clearRect(0, 0, mw, mh);
  bc.filter = `blur(${(COVER_FEATHER * mh).toFixed(2)}px)`;
  bc.drawImage(a, 0, 0);
  bc.filter = "none";
  return b;
}

/**
 * Hides the clip's own subjects at replay time `ms` so the players can stand in their place: each subject's own
 * outline, grown and feathered, is filled with the empty set (`plate`), or with a blurred copy of the frame
 * when there is no plate (a moving camera).
 */
/** Which outline samples the cover at play time `ms` is made from (it only changes when one of these does). */
function coverKey(guides: readonly Guide[], ms: number): string {
  if (ms < 0) return "";
  return guides.map((g) => {
    const pos = Math.min(g.boxTrack.frames.length - 1, Math.max(0, (ms * g.source.sampleHz) / 1000));
    return Math.floor(pos);
  }).join(",");
}

/** The last finished cover: outlines sample at a few Hz, so most frames of a recording reuse it as it is. */
let lastCover: { guides: readonly Guide[]; plate: HTMLCanvasElement; W: number; H: number; key: string; any: boolean } | null = null;

function eraseSubjects(c: CanvasRenderingContext2D, W: number, H: number, video: HTMLVideoElement, guides: readonly Guide[], ms: number, plate: HTMLCanvasElement | null = null) {
  if (ms < 0) return;
  const s = coverCanvas(W, H);
  // With a plate the cover depends only on the outline samples, so it is rebuilt only when they change.
  const key = plate ? coverKey(guides, ms) : "";
  if (plate && lastCover && lastCover.guides === guides && lastCover.plate === plate && lastCover.W === W && lastCover.H === H && lastCover.key === key) {
    if (lastCover.any) c.drawImage(s, 0, 0);
    return;
  }
  const mask = coverMask(W, H, guides, ms);
  if (plate) lastCover = { guides, plate, W, H, key, any: !!mask };
  if (!mask) return;
  const sc = s.getContext("2d")!;
  sc.globalCompositeOperation = "source-over";
  sc.clearRect(0, 0, W, H);
  if (plate) {
    sc.imageSmoothingQuality = "high";
    sc.drawImage(plate, 0, 0, W, H);
  } else {
    sc.filter = `blur(${Math.round(W / 25)}px)`;
    // Drawn larger than the canvas, so the blur pulls in colour from around the subject.
    sc.drawImage(video, -W * 0.05, -H * 0.05, W * 1.1, H * 1.1);
    sc.filter = "none";
    sc.fillStyle = "rgba(0,0,0,0.2)";
    sc.fillRect(0, 0, W, H);
  }
  sc.globalCompositeOperation = "destination-in";
  sc.imageSmoothingQuality = "high";
  sc.drawImage(mask, 0, 0, W, H);
  sc.globalCompositeOperation = "source-over";
  c.drawImage(s, 0, 0);
}

function seeked(v: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { v.removeEventListener("seeked", done); clearTimeout(t); resolve(); };
    const t = setTimeout(done, 1500);
    v.addEventListener("seeked", done);
  });
}

/**
 * The clip's set with nobody in it: about 24 frames across the stretch, and for each pixel the median of the
 * frames where no subject was over it (each subject's outline, grown). Pixels no frame saw are filled from the
 * set beside them (see fillFromSides). `scene` is as played; play time ms is media time ms * speed.
 * Null when the camera moves (the frames disagree away from the subjects) or the frames cannot be read.
 */
async function backgroundPlate(video: HTMLVideoElement, scene: Scene, speed: number, W: number, H: number): Promise<HTMLCanvasElement | null> {
  const w = 400, h = Math.max(1, Math.round((w * H) / W)), N = 24;
  const work = document.createElement("canvas");
  work.width = w; work.height = h;
  const wc = work.getContext("2d", { willReadFrequently: true })!;
  const shape = document.createElement("canvas");
  shape.width = w; shape.height = h;
  const shc = shape.getContext("2d", { willReadFrequently: true })!;
  const samples: Uint8ClampedArray[] = [], covered: Uint8Array[] = [];
  const wasPaused = video.paused;
  video.pause();
  try {
    for (let k = 0; k < N; k++) {
      const ms = ((k + 0.5) / N) * scene.durationMs;
      video.currentTime = (scene.startMs + ms * speed) / 1000;
      await seeked(video);
      wc.drawImage(video, 0, 0, w, h);
      samples.push(wc.getImageData(0, 0, w, h).data);
      // A wider margin than the cover's, so the subject's soft edge and shadow stay out of the plate.
      shc.clearRect(0, 0, w, h);
      paintSubjects(shc, w, h, scene.guides, ms, 0.04 * h);
      const a = shc.getImageData(0, 0, w, h).data, cov = new Uint8Array(w * h);
      for (let p = 0; p < w * h; p++) cov[p] = a[p * 4 + 3]! > 0 ? 1 : 0;
      covered.push(cov);
    }
  } catch {
    return null; // a clip from another site without CORS cannot be read back
  } finally {
    if (!wasPaused) void video.play().catch(() => {});
  }
  // A moving camera: frames next to each other differ a lot where nobody is.
  let diff = 0, n = 0;
  for (let k = 1; k < N; k++) {
    const a = samples[k - 1]!, b = samples[k]!;
    for (let p = 0; p < w * h; p += 7) {
      if (covered[k]![p] || covered[k - 1]![p]) continue;
      diff += Math.abs(a[p * 4]! - b[p * 4]!) + Math.abs(a[p * 4 + 1]! - b[p * 4 + 1]!) + Math.abs(a[p * 4 + 2]! - b[p * 4 + 2]!);
      n++;
    }
  }
  if (n === 0 || diff / n / 3 > 14) return null;
  const out = wc.createImageData(w, h);
  const known = new Uint8Array(w * h);
  const r: number[] = [], gr: number[] = [], bl: number[] = [];
  const med = (v: number[]) => { v.sort((x, y) => x - y); return v[v.length >> 1]!; };
  for (let p = 0; p < w * h; p++) {
    r.length = gr.length = bl.length = 0;
    for (let k = 0; k < N; k++) {
      if (covered[k]![p]) continue;
      const d = samples[k]!;
      r.push(d[p * 4]!); gr.push(d[p * 4 + 1]!); bl.push(d[p * 4 + 2]!);
    }
    if (r.length < 3) continue;
    out.data[p * 4] = med(r); out.data[p * 4 + 1] = med(gr); out.data[p * 4 + 2] = med(bl); out.data[p * 4 + 3] = 255;
    known[p] = 1;
  }
  fillFromSides(out.data, known, w, h);
  wc.putImageData(out, 0, 0);
  return work;
}

/**
 * Fills the pixels of an RGBA image that no frame saw. Each gap in a row is filled with the seen stretch of set on
 * either side of it mirrored in (and back again if the gap is wider than that stretch), the nearer side counting
 * more, so the floor, the fence or the horizon carry on through it with their own texture and no seam at either
 * edge. A gap with no seen pixels on either side gets a smooth guess from all around (fillHoles).
 */
function fillFromSides(px: Uint8ClampedArray, known: Uint8Array, w: number, h: number) {
  const smooth = px.slice();
  fillHoles(smooth, w, h);
  /** Distance d into the gap folded back and forth inside a seen stretch n pixels long. */
  const fold = (d: number, n: number) => { const m = d % (2 * n); return m < n ? m : 2 * n - 1 - m; };
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x0 = 0; x0 < w; x0++) {
      if (known[row + x0]) continue;
      let x1 = x0;
      while (x1 < w && !known[row + x1]) x1++;
      // The seen stretches either side: [a, x0) and [x1, b).
      let a = x0, b = x1;
      while (a > 0 && known[row + a - 1]) a--;
      while (b < w && known[row + b]) b++;
      const nl = x0 - a, nr = b - x1, L = x1 - x0;
      for (let x = x0; x < x1; x++) {
        const t = (x - x0 + 0.5) / L;
        const wl = nl > 0 ? 1 - t : 0, wr = nr > 0 ? t : 0;
        const l = x0 - 1 - fold(x - x0, Math.max(1, nl)), r = x1 + fold(x1 - 1 - x, Math.max(1, nr));
        const p = row + x;
        for (let k = 0; k < 3; k++) {
          px[p * 4 + k] = wl + wr > 0 ? (wl * px[(row + Math.max(0, l)) * 4 + k]! + wr * px[(row + Math.min(w - 1, r)) * 4 + k]!) / (wl + wr) : smooth[p * 4 + k]!;
        }
        px[p * 4 + 3] = 255;
      }
      x0 = x1;
    }
  }
}

/**
 * Fills the transparent pixels of an RGBA image smoothly from the pixels around them (pull-push: halve the
 * image until the holes close, then bring the colour back up), so a spot nobody ever uncovered gets a soft
 * guess at the set behind it instead of a hard-edged patch.
 */
function fillHoles(px: Uint8ClampedArray, w: number, h: number) {
  type Level = { w: number; h: number; c: Float32Array; a: Float32Array };
  const base: Level = { w, h, c: new Float32Array(w * h * 3), a: new Float32Array(w * h) };
  for (let p = 0; p < w * h; p++) {
    const a = px[p * 4 + 3]! / 255;
    base.a[p] = a;
    for (let k = 0; k < 3; k++) base.c[p * 3 + k] = px[p * 4 + k]! * a;
  }
  const levels = [base];
  while (levels.length < 12) {
    const f = levels[levels.length - 1]!;
    if (f.w <= 1 && f.h <= 1) break;
    const nw = Math.max(1, Math.ceil(f.w / 2)), nh = Math.max(1, Math.ceil(f.h / 2));
    const n: Level = { w: nw, h: nh, c: new Float32Array(nw * nh * 3), a: new Float32Array(nw * nh) };
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
      const q = (y >> 1) * nw + (x >> 1), p = y * f.w + x;
      n.a[q]! += f.a[p]!;
      for (let k = 0; k < 3; k++) n.c[q * 3 + k]! += f.c[p * 3 + k]!;
    }
    // Keep colour premultiplied, alpha capped at 1, so a coarse pixel with any known pixel under it counts fully.
    for (let q = 0; q < nw * nh; q++) {
      const a = n.a[q]!;
      if (a > 0) { const s = Math.min(1, a) / a; n.a[q] = Math.min(1, a); for (let k = 0; k < 3; k++) n.c[q * 3 + k]! *= s; }
    }
    levels.push(n);
  }
  for (let li = levels.length - 2; li >= 0; li--) {
    const f = levels[li]!, up = levels[li + 1]!;
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
      const p = y * f.w + x, a = f.a[p]!;
      if (a >= 1) continue;
      // Bilinear from the coarser level, mixed in where this level is not fully known.
      const fx = Math.min(up.w - 1, Math.max(0, (x - 0.5) / 2)), fy = Math.min(up.h - 1, Math.max(0, (y - 0.5) / 2));
      const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(up.w - 1, x0 + 1), y1 = Math.min(up.h - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
      const at = (xx: number, yy: number, k: number) => { const q = yy * up.w + xx, ua = up.a[q]!; return ua > 0 ? up.c[q * 3 + k]! / ua : 0; };
      for (let k = 0; k < 3; k++) {
        const v = (at(x0, y0, k) * (1 - tx) + at(x1, y0, k) * tx) * (1 - ty) + (at(x0, y1, k) * (1 - tx) + at(x1, y1, k) * tx) * ty;
        f.c[p * 3 + k] = f.c[p * 3 + k]! + v * (1 - a);
      }
      f.a[p] = 1;
    }
  }
  for (let p = 0; p < w * h; p++) {
    for (let k = 0; k < 3; k++) px[p * 4 + k] = base.c[p * 3 + k]!;
    px[p * 4 + 3] = 255;
  }
}

let cover: HTMLCanvasElement | null = null;
function coverCanvas(W: number, H: number): HTMLCanvasElement {
  cover ??= document.createElement("canvas");
  if (cover.width !== W || cover.height !== H) { cover.width = W; cover.height = H; }
  return cover;
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

/**
 * The role as drawn: every point shown, using the tracker's best guess where it was briefly unsure, except
 * joints it stays unsure of for a while (hideUnsureJoints), which are left out so limbs do not flicker at
 * guessed spots. Scoring keeps the real visibility.
 */
function fullFigure(g: Guide): Guide {
  if (!g.timeline || isThing(g)) return g;
  const shown = hideUnsureJoints(g.timeline);
  return {
    ...g,
    timeline: { ...shown, frames: shown.frames.map((f) => ({ ...f, landmarks: f.landmarks && f.landmarks.map(([x, y, v]) => [x, y, v === 0 ? 0 : Math.max(v, DRAWN_VISIBILITY)] as const) })) },
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

/** Two dancers side by side and no ball: everyone dances, so nobody is stuck being the ball. */
export function duoScene(): Scene {
  const starterAspect = 4 / 3;
  const forward = makeSequenceTimeline(DEMO_SEQUENCE, { idleDegrees: 2, aspect: starterAspect });
  const backward = makeSequenceTimeline([...DEMO_SEQUENCE].reverse(), { idleDegrees: 2, aspect: starterAspect });
  const durationMs = Math.floor(Math.min(forward[forward.length - 1].t, backward[backward.length - 1].t) * 1000);
  const dancer = (samples: typeof forward, centre: number) => (tMs: number) => {
    const s = sampleAt(samples, tMs / 1000);
    // 80% size, moved to `centre` of the wide frame; a uniform scale and shift keeps every limb angle.
    return s?.landmarks
      ? (s.landmarks as LandmarkObject[]).map((l) => [((l.x * starterAspect - starterAspect / 2) * 0.8 + centre * DEMO_ASPECT) / DEMO_ASPECT, 0.12 + 0.8 * l.y, l.visibility ?? 1] as const)
      : null;
  };
  return syntheticScene("Dance duo", durationMs, [
    { label: "the dancer on the left", poseAt: dancer(forward, 0.3) },
    { label: "the dancer on the right", poseAt: dancer(backward, 0.7) },
  ], []);
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
  // Normal mode: the whole clip in its own shape, the role drawn in place on it.
  const video = s.withClip ? scene.video : null;
  if (video) {
    fitCanvas(canvas, scene.width / scene.height);
    return { view: blindView(s.guide, canvas, "exact"), style: { background: "transparent", color: s.color }, video };
  }
  // A person fills whatever space the screen gives the role (half the stage while playing); a thing keeps
  // the clip's shape, so where it travels stays true.
  const shown = canvas.clientWidth > 0 && canvas.clientHeight > 0 ? canvas.clientWidth / canvas.clientHeight : 0;
  fitCanvas(canvas, !isThing(s.guide) && shown ? shown : scene.width / scene.height);
  return { view: blindView(s.guide, canvas, isThing(s.guide) ? "exact" : "fit"), style: { background: "#16161d", color: s.color }, video: null };
}

/** Normal mode: the clip's current frame on `canvas`, where the role's view puts the clip, a little dimmed so the role reads on top. */
function paintClip(canvas: HTMLCanvasElement, video: HTMLVideoElement, view: ReturnType<typeof roleView>, g: Guide) {
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#16161d";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (video.readyState < 2) return;
  const { scale, offsetX, offsetY } = view.view;
  ctx.save();
  ctx.globalAlpha = 0.8;
  ctx.drawImage(video, offsetX, offsetY, g.source.width * scale, g.source.height * scale);
  ctx.restore();
}

/** The role's first frame, the only thing the player sees of it before the turn. */
function drawFirstFrame(s: Seat, scene: Scene, ui: BlindUi) {
  const { guideCanvas } = ui.playStage();
  const shown = roleView(s, guideCanvas, scene);
  const { view, style, video } = shown;
  const g = s.guide;
  // The first frame where the subject is visible.
  const first = Math.max(0, g.boxTrack.frames.findIndex((f) => f.box !== null));
  const draw = () => {
    if (video) paintClip(guideCanvas, video, shown, g);
    drawBlind(guideCanvas, g, first, s.look, view, style);
  };
  draw();
  // Normal mode: show the clip at that moment under the role (only while nothing else is playing it).
  if (video && video.paused) {
    video.currentTime = (scene.startMs + (s.original.boxTrack.frames[first]?.tMs ?? 0)) / 1000;
    void seeked(video).then(() => { if (video.paused) draw(); });
  }
}

/**
 * Draws the role at play time `ms` on `canvas`, with a faint copy `leadMs` ahead so the next move shows
 * coming (it hides behind the role when nothing changes).
 */
function paintRole(canvas: HTMLCanvasElement, s: Seat, view: ReturnType<typeof roleView>, ms: number, leadMs: number, scratch: HTMLCanvasElement) {
  if (leadMs > 0) {
    scratch.width = canvas.width; scratch.height = canvas.height;
    drawBlind(scratch, guideAt(s.guide, ms + leadMs), 0, s.look, view.view, view.video ? { ...view.style, background: "#000" } : view.style);
  }
  if (view.video) paintClip(canvas, view.video, view, s.guide);
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
  // Styled by the look (.framing-hint in style.css): a paper tag at the bottom of the stage.
  hint.className = "framing-hint";
  hint.textContent = "Step into view so your whole body is in the picture.";
  host.appendChild(hint);
  stage.playerCanvas.style.opacity = "1"; // the camera is hidden until the countdown; bring it in so they can position themselves
  const calibrator = new Calibrator();
  await new Promise<void>((resolve) => {
    let finished = false;
    const done = () => { if (!finished) { finished = true; resolve(); } };
    const late = window.setTimeout(() => { hint.classList.add("late"); hint.onclick = done; hint.dataset.late = "1"; }, 12000);
    player.start((f) => {
      onFrame({ landmarks: f.landmarks as LandmarkObject[] | null, aspect: f.aspect });
      const r = calibrator.update(f.landmarks as never, 30);
      hint.textContent = r.passed ? "Got you." : r.message + (hint.dataset.late ? " Can't fit? Click here to start anyway." : "");
      if (r.passed) { clearTimeout(late); done(); }
    }, () => -1);
  });
  player.stop();
  hint.remove();
  stage.playerCanvas.style.opacity = "";
}

// ---- The clip's sound during a turn ----

/**
 * The clip's own sound for a turn or a preview, and the turn's clock taken from it, so sound and figure stay
 * together even if the clip stalls. The clip itself stays hidden. Play time ms (0 at the start of the stretch,
 * slowed to the game's speed) is (media ms - scene.startMs) / speed, the same mapping as slowScene. A scene
 * with no video (the drawn demos) stays silent and its clock is wall time.
 */
interface ClipSound {
  /** Pauses the clip and seeks it to the stretch's start, ready to play. Safe to call ahead of `play`. */
  ready(): Promise<void>;
  /** Starts the sound (muted if the browser refuses sound) and the clock. */
  play(): Promise<void>;
  /** Play time ms, or -1 before `play`. */
  now(): number;
  stop(): void;
}

/** The sound playing now, so a new one (or leaving) never leaves an old one running. */
let playingSound: ClipSound | null = null;

/** The clip's sound fades in over this long when a turn or preview starts, and out over this long when it ends, instead of cutting. */
const FADE_IN_MS = 150, FADE_OUT_MS = 400;
/** The fade running on each clip, so a new fade, a seek or a new sound cancels it. */
const fades = new WeakMap<HTMLVideoElement, () => void>();

/**
 * Moves the clip's volume to `to` over `ms`, then calls `done`. Anything that seeks the clip meanwhile (the
 * next turn, the reveal) cancels the fade and puts the volume back to full, so a fade never pauses or quiets
 * someone else's playback.
 */
function fadeVolume(video: HTMLVideoElement, to: number, ms: number, done?: () => void) {
  fades.get(video)?.();
  const from = video.volume, t0 = performance.now();
  const cancel = () => { clearInterval(timer); video.removeEventListener("seeking", interrupted); fades.delete(video); };
  const interrupted = () => { cancel(); video.volume = 1; };
  const timer = window.setInterval(() => {
    const u = Math.min(1, (performance.now() - t0) / ms);
    video.volume = from + (to - from) * u;
    if (u >= 1) { cancel(); done?.(); }
  }, 20);
  video.addEventListener("seeking", interrupted);
  fades.set(video, cancel);
}

function clipSound(scene: Scene, speed: number): ClipSound {
  playingSound?.stop();
  const video = scene.video;
  let started = -1, lastMs = 0, lastWall = 0, stopped = false;
  let seek: Promise<void> | null = null;
  const sound: ClipSound = {
    ready() {
      if (!video) return Promise.resolve();
      return seek ??= (async () => {
        fades.get(video)?.();
        video.pause();
        video.volume = 1;
        video.currentTime = scene.startMs / 1000;
        await seeked(video);
      })();
    },
    async play() {
      if (stopped) return;
      if (video) {
        await sound.ready();
        if (stopped) return;
        video.playbackRate = speed;
        video.preservesPitch = true;
        fades.get(video)?.();
        video.volume = 0;
        await playWithSound(video);
        if (stopped) { video.pause(); video.volume = 1; return; }
        fadeVolume(video, 1, FADE_IN_MS);
      }
      started = lastWall = performance.now();
      lastMs = 0;
    },
    now() {
      if (started < 0) return -1;
      const wall = performance.now();
      // The clip's own time while it plays; if it stops (refused, or the file ends early) wall time carries on.
      if (video && !video.paused) {
        lastMs = Math.max(0, (video.currentTime * 1000 - scene.startMs) / speed);
        lastWall = wall;
        return lastMs;
      }
      return lastMs + (wall - lastWall);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (video) {
        const settle = () => { video.pause(); video.playbackRate = 1; video.volume = 1; };
        // Still sounding: fade out, then pause. The turn's clock and frames have already ended.
        if (started >= 0 && !video.paused && !video.ended) fadeVolume(video, 0, FADE_OUT_MS, settle);
        else { fades.get(video)?.(); settle(); }
      }
      if (playingSound === sound) playingSound = null;
    },
  };
  playingSound = sound;
  return sound;
}

/**
 * Browsers allow sound only from a click: called inside the click that starts a turn, this lets the clip play
 * with sound after the countdown (play then pause at once, so nothing is heard now).
 */
function allowSound(video: HTMLVideoElement | null) {
  if (!video) return;
  try {
    video.muted = false;
    const p = video.play();
    video.pause();
    p?.catch(() => {});
  } catch { /* no sound allowed: the turn falls back to muted */ }
}

/** Collects the player's frames for one turn on `clock` (play time ms), until it reaches `durationMs`. */
function collectOnClock(durationMs: number, clock: () => number, player: Player, onLive: (clipMs: number, pose: LandmarkObject[] | null, aspect: number) => void): Promise<WebcamFrame[]> {
  return new Promise((resolve) => {
    const frames: WebcamFrame[] = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      player.stop();
      resolve(frames);
    };
    player.start((f) => {
      if (done) return;
      frames.push(f);
      onLive(f.clipTimeMs ?? -1, (f.landmarks as LandmarkObject[] | null) ?? null, f.aspect);
      if ((f.clipTimeMs ?? -1) >= durationMs) finish();
    }, clock);
    // The end is checked on a timer too, so the turn ends on time even if the camera stops sending frames.
    const timer = window.setInterval(() => { if (clock() >= durationMs) finish(); }, 50);
  });
}

/** Stops a preview still playing when the turn starts. */
let stopPreview: (() => void) | null = null;

/** Plays the role once on the stage with the clip's sound, unscored, at the game's speed, then shows its first frame again. */
async function previewRole(s: Seat, scene: Scene, speed: number, ui: BlindUi, leadMs: number) {
  stopPreview?.();
  const { guideCanvas } = ui.playStage();
  const view = roleView(s, guideCanvas, scene);
  const scratch = document.createElement("canvas");
  const sound = clipSound(scene, speed);
  const finished = await new Promise<boolean>((resolve) => {
    let over = false;
    const end = (done: boolean) => {
      if (over) return;
      over = true;
      clearInterval(timer);
      sound.stop();
      if (stopPreview === stop) stopPreview = null;
      resolve(done);
    };
    const stop = () => end(false);
    stopPreview = stop;
    const timer = window.setInterval(() => {
      const ms = sound.now();
      paintRole(guideCanvas, s, view, Math.min(Math.max(0, ms), scene.durationMs), leadMs, scratch);
      if (ms >= scene.durationMs) end(true);
    }, 1000 / 30);
    void sound.play();
  });
  if (finished) drawFirstFrame(s, scene, ui);
}

async function playTurn(s: Seat, scene: Scene, speed: number, deps: BlindDeps, ui: BlindUi, leadMs: number): Promise<void> {
  stopPreview?.();
  // Still inside the Start click: allow the clip's sound now, and seek it to the start during the countdown.
  allowSound(scene.video);
  const sound = clipSound(scene, speed);
  void sound.ready();
  try { await turn(s, scene, speed, deps, ui, leadMs, sound); }
  finally { sound.stop(); }
}

async function turn(s: Seat, scene: Scene, speed: number, deps: BlindDeps, ui: BlindUi, leadMs: number, sound: ClipSound): Promise<void> {
  // A refused camera can hand the turn to the simulated player: the look's camera card turns simMode on, then rejects.
  const player = deps.simMode() ? simulatedFor(s, scene, deps) : await deps.getCamera().catch((err: unknown) => { if (deps.simMode()) return simulatedFor(s, scene, deps); throw err; });
  const g = s.guide;
  const stage = ui.playStage();
  const view = roleView(s, stage.guideCanvas, scene);
  const scratch = document.createElement("canvas");
  let clipMs = -1;
  let pose: LandmarkObject[] | null = null, aspect = 4 / 3;
  // The shape to copy follows how big you look: closer to the camera makes it bigger, further makes it smaller.
  const matcher = new SizeMatcher();
  // In Normal mode the role stays in its place on the clip.
  const sizeToPlayer = !followsBox(s) && !isThing(g) && !view.video;
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
    // The clip's clock right now, so the figure moves with the sound between camera frames.
    paintRole(stage.guideCanvas, s, sizedView(), clipMs >= 0 ? Math.min(scene.durationMs, sound.now()) : 0, clipMs >= 0 ? leadMs : 0, scratch);
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
    if (image) { s.cutouts.push({ clipMs: f.clipMs, image, anchor: cutAnchor(f.landmarks, s.part, f.width / f.height) }); lastCut = f.clipMs; }
  });
  // The look may offer a restart while the moves count; it ends this turn at once and plays nothing back.
  let restart: () => void = () => {};
  const restarted = new Promise<"restart">((resolve) => { restart = () => resolve("restart"); });
  ui.turnStarted?.(restart);
  // The clip's sound starts after the countdown and its time is the turn's clock (frames, cutouts and scoring).
  await sound.play();
  const frames = await Promise.race([
    collectOnClock(scene.durationMs, () => sound.now(), player, (ms, p, a) => { clipMs = ms; pose = p; aspect = a; }),
    restarted,
  ]);
  sound.stop();
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
  // A person's box may be copied either way round (mirror or same side); a thing stepping the wrong way stays low.
  const r = followsBox(s) || !o.timeline
    ? scoreTrajectoryRound(o.boxTrack, playerTimeline, { bodyPart: s.part, eitherSide: !isThing(s.guide) })
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
      video.pause();
      const seeked = new Promise((r) => { video.addEventListener("seeked", r, { once: true }); setTimeout(r, 1500); });
      video.currentTime = fromMs / 1000;
      await seeked;
      await playWithSound(video);
    },
    now: () => video.currentTime * 1000 - fromMs,
    stop: () => { video.pause(); video.playbackRate = 1; },
    setSpeed: (speed) => { video.playbackRate = Math.min(16, Math.max(0.25, speed)); },
  };
}

/** A clock that first waits for `ready` (the recorder is paused meanwhile). */
function afterReady(clock: SegmentClock, ready: Promise<unknown>): SegmentClock {
  return { ...clock, start: async () => { await ready; await clock.start(); } };
}

/** How the recorded reveal looks. The look sets it per game through `GameOptions.theme`. */
export interface RevealTheme { card: string; ink: string; soft: string; accent: string; font: string; title: string; glow: number }
export const REVEAL_THEME: RevealTheme = { card: "#16161d", ink: "#f2f2f5", soft: "#a0a3b1", accent: "#f5c542", font: "system-ui, -apple-system, sans-serif", title: "Blind mode", glow: 12 };
let theme: RevealTheme = { ...REVEAL_THEME };
const font = (H: number, k: number, weight = 600) => `${weight} ${Math.round(H * k)}px ${theme.font}`;

/** The opening card. Every line is held to the card's width (fillText's last argument): a tall clip makes a narrow card. */
function drawTitle(ctx: CanvasRenderingContext2D, W: number, H: number, sceneName: string, players: number, ms: number) {
  ctx.fillStyle = theme.card; ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = Math.min(1, ms / 400);
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = theme.accent; ctx.font = font(H, 0.12, 800); ctx.fillText(theme.title, W / 2, H * 0.4, W * 0.9);
  ctx.fillStyle = theme.ink; ctx.font = font(H, 0.05); ctx.fillText(`${players} players. Nobody knew who they were playing.`, W / 2, H * 0.56, W * 0.9);
  ctx.fillStyle = theme.soft; ctx.font = font(H, 0.04, 400); ctx.fillText(sceneName, W / 2, H * 0.66, W * 0.9);
  ctx.globalAlpha = 1;
}

/** The closing card: who played what, how well, and who won. Each player's picture is their own cutout. */
function drawCastCard(ctx: CanvasRenderingContext2D, W: number, H: number, rows: ResultRow[], faces: (HTMLCanvasElement | null)[], ms: number) {
  ctx.fillStyle = theme.card; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = "middle";
  ctx.textAlign = "center"; ctx.fillStyle = theme.accent; ctx.font = font(H, 0.08, 800); ctx.fillText("The cast", W / 2, H * 0.13, W * 0.9);
  const rowH = Math.min(H * 0.17, (H * 0.78) / Math.max(1, rows.length));
  rows.forEach((r, i) => {
    // Rows slide in one after another; the first is there at once, so the card never shows only its title.
    const t = castRowShare(ms, i);
    if (t <= 0) return;
    const y = H * 0.25 + i * rowH + rowH / 2;
    ctx.globalAlpha = t;
    const x0 = W * 0.08 + (1 - t) * W * 0.05, face = rowH * 0.85;
    ctx.fillStyle = "#23232d"; ctx.fillRect(x0, y - face / 2, face, face);
    const img = faces[i];
    if (img) ctx.drawImage(img, x0, y - face / 2, face, face);
    ctx.strokeStyle = r.color; ctx.lineWidth = 3; ctx.strokeRect(x0, y - face / 2, face, face);
    ctx.textAlign = "left";
    ctx.fillStyle = r.color; ctx.font = font(H, 0.05, 700); ctx.fillText(r.name, x0 + face + W * 0.025, y - rowH * 0.15, W * 0.92 - (x0 + face + W * 0.025) - W * 0.14);
    ctx.fillStyle = theme.ink; ctx.font = font(H, 0.038, 400); ctx.fillText(`as ${r.role}`, x0 + face + W * 0.025, y + rowH * 0.2, W * 0.92 - (x0 + face + W * 0.025) - W * 0.14);
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
  // Players who drew the same role stand on it together, each nudged a little aside so both stay visible. The
  // step is small (0.4 of a body): at 1.3 each player landed beside the person they were copying, not on them.
  const shiftOf = (s: Seat) => {
    const same = seats.filter((o) => o.guide === s.guide);
    const k = same.indexOf(s);
    return same.length < 2 ? 0 : (k - (same.length - 1) / 2) * 0.4;
  };
  return seats.map((s) => ({
    cutouts: s.cutouts, lagMs: (s.result?.lagMs ?? 0) / speed, timeScale: 1 / speed, kind: followsBox(s) ? "thing" : "person",
    boxAt: (ms: number) => boxAt(s.guide, toPlay(ms)), spread: shiftOf(s),
    torsoAt: followsBox(s) ? undefined : (ms: number) => torsoAt(s.guide, toPlay(ms)),
    color: s.color, tag: `${s.name} ${s.result?.score ?? "-"}`, glow: theme.glow, tagFont: theme.font,
  }));
}

async function recordGroupReveal(seats: Seat[], rows: ResultRow[], played: Scene, speed: number, canvas: HTMLCanvasElement, onProgress: (share: number) => void, control?: { speed: number }, aloud = true): Promise<string | null> {
  const scene = played;
  // Keep the longest side near 1280 px: a tall clip no longer becomes 960 x 1700, which blew each 256 px cutout up
  // about 7 times. Wide clips stay 960 wide.
  canvas.width = scene.width >= scene.height ? 960 : Math.round((1280 * scene.width) / scene.height);
  canvas.height = Math.round(canvas.width * (scene.height / scene.width));
  const W = canvas.width, H = canvas.height;
  const toPlay = (ms: number) => ms / speed;
  const layers = revealLayers(seats, speed);
  const video = scene.video;
  // A picture of the empty set, so the played subjects can be painted out cleanly (null for a moving camera).
  // It is worked out while the title card plays (the recorder is paused until it is ready, so no dead frames).
  let plate: HTMLCanvasElement | null = null;
  const platePromise: Promise<void> = video
    ? backgroundPlate(video, scene, speed, W, H).then(async (p) => { plate = p; video.currentTime = scene.startMs / 1000; await seeked(video); })
    : Promise.resolve();
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
    if (video) eraseSubjects(c, W, H, video, roles, toPlay(from + ms), plate);
  };
  // A label at the top centre, clear of the stage's valance, readable on any clip.
  const caption = (c: CanvasRenderingContext2D, text: string, color: string) => {
    c.save();
    c.font = font(H, 0.065, 800); c.textAlign = "center"; c.textBaseline = "top";
    c.lineJoin = "round"; c.lineWidth = Math.max(4, H / 90); c.strokeStyle = "rgba(0,0,0,0.75)"; c.strokeText(text, W / 2, H * 0.1);
    c.fillStyle = color; c.fillText(text, W / 2, H * 0.1);
    c.restore();
  };
  // Each player's picture on the cast card: their face, the same picture the crowning jesters wear, so it always
  // shows who they are; a cutout from the middle of their turn only when no face was caught (a crop there can
  // miss the head).
  const faces = seats.map((s) => s.face ?? s.cutouts[Math.floor(s.cutouts.length / 2)]?.image ?? null);
  const segments: Segment[] = [
    { durationMs: 2200, draw: (c, ms) => drawTitle(c, W, H, scene.name, seats.length, ms) },
    {
      // The clip as it was, so everyone sees what they were copying.
      durationMs: realMs, clock: video ? afterReady(videoClock(video, scene.startMs), platePromise) : undefined,
      draw: (c, ms) => { background(0)(c, ms); caption(c, "The original", "#ffffff"); },
    },
    {
      // The same clip with each player standing in for the subject they played.
      durationMs: realMs, clock: video ? videoClock(video, scene.startMs) : undefined,
      draw: (c, ms) => { withoutSubjects(0)(c, ms); drawLayers(c, W, H, layers, ms); caption(c, "Your cast", theme.accent); },
    },
    { durationMs: 1200 + rows.length * 450 + 3000, draw: (c, ms) => drawCastCard(c, W, H, rows, faces, ms) },
  ];
  if (!video || aloud) return recordSegments(canvas, segments, onProgress, control, video);
  // Recorded with its sound, played without it here (setAloud), then the speakers come back for the next turn.
  setAloud(video, false);
  try { return await recordSegments(canvas, segments, onProgress, control, video); }
  finally { setAloud(video, true); }
}

// ---- The game ----

/** The player's recording with times moved from play time to the clip's media time. */
function mediaTimeline(s: Seat, scene: Scene, speed: number): ResultRow["timeline"] {
  const rec = s.recording as { aspect: number; frames: { t: number; landmarks: unknown[] }[] } | null;
  if (!rec) return null;
  return { ...rec, frames: rec.frames.map((f) => ({ ...f, t: scene.startMs + f.t * speed })) };
}

function roleOf(s: Seat, scene: Scene, speed: number, ui: BlindUi, leadMs: number): RoleInfo {
  return {
    look: s.look, text: roleText(),
    parts: Object.entries(BODY_PARTS).map(([key, p]) => ({ key: key as BodyPart, label: p.label.toLowerCase() })),
    preview: () => previewRole(s, scene, speed, ui, leadMs),
  };
}

/** Play one game: deal roles, one turn each on this laptop, then the reveal. Resolves with the results. */
export async function runBlindGame(clip: Scene, names: string[], ui: BlindUi, deps: BlindDeps, options: GameOptions = {}): Promise<ResultRow[]> {
  const speed = options.speed ?? 1, leadMs = options.leadMs ?? 0;
  // Tracking from a real video jitters and loses people; steady every person role once (scored as is) and
  // draw a copy with every limb shown, so the figure never cuts out.
  clip = { ...clip, guides: clip.guides.map(steadyRole) };
  const scene = slowScene({ ...clip, guides: clip.guides.map(fullFigure) }, speed);
  theme = { ...REVEAL_THEME, ...options.theme };
  const seats = deal(names, scene.guides, options.colors ?? PLAYER_COLORS);
  for (const s of seats) { s.original = clip.guides[scene.guides.indexOf(s.guide)]!; s.withClip = !!options.showClip; }
  (window as any).__jesterBlind = { seats, scene, speed };
  for (let i = 0; i < seats.length; i++) {
    const s = seats[i]!;
    await ui.handover(s, i > 0 ? seats[i - 1]! : null);
    let problem: string | undefined;
    for (;;) {
      drawFirstFrame(s, scene, ui);
      // A preview still playing stops when the player starts, or leaves.
      try { s.part = await ui.showPart(s, { ...roleOf(s, scene, speed, ui, leadMs), problem }); }
      finally { stopPreview?.(); }
      try { await playTurn(s, scene, speed, deps, ui, leadMs); break; }
      catch (err) {
        if (err instanceof RestartTurn) { problem = undefined; continue; }
        problem = "Camera did not start: " + (err as Error).message + ". Tick 'Simulated player' to try without one.";
      }
    }
  }
  await ui.beat?.();
  return finishGame(seats, scene, speed, ui, options);
}

/** The end of a game: scores, the results screen and the recorded reveal. */
async function finishGame(seats: Seat[], scene: Scene, speed: number, ui: BlindUi, options: GameOptions): Promise<ResultRow[]> {
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
    part: s.part,
    lagMs: s.result?.lagMs ?? 0,
  }));
  revealLayers(seats, speed).forEach((layer, i) => { rows[i]!.layer = layer; });
  ui.results(rows);
  if (options.reveal === false) return rows;
  if (ui.revealControl) ui.revealControl.speed = 1;
  const url = await recordGroupReveal(seats, rows, scene, speed, ui.revealCanvas(), (share) => ui.progress(share), ui.revealControl, options.revealAloud ?? true);
  (window as any).__jesterBlindReveal = url;
  ui.revealReady(url);
  return rows;
}

/** One player's finished turn, played on another device: what a room sends so every device can draw the same reveal. */
export interface RemoteResult {
  name: string;
  color: string;
  /** Which of the scene's roles they played. */
  guideIndex: number;
  part: BodyPart;
  score: number | null;
  tier: string | null;
  lagMs: number;
  /** Their pose recording in clip media ms (ResultRow.timeline); null if none. */
  timeline: { aspect: number; frames: { t: number; landmarks: unknown[] }[] } | null;
  /** Their real cutouts (play-time clipMs) and face, if they sent them; without cutouts a stick figure stands in. */
  cutouts?: Cutout[];
  face?: HTMLCanvasElement | null;
}

/**
 * The reveal and results for a game whose turns were played on several devices. Each remote player is drawn as
 * their own stick figure (their camera picture never leaves their device), placed on their role like a local
 * player's cutout, so the title card, the cast over the clip, the side by side and the cast card all work.
 */
export async function revealRemoteGame(clip: Scene, results: RemoteResult[], ui: BlindUi, options: GameOptions = {}): Promise<ResultRow[]> {
  const speed = options.speed ?? 1;
  const steady = { ...clip, guides: clip.guides.map(steadyRole) };
  const scene = slowScene({ ...steady, guides: steady.guides.map(fullFigure) }, speed);
  theme = { ...REVEAL_THEME, ...options.theme };
  const seats: Seat[] = results.map((r) => {
    const guide = scene.guides[r.guideIndex]!;
    const seat: Seat = {
      name: r.name, color: r.color, guide, original: steady.guides[r.guideIndex]!,
      look: isThing(guide) ? "outline" : "stick", part: r.part, cutouts: [], face: null,
      result: { score: r.score, tier: r.tier, lagMs: r.lagMs }, recording: null,
    };
    seat.face = r.face ?? null;
    if (r.cutouts && r.cutouts.length >= 3) { seat.cutouts = r.cutouts; return seat; } // their own pictures
    // No pictures sent: stick-figure cutouts from the recording, media ms back to play ms, about 15 a second.
    const aspect = r.timeline?.aspect || 4 / 3;
    let last = -Infinity;
    for (const f of r.timeline?.frames ?? []) {
      const clipMs = (f.t - scene.startMs) / speed;
      if (clipMs < 0 || clipMs - last < 60) continue;
      const image = cutFrame(null, Math.round(aspect * 1000), 1000, f.landmarks as LandmarkObject[], r.part, null);
      if (image) { seat.cutouts.push({ clipMs, image }); last = clipMs; }
    }
    return seat;
  });
  return finishGame(seats, scene, speed, ui, options);
}
