// Trajectory channel: for subjects with no usable skeleton (cartoons, sprites, objects).
// The clip stage gives the subject's box per frame; the player gives a pose. We compare how
// the player's body moved with how the box moved: velocity correlation at one global lag, plus
// matched events (jump, crouch, move left or right). Pure functions only.

import { EVENTS, GRID_HZ, GRID_MS, LAG, SCORER_VERSION, TRAJECTORY } from "./constants.ts";
import { LM, MID, midpoint, torsoLength } from "./geometry.ts";
import { gridLength, resampleBoxes, resamplePoses } from "./resample.ts";
import { clamp01, tierFor, timingCredit } from "./scoring.ts";
import type { BoxTrack, EventMatch, EventType, MotionEvent, PoseTimeline, TrajectoryRoundResult } from "./types.ts";

type Signal = number[]; // NaN marks a missing sample

// ---------- small numeric helpers (deterministic, fixed loop order) ----------

function median(values: readonly number[]): number {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

function percentile(values: readonly number[], p: number): number {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return NaN;
  const idx = Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))));
  return v[idx]!;
}

/** Fill runs of NaN up to `maxGap` long by linear interpolation between their neighbors. */
export function bridgeGaps(s: Signal, maxGap: number): Signal {
  const out = s.slice();
  let i = 0;
  while (i < out.length) {
    if (Number.isFinite(out[i]!)) { i++; continue; }
    let j = i;
    while (j < out.length && !Number.isFinite(out[j]!)) j++;
    const gap = j - i;
    if (i > 0 && j < out.length && gap <= maxGap) {
      const a = out[i - 1]!, b = out[j]!;
      for (let k = i; k < j; k++) out[k] = a + ((b - a) * (k - i + 1)) / (gap + 1);
    }
    i = j;
  }
  return out;
}

/** Centered moving average; NaN where the center is missing, otherwise the mean of available samples. */
export function smooth(s: Signal, width: number): Signal {
  const h = width >> 1;
  return s.map((v, i) => {
    if (!Number.isFinite(v)) return NaN;
    let sum = 0, c = 0;
    for (let k = i - h; k <= i + h; k++) {
      const x = s[k];
      if (x !== undefined && Number.isFinite(x)) { sum += x; c++; }
    }
    return sum / c;
  });
}

/** Central-difference velocity in units per second. */
export function velocity(s: Signal): Signal {
  return s.map((_, i) => {
    const a = s[i - 1], b = s[i + 1];
    return a !== undefined && b !== undefined && Number.isFinite(a) && Number.isFinite(b) ? ((b - a) / 2) * GRID_HZ : NaN;
  });
}

function robustZ(v: Signal, floor: number): Signal {
  const med = median(v);
  const mad = median(v.map((x) => Math.abs(x - med)));
  const scale = Math.max(1.4826 * (Number.isFinite(mad) ? mad : 0), floor);
  return v.map((x) => (Number.isFinite(x) ? (x - med) / scale : NaN));
}

function variance(v: Signal): number {
  let s = 0, s2 = 0, c = 0;
  for (const x of v) if (Number.isFinite(x)) { s += x; s2 += x * x; c++; }
  if (c < 2) return 0;
  const m = s / c;
  return Math.max(0, s2 / c - m * m);
}

function rms(v: Signal): number {
  let s2 = 0, c = 0;
  for (const x of v) if (Number.isFinite(x)) { s2 += x * x; c++; }
  return c > 0 ? Math.sqrt(s2 / c) : 0;
}

function pearson(a: readonly number[], b: readonly number[]): number | null {
  const n = a.length;
  if (n < 3) return null;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]!; mb += b[i]!; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]! - ma, db = b[i]! - mb;
    sab += da * db; saa += da * da; sbb += db * db;
  }
  if (saa < 1e-12 || sbb < 1e-12) return 0;
  return sab / Math.sqrt(saa * sbb);
}

const atanhClamped = (r: number) => Math.atanh(Math.max(-0.999, Math.min(0.999, r)));

// ---------- signals ----------

