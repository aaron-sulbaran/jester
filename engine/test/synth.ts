// Synthetic bodies and boxes for tests. A stick figure is built from limb angles, so tests can
// make exact copies, mirrored copies, scaled copies, late copies and so on.

import type { BoxTrack, Landmark, PoseTimeline } from "../src/types.ts";

export interface Pose2D {
  /** Body center (hip midpoint) in normalized image coords. */
  cx: number;
  cy: number;
  /** Torso length in image-height units. */
  scale: number;
  /** Angles in degrees, 0 = pointing straight down, positive = toward the figure's own left (image right). */
  lUpper: number; lFore: number; rUpper: number; rFore: number;
  lThigh: number; lShin: number; rThigh: number; rShin: number;
}

export const STAND: Pose2D = {
  cx: 0.5, cy: 0.55, scale: 0.25,
  lUpper: 10, lFore: 5, rUpper: -10, rFore: -5,
  lThigh: 3, lShin: 0, rThigh: -3, rShin: 0,
};

const rad = (d: number) => (d * Math.PI) / 180;

/**
 * Build 33 landmarks. The figure faces the camera, so its anatomical left side is on the image right.
 * `aspect` is width / height of the image; x is divided by it so geometry is undistorted.
 */
export function landmarks(p: Pose2D, aspect = 1, visibility = 0.99): Landmark[] {
  const s = p.scale;
  const pts: [number, number][] = Array.from({ length: 33 }, () => [p.cx, p.cy]);
  const hipHalf = 0.18 * s, shoulderHalf = 0.25 * s;
  const set = (i: number, x: number, y: number) => { pts[i] = [x, y]; };
  const limb = (from: [number, number], angle: number, len: number): [number, number] =>
    [from[0] + Math.sin(rad(angle)) * len, from[1] + Math.cos(rad(angle)) * len];
  // Anatomical left = image right (+x).
  const lHip: [number, number] = [p.cx * aspect + hipHalf, p.cy];
  const rHip: [number, number] = [p.cx * aspect - hipHalf, p.cy];
  const lSh: [number, number] = [p.cx * aspect + shoulderHalf, p.cy - s];
  const rSh: [number, number] = [p.cx * aspect - shoulderHalf, p.cy - s];
  const lEl = limb(lSh, p.lUpper, 0.45 * s), lWr = limb(lEl, p.lFore, 0.4 * s);
  const rEl = limb(rSh, p.rUpper, 0.45 * s), rWr = limb(rEl, p.rFore, 0.4 * s);
  const lKn = limb(lHip, p.lThigh, 0.6 * s), lAn = limb(lKn, p.lShin, 0.55 * s);
  const rKn = limb(rHip, p.rThigh, 0.6 * s), rAn = limb(rKn, p.rShin, 0.55 * s);
  const nose: [number, number] = [p.cx * aspect, p.cy - 1.35 * s];
  const all: [number, [number, number]][] = [
    [0, nose], [11, lSh], [12, rSh], [13, lEl], [14, rEl], [15, lWr], [16, rWr],
    [23, lHip], [24, rHip], [25, lKn], [26, rKn], [27, lAn], [28, rAn],
  ];
  for (const [i, pt] of all) set(i, pt[0], pt[1]);
  // Face and hand/foot detail points sit near their parents.
  for (let i = 1; i <= 10; i++) set(i, nose[0], nose[1]);
  for (const [i, src] of [[17, lWr], [19, lWr], [21, lWr], [29, lAn], [31, lAn]] as const) set(i, src[0], src[1]);
  for (const [i, src] of [[18, rWr], [20, rWr], [22, rWr], [30, rAn], [32, rAn]] as const) set(i, src[0], src[1]);
  return pts.map(([x, y]) => [x / aspect, y, visibility] as const);
}

/** A dance: arms wave and legs step, with a few held poses. `t` in seconds. */
export function dance(t: number): Pose2D {
  const w = 2 * Math.PI * 0.6;
  return {
    ...STAND,
    lUpper: 90 + 70 * Math.sin(w * t),
    lFore: 90 + 80 * Math.sin(w * t + 0.7),
    rUpper: -90 + 70 * Math.sin(w * t * 1.3 + 1),
    rFore: -90 + 80 * Math.sin(w * t * 1.3 + 1.9),
    lThigh: 3 + 25 * Math.max(0, Math.sin(w * t * 0.5)),
    lShin: 0 - 20 * Math.max(0, Math.sin(w * t * 0.5)),
    rThigh: -3 - 25 * Math.max(0, -Math.sin(w * t * 0.5)),
    rShin: 0 + 20 * Math.max(0, -Math.sin(w * t * 0.5)),
  };
}