export interface PlayerSignals {
  x: Signal; // torso lengths, screen-right positive (mirror applied)
  y: Signal; // torso lengths, up positive
  h: Signal; // body height ratio, 1 = standing
  validShare: number;
}

export function playerSignals(player: PoseTimeline, n: number, mirror: boolean, bodyPart: BodyPart = "body"): PlayerSignals {
  const aspect = player.source.width / player.source.height;
  const grid = resamplePoses(player.frames, n);
  const vis = (ids: readonly number[]) => grid.filter((l) => l && ids.every((i) => l[i]![2] >= 0.5)).length;
  // Pick one anchor for the whole round so it never jumps between hips and shoulders. A chosen body part
  // (a hand, the head, a foot) is its own anchor; the body's height then plays no part.
  const part = bodyPart === "body" ? null : BODY_PARTS[bodyPart].landmarks;
  const useHips = vis(MID.hip) >= 0.7 * Math.max(1, vis(MID.shoulder));
  const anchor = part ?? (useHips ? MID.hip : MID.shoulder);
  const useAnkles = !part && vis([LM.leftAnkle, LM.rightAnkle, LM.nose]) >= 0.7 * Math.max(1, vis(anchor));

  // Unit: torso length. A player at a desk often hides their hips, so fall back to shoulder width.
  const torso = grid.map((l) => (l ? torsoLength(l, aspect) ?? NaN : NaN));
  const shoulders = grid.map((l) => {
    if (!l || l[LM.leftShoulder]![2] < 0.5 || l[LM.rightShoulder]![2] < 0.5) return NaN;
    return Math.hypot((l[LM.leftShoulder]![0] - l[LM.rightShoulder]![0]) * aspect, l[LM.leftShoulder]![1] - l[LM.rightShoulder]![1]) * TRAJECTORY.torsoPerShoulderWidth;
  });
  const L = Number.isFinite(median(torso)) ? median(torso) : median(shoulders);
  const ax: Signal = [], ay: Signal = [], height: Signal = [];
  let valid = 0;
  for (const l of grid) {
    const ok = l && anchor.every((i) => l[i]![2] >= 0.5);
    if (!l || !ok) { ax.push(NaN); ay.push(NaN); height.push(NaN); continue; }
    valid++;
    const p = midpoint(l, anchor, aspect);
    ax.push(p.x); ay.push(p.y);
    if (useAnkles) {
      const feet = midpoint(l, [LM.leftAnkle, LM.rightAnkle], aspect);
      height.push(feet.y - l[LM.nose]![1]);
    } else {
      height.push(NaN);
    }
  }
  const sign = mirror && !player.source.mirrored ? -1 : 1;
  const x0 = median(ax), y0 = median(ay), h0 = median(height);
  const scale = Number.isFinite(L) && L > 0 ? L : 1;
  const x = ax.map((v) => (sign * (v - x0)) / scale);
  const y = ay.map((v) => -(v - y0) / scale);
  // Without ankles, a drop of the anchor stands in for crouching: 0.3 torso lengths down reads as 0.85.
  const h = part ? y.map(() => NaN)
    : useAnkles && Number.isFinite(h0) && h0 > 0 ? height.map((v) => v / h0) : y.map((v) => (Number.isFinite(v) ? 1 + Math.min(0, v) / 2 : NaN));
  const bridge = (s: Signal) => bridgeGaps(s, TRAJECTORY.maxBridgeFrames);
  return { x: bridge(x), y: bridge(y), h: bridge(h), validShare: n > 0 ? valid / n : 0 };
}

export interface ReferenceSignals {
  x: Signal; // box heights, screen-right positive
  y: Signal; // box heights, up positive
  h: Signal; // box height ratio, 1 = median height
  validShare: number;
}

export function referenceSignals(track: BoxTrack, n: number): ReferenceSignals {
  const aspect = track.source.width / track.source.height;
  const boxes = resampleBoxes(track.frames, n, track.scrollX);
  const H = median(boxes.map((b) => (b ? b.h : NaN)));
  const cx = boxes.map((b) => (b ? b.cx * aspect : NaN));
  const cy = boxes.map((b) => (b ? b.cy : NaN));
  // A small object (a ball) crossing the frame would be dozens of its own heights; floor the unit so its
  // motion stays on the scale a person can match with their body.
  const scale = Math.max(Number.isFinite(H) && H > 0 ? H : 1, TRAJECTORY.minReferenceUnit);
  const x0 = median(cx), y0 = median(cy);
  const bridge = (s: Signal) => bridgeGaps(s, TRAJECTORY.maxBridgeFrames);
  return {
    x: bridge(cx.map((v) => (v - x0) / scale)),
    y: bridge(cy.map((v) => -(v - y0) / scale)),
    // Height ratio stays relative to the box's own usual height (a duck is the box getting shorter).
    h: bridge(boxes.map((b) => (b ? b.h / (Number.isFinite(H) && H > 0 ? H : 1) : NaN))),
    validShare: n > 0 ? boxes.filter((b) => b).length / n : 0,
  };
}

// ---------- continuous part: lagged windowed correlation ----------

interface Axis { ref: Signal; player: Signal; weight: number }

function windowedFisher(ref: Signal, player: Signal, lag: number, n: number): number | null {
  const W = Math.min(TRAJECTORY.windowFrames, n);
  const step = TRAJECTORY.windowStepFrames;
  let zsum = 0, count = 0;
  for (let s = 0; s + W <= n; s += step) {
    const a: number[] = [], b: number[] = [];
    for (let i = s; i < s + W; i++) {
      const j = i - lag;
      if (j < 0 || j >= n) continue;
      const p = player[i]!, r = ref[j]!;
      if (Number.isFinite(p) && Number.isFinite(r)) { a.push(p); b.push(r); }
    }
    if (a.length < 0.6 * W) continue;
    const r = pearson(a, b);
    if (r === null) continue;
    zsum += atanhClamped(r);
    count++;
  }
  return count > 0 ? zsum / count : null;
}

function combinedZ(axes: readonly Axis[], lag: number, n: number, playerOverride?: readonly Signal[]): number | null {
  let z = 0, w = 0;
  axes.forEach((ax, k) => {
    const fz = windowedFisher(ax.ref, playerOverride ? playerOverride[k]! : ax.player, lag, n);
    if (fz === null) return;
    z += ax.weight * fz;
    w += ax.weight;
  });
  return w > 0 ? z / w : null;
}

function bestLag(score: (lag: number) => number | null): { lag: number; value: number } | null {
  const minLag = Math.round(LAG.minMs / GRID_MS), maxLag = Math.round(LAG.maxMs / GRID_MS);
  let best: { lag: number; value: number } | null = null;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const v = score(lag);
    if (v === null) continue;
    if (
      !best || v > best.value + 1e-12 ||
      (Math.abs(v - best.value) <= 1e-12 && (Math.abs(lag) < Math.abs(best.lag) || (Math.abs(lag) === Math.abs(best.lag) && lag < best.lag)))
    ) best = { lag, value: v };
  }
  return best;
}

function circularShift(s: Signal, k: number): Signal {
  const n = s.length;
  return s.map((_, i) => s[(i - k + n) % n]!);
}

// ---------- events ----------

function msToFrames(ms: number): number {
  return Math.round(ms / GRID_MS);
}

export interface EventThresholds {
  jumpStart: number;
  jumpMinApex: number;
  crouchEnter: number;
  crouchExit: number;
  moveMin: number;
}

export const PLAYER_THRESHOLDS: EventThresholds = {
  jumpStart: EVENTS.playerJumpStart, jumpMinApex: EVENTS.playerJumpMinApex,
  crouchEnter: EVENTS.playerCrouchEnter, crouchExit: EVENTS.playerCrouchExit, moveMin: EVENTS.playerMoveMin,
};
export const REFERENCE_THRESHOLDS: EventThresholds = {
  jumpStart: EVENTS.refJumpStart, jumpMinApex: EVENTS.refJumpMinApex,
  crouchEnter: EVENTS.refCrouchEnter, crouchExit: EVENTS.refCrouchExit, moveMin: EVENTS.refMoveMin,
};