/** The pose a player makes when copying `p` as a mirror image: their right does the performer's left. */
export function mirrorCopy(p: Pose2D): Pose2D {
  return {
    ...p,
    cx: 1 - p.cx,
    lUpper: -p.rUpper, lFore: -p.rFore, rUpper: -p.lUpper, rFore: -p.lFore,
    lThigh: -p.rThigh, lShin: -p.rShin, rThigh: -p.lThigh, rShin: -p.lShin,
  };
}

export interface TimelineOptions {
  durationS?: number;
  fps?: number;
  width?: number;
  height?: number;
  mirrored?: boolean;
  /** Shift the motion later by this many ms (a late player). */
  delayMs?: number;
  /** Add timestamp jitter in ms (deterministic pattern). */
  jitterMs?: number;
  /** Return null landmarks for frames where this is true. */
  drop?: (i: number) => boolean;
  transform?: (p: Pose2D) => Pose2D;
  visibility?: (i: number) => number;
}

export function timeline(motion: (t: number) => Pose2D, o: TimelineOptions = {}): PoseTimeline {
  const { durationS = 20, fps = 30, width = 1280, height = 720, mirrored = false, delayMs = 0, jitterMs = 0 } = o;
  const aspect = width / height;
  const frames = [];
  const count = Math.round(durationS * fps);
  for (let i = 0; i <= count; i++) {
    const tMs = (i * 1000) / fps + (jitterMs ? jitterMs * Math.sin(i * 12.9898) : 0);
    const p0 = motion(Math.max(0, tMs - delayMs) / 1000);
    const p = o.transform ? o.transform(p0) : p0;
    frames.push({ tMs: Math.max(0, tMs), landmarks: o.drop?.(i) ? null : landmarks(p, aspect, o.visibility?.(i) ?? 0.99) });
  }
  return { schema: "pose-timeline/1", source: { width, height, mirrored }, frames };
}

/** Sprite state over time: lane changes every 2.5 s, a jump and a duck every 3 s. */
export function spriteState(t: number): { lane: number; jump: number; duck: boolean } {
  const lane = (Math.floor(t / 2.5) % 3) - 1; // -1, 0, 1
  const phase = t % 3;
  const jump = phase > 1.0 && phase < 1.6 ? Math.sin(((phase - 1.0) / 0.6) * Math.PI) : 0; // 0..1
  const duck = phase > 2.1 && phase < 2.7;
  return { lane, jump, duck };
}

/** The sprite's box: 0.2 tall standing, 0.12 when ducking (feet stay down), jumps up to 0.15. */
export function spritePath(t: number): { cx: number; cy: number; w: number; h: number } {
  const s = spriteState(t);
  const h = s.duck ? 0.12 : 0.2;
  return { cx: 0.5 + 0.2 * s.lane, cy: 0.7 - h / 2 - 0.15 * s.jump, w: 0.08, h };
}

export function boxTrack(path: (t: number) => { cx: number; cy: number; w: number; h: number }, durationS = 24, fps = 30): BoxTrack {
  const frames = [];
  for (let i = 0; i <= Math.round(durationS * fps); i++) {
    const tMs = (i * 1000) / fps;
    frames.push({ tMs, box: path(tMs / 1000) });
  }
  return { schema: "box-track/1", source: { width: 1280, height: 720 }, frames };
}

/** A player copying the sprite on an unmirrored camera: steps sideways for lanes, jumps, crouches. */
export function playerCopyingSprite(t: number): Pose2D {
  const s = spriteState(t);
  const scale = STAND.scale;
  const bend = s.duck;
  // Bent legs: vertical leg extent shrinks from 1.15 to about 0.48 torso lengths; hips drop by the difference.
  const drop = bend ? 0.67 * scale : 0;
  return {
    ...STAND,
    // To move screen-right in a mirrored preview, the player moves image-left on the raw camera.
    cx: 0.5 - 0.12 * s.lane,
    cy: STAND.cy - 0.75 * scale * s.jump + drop,
    lThigh: bend ? 70 : 3, lShin: bend ? -60 : 0,
    rThigh: bend ? -70 : -3, rShin: bend ? 60 : 0,
  };
}