/** Detect jumps, crouches and left/right moves in body-unit signals (smoothed inside). */
export function detectEvents(sig: { x: Signal; y: Signal; h: Signal }, t: EventThresholds): MotionEvent[] {
  const x = smooth(sig.x, TRAJECTORY.smoothFrames);
  const y = smooth(sig.y, TRAJECTORY.smoothFrames);
  const h = smooth(sig.h, TRAJECTORY.smoothFrames);
  const vx = velocity(x), vy = velocity(y);
  const events: MotionEvent[] = [];
  const n = y.length;

  // Jumps: an up-then-down excursion. Turning points come from a zigzag with a minimum swing, so the
  // shape decides, not a ground level (a ball is mostly in the air; a player who also ducks has two floors).
  // A jump is a high point at least jumpMinApex above the low before it, falling back at least half that,
  // with the two lows within the allowed duration and a fast enough rise.
  const turns: { i: number; high: boolean }[] = [];
  {
    const swing = t.jumpMinApex * 0.5;
    let dir = 0, ext = -1, lo = -1, hi = -1;
    for (let i = 0; i < n; i++) {
      const yi = y[i]!;
      if (!Number.isFinite(yi)) { dir = 0; ext = lo = hi = -1; continue; }
      if (lo < 0) { lo = hi = ext = i; continue; }
      if (dir === 0) {
        if (yi > y[hi]!) hi = i;
        if (yi < y[lo]!) lo = i;
        if (y[hi]! - yi >= swing) { turns.push({ i: hi, high: true }); dir = -1; ext = i; }
        else if (yi - y[lo]! >= swing) { turns.push({ i: lo, high: false }); dir = 1; ext = i; }
      } else if (dir === 1) {
        if (yi > y[ext]!) ext = i;
        else if (y[ext]! - yi >= swing) { turns.push({ i: ext, high: true }); dir = -1; ext = i; }
      } else {
        if (yi < y[ext]!) ext = i;
        else if (yi - y[ext]! >= swing) { turns.push({ i: ext, high: false }); dir = 1; ext = i; }
      }
    }
    if (dir !== 0) turns.push({ i: ext, high: dir === 1 });
  }
  for (let k = 1; k + 1 < turns.length; k++) {
    const a = turns[k - 1]!, m = turns[k]!, b = turns[k + 1]!;
    if (!m.high || a.high || b.high) continue;
    const base = Math.max(y[a.i]!, y[b.i]!);
    const rise = y[m.i]! - base;
    if (rise < t.jumpMinApex) continue;
    // Air time: how long the excursion stays in its upper half around the apex. Lows on either side can be
    // far away (a player who ducks between jumps), so they do not set the duration.
    const half = y[m.i]! - 0.5 * rise;
    let s0 = m.i, s1 = m.i;
    while (s0 > a.i && y[s0 - 1]! >= half) s0--;
    while (s1 < b.i && y[s1 + 1]! >= half) s1++;
    const dur = (s1 - s0 + 1) * GRID_MS;
    if (dur < EVENTS.jumpMinMs / 2 || dur > EVENTS.jumpMaxMs) continue;
    let vmax = 0;
    for (let i = a.i; i <= m.i; i++) if (Number.isFinite(vy[i]!) && vy[i]! > vmax) vmax = vy[i]!;
    if (vmax >= EVENTS.jumpStartSpeed) events.push({ type: "jump", frame: m.i });
  }

  // Crouches: hysteresis on the height ratio.
  for (let i = 0; i < n; i++) {
    const hi = h[i]!;
    if (!Number.isFinite(hi) || hi >= t.crouchEnter) continue;
    let j = i;
    while (j < n && Number.isFinite(h[j]!) && h[j]! < t.crouchExit) j++;
    if ((j - i) * GRID_MS >= EVENTS.crouchMinMs) events.push({ type: "crouch", frame: i });
    i = j;
  }

  // Moves: runs of same-sign horizontal speed above the deadband that cover enough distance.
  let i = 0;
  while (i < n) {
    const v = vx[i]!;
    if (!Number.isFinite(v) || Math.abs(v) <= EVENTS.moveDeadband) { i++; continue; }
    const sign = Math.sign(v);
    let j = i, peak = i;
    while (j < n && Number.isFinite(vx[j]!) && Math.sign(vx[j]!) === sign && Math.abs(vx[j]!) > EVENTS.moveDeadband) {
      if (Math.abs(vx[j]!) > Math.abs(vx[peak]!)) peak = j;
      j++;
    }
    const startX = x[Math.max(0, i - 1)]!, endX = x[Math.min(n - 1, j)]!;
    const disp = endX - startX;
    if (Number.isFinite(disp) && Math.abs(disp) >= t.moveMin && (j - i) * GRID_MS >= EVENTS.moveMinMs) {
      // Timed at the start of the move: a long steady move (a car) has no clear peak to line up.
      events.push({ type: disp > 0 ? "moveRight" : "moveLeft", frame: i });
    }
    i = j;
  }

  // Merge same-type events closer than the refractory period, then sort by time and type.
  const order: Record<EventType, number> = { jump: 0, crouch: 1, moveLeft: 2, moveRight: 3 };
  events.sort((a, b) => a.frame - b.frame || order[a.type] - order[b.type]);
  const refractory = msToFrames(TRAJECTORY.refractoryMs);
  const lastByType = new Map<EventType, number>();
  return events.filter((e) => {
    const last = lastByType.get(e.type);
    if (last !== undefined && e.frame - last < refractory) return false;
    lastByType.set(e.type, e.frame);
    return true;
  });
}

/** Match reference events to player events at a lag, closest pairs first. Deterministic. */
export function matchEvents(ref: readonly MotionEvent[], player: readonly MotionEvent[], lag: number) {
  const window = TRAJECTORY.matchWindowMs;
  const pairs: { r: number; p: number; dt: number }[] = [];
  ref.forEach((re, r) => player.forEach((pe, p) => {
    if (re.type !== pe.type) return;
    const dt = (pe.frame - (re.frame + lag)) * GRID_MS;
    if (Math.abs(dt) <= window) pairs.push({ r, p, dt });
  }));
  pairs.sort((a, b) => Math.abs(a.dt) - Math.abs(b.dt) || a.r - b.r || a.p - b.p);
  const usedR = new Set<number>(), usedP = new Set<number>();
  const matched = new Map<number, { p: number; dt: number }>();
  for (const pr of pairs) {
    if (usedR.has(pr.r) || usedP.has(pr.p)) continue;
    usedR.add(pr.r); usedP.add(pr.p);
    matched.set(pr.r, { p: pr.p, dt: pr.dt });
  }
  let creditSum = 0;
  const matches: EventMatch[] = ref.map((re, r) => {
    const m = matched.get(r);
    if (!m) return { type: re.type, refFrame: re.frame, playerFrame: null, dtMs: null, credit: 0 };
    const credit = 1 - 0.5 * (m.dt / window) ** 2;
    creditSum += credit;
    return { type: re.type, refFrame: re.frame, playerFrame: player[m.p]!.frame, dtMs: Math.round(m.dt), credit };
  });
  const extras = player.filter((_, p) => !usedP.has(p));
  const total = ref.length + player.length;
  const f1 = ref.length > 0 ? (total > 0 ? (2 * creditSum) / total : 0) : null;
  return { matches, extras, f1 };
}

// ---------- round ----------

/**
 * What plays the object. "body" is the whole body (hips, or shoulders when hips are hidden). The others
 * follow one body part; sides are the player's own (MediaPipe's left and right are the person's).
 * `reach`: how far that part can travel to mirror the object's full range, in torso lengths.
 */
export const BODY_PARTS = {
  body: { label: "Whole body", landmarks: MID.hip, reach: 1.5 },
  rightHand: { label: "Right hand", landmarks: [LM.rightWrist, 18, 20], reach: 2.5 },
  leftHand: { label: "Left hand", landmarks: [LM.leftWrist, 17, 19], reach: 2.5 },
  head: { label: "Head", landmarks: [LM.nose], reach: 1.2 },
  rightFoot: { label: "Right foot", landmarks: [LM.rightAnkle, 30, 32], reach: 1.5 },
  leftFoot: { label: "Left foot", landmarks: [LM.leftAnkle, 29, 31], reach: 1.5 },
} as const satisfies Record<string, { label: string; landmarks: readonly number[]; reach: number }>;
export type BodyPart = keyof typeof BODY_PARTS;

export interface TrajectoryRoundOptions {
  mirror?: boolean;
  /** Which part of the player plays the object (default the whole body). */
  bodyPart?: BodyPart;
}

/**
 * The player's x and y scaled up so their range (5th to 95th percentile) matches the reference's, by at most
 * `partEventMaxScale`. An axis that hardly moves (under `partEventMinRange` torso lengths) is left alone, so a
 * still hand's jitter never turns into bounces. Never scaled down.
 */
export function scaledTowardReference(ply: { x: Signal; y: Signal; h: Signal }, ref: { x: Signal; y: Signal }): { x: Signal; y: Signal; h: Signal } {
  const range = (s: Signal) => percentile(s, 0.95) - percentile(s, 0.05);
  const scale = (p: Signal, r: Signal): Signal => {
    const pr = range(p), rr = range(r);
    if (!(pr >= TRAJECTORY.partEventMinRange) || !(rr > pr)) return p;
    const k = Math.min(rr / pr, TRAJECTORY.partEventMaxScale);
    return p.map((v) => v * k);
  };
  return { x: scale(ply.x, ref.x), y: scale(ply.y, ref.y), h: ply.h };
}

export function scoreTrajectoryRound(reference: BoxTrack, player: PoseTimeline, options: TrajectoryRoundOptions = {}): TrajectoryRoundResult {
  const lastRef = reference.frames.reduce((m, f) => (Number.isFinite(f.tMs) && f.tMs > m ? f.tMs : m), -1);
  const n = gridLength(lastRef);
  const ref = referenceSignals(reference, n);
  const bodyPart = options.bodyPart ?? "body";
  const ply = playerSignals(player, n, options.mirror ?? true, bodyPart);

  const base = {
    channel: "trajectory" as const, scorerVersion: SCORER_VERSION, lagMs: 0, timing: 0,
    continuous: null, correlation: null, chanceCorrelation: null, activity: 0, eventF1: null,
    matches: [] as EventMatch[], extraPlayerEvents: [] as MotionEvent[], axes: { x: false, y: false, h: false },
  };
  if (n === 0 || ply.validShare < 1 - 0.3) return { ...base, score: null, tier: null, failure: "low-tracking" };

  // Velocities in body units per second.
  const sm = (s: Signal) => smooth(s, TRAJECTORY.smoothFrames);
  const refV = { x: velocity(sm(ref.x)), y: velocity(sm(ref.y)), h: velocity(sm(ref.h)) };
  const plyV = { x: velocity(sm(ply.x)), y: velocity(sm(ply.y)), h: velocity(sm(ply.h)) };

  // Which reference axes actually move?
  const range = (s: Signal) => percentile(s, 0.95) - percentile(s, 0.05);
  const axes = {
    x: range(ref.x) >= TRAJECTORY.minRangeX,
    y: range(ref.y) >= TRAJECTORY.minRangeY,
    // A body part cannot get shorter like a ducking object; only the whole body copies height changes.
    h: bodyPart === "body" && range(ref.h) >= TRAJECTORY.minRangeY,
  };
  const axisList: Axis[] = [];
  const keys = (["x", "y", "h"] as const).filter((k) => axes[k]);
  const varTotal = keys.reduce((s, k) => s + variance(refV[k]), 0);
  for (const k of keys) {
    axisList.push({
      ref: robustZ(refV[k], TRAJECTORY.velocityFloor),
      player: robustZ(plyV[k], TRAJECTORY.velocityFloor),
      weight: varTotal > 0 ? variance(refV[k]) / varTotal : 1 / keys.length,
    });
  }

  // Events on both sides.
  const refEvents = detectEvents(ref, REFERENCE_THRESHOLDS).filter((e) => bodyPart === "body" || e.type !== "crouch");
  // 0.8.0: a body part copies an object at its own size (a hand dribbling at a desk moves far less than the
  // ball). Size is scored by activity; events only ask whether each beat was hit. So for a part, the player's
  // path is scaled up toward the object's range before looking for jumps and moves.
  const plyEvents = detectEvents(bodyPart === "body" ? ply : scaledTowardReference(ply, ref), PLAYER_THRESHOLDS);

  if (axisList.length === 0 && refEvents.length === 0) return { ...base, axes, score: null, tier: null, failure: "nothing-to-mimic" };

  // Global lag: from correlation when there is continuous motion, otherwise from events.
  let lag = 0;
  let correlation: number | null = null, chance: number | null = null, continuous: number | null = null;
  if (axisList.length > 0) {
    const found = bestLag((l) => combinedZ(axisList, l, n));
    if (found) {
      lag = found.lag;
      correlation = Math.tanh(found.value);
      // Chance baseline: the same best-lag search on fixed circular shifts of the player.
      let rsum = 0, rc = 0;
      for (let k = 1; k <= TRAJECTORY.surrogateCount; k++) {
        const shift = Math.round((k * n) / (TRAJECTORY.surrogateCount + 1));
        if (shift < TRAJECTORY.minSurrogateShiftFrames || n - shift < TRAJECTORY.minSurrogateShiftFrames) continue;
        // Score the shifted player at the lag already found (plus the usual slack). Searching lags again
        // would let any rhythmic motion (a ball, a pendulum) line back up and look like a real copy.
        const shifted = axisList.map((a) => circularShift(a.player, shift));
        let bestZ: number | null = null;
        for (let d = -LAG.slackFrames; d <= LAG.slackFrames; d++) {
          const z = combinedZ(axisList, lag + d, n, shifted);
          if (z !== null && (bestZ === null || z > bestZ)) bestZ = z;
        }
        if (bestZ !== null) { rsum += Math.tanh(bestZ); rc++; }
      }
      chance = rc > 0 ? rsum / rc : 0;
      const denom = TRAJECTORY.goodCorrelation - chance;
      continuous = denom > 1e-9 ? clamp01((correlation - chance) / denom) : correlation >= TRAJECTORY.goodCorrelation ? 1 : 0;
    }
  } else {
    const found = bestLag((l) => matchEvents(refEvents, plyEvents, l).f1);
    if (found) lag = found.lag;
  }

  // Activity: a player who barely moves earns no continuous credit.
  const playerSpeed = rms(plyV.x.map((v, i) => Math.hypot(v, plyV.y[i]!)));
  // Effort is judged in the player's own units (torso lengths per second), never against the object's
  // speed in its own sizes: a small fast object would ask for more than any body can do. The target follows
  // how quickly the object crosses its own range of travel, applied to the room a player has in front of a
  // laptop, so a slow steady car asks for less than a bouncing ball.
  const refRange = Math.max(range(ref.x), range(ref.y), 1e-6);
  const refRel = rms(refV.x.map((v, i) => Math.hypot(v, refV.y[i]!))) / refRange;
  const target = Math.min(TRAJECTORY.activityTarget, Math.max(TRAJECTORY.activityTargetMin, refRel * BODY_PARTS[bodyPart].reach));
  const activityMin = Math.min(TRAJECTORY.activityMin, 0.4 * target);
  const activity = clamp01((playerSpeed - activityMin) / (target - activityMin));

  const { matches, extras, f1 } = matchEvents(refEvents, plyEvents, lag);
  const lagMs = Math.round(lag * GRID_MS);
  const timing = timingCredit(lagMs);

  const wc = n < TRAJECTORY.shortClipFrames ? TRAJECTORY.continuousWeightShort : TRAJECTORY.continuousWeight;
  let mix: number;
  if (continuous !== null && f1 !== null) mix = wc * continuous * activity + (1 - wc) * f1;
  else if (continuous !== null) mix = continuous * activity;
  else mix = f1 ?? 0;
  // Timing scales the score, so a player who does nothing cannot collect timing credit.
  const raw = mix * (0.85 + 0.15 * timing);
  const score = Math.round(100 * clamp01(raw));
  return {
    ...base, axes, lagMs, timing, continuous, correlation, chanceCorrelation: chance, activity,
    eventF1: f1, matches, extraPlayerEvents: extras, score, tier: tierFor(score), failure: null,
  };
}
