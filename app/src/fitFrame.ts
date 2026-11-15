// Where to stand: a taped frame on the player's mirror view at the subject's place and size (the frontend agent's
// design). It says where to stand and how big to be, never who, so Blind keeps its secret. Before a whole-body
// turn the framing step aims at it; during the turn it stays faint, follows the subject, and its hint comes back
// only when the fit is badly off for a while.
//
// The pure parts (where the picture lands, the frame, the player's box, the fit and its words) are exported for
// app/test/fitFrame.test.ts. whereToStand() is the small controller blind.ts calls; it only positions one element.

/** A box in normalized picture coordinates (0 to 1 across and down), centre and size: a guide's boxTrack box. */
export interface Box { cx: number; cy: number; w: number; h: number }
/** A rectangle in pixels from the stage's top left corner. */
export interface Rect { x: number; y: number; w: number; h: number }
/** A tracked point, as the tracker gives it (not mirrored). */
export interface Point { x: number; y: number; visibility?: number }

export type Fit = "unseen" | "close" | "far" | "left" | "right" | "good";

/** Tuning: good when the player's height is 0.8 to 1.2 of the frame's and their centre within 15% of the stage width. */
export const FIT = { tooBig: 1.2, tooSmall: 0.8, offCentre: 0.15, holdMs: 700, badForMs: 1500, goodShownMs: 1000, lateMs: 12000 } as const;

/** Where a picture of `intrinsicW` by `intrinsicH` is drawn inside the element `el` (CSS object-fit cover or contain). */
export function drawnImage(el: Rect, intrinsicW: number, intrinsicH: number, fit: "cover" | "contain"): Rect {
  if (intrinsicW <= 0 || intrinsicH <= 0) return { ...el };
  const scale = (fit === "cover" ? Math.max : Math.min)(el.w / intrinsicW, el.h / intrinsicH);
  const w = intrinsicW * scale, h = intrinsicH * scale;
  return { x: el.x + (el.w - w) / 2, y: el.y + (el.h - h) / 2, w, h };
}

/** The part of `r` inside `bounds`, or null when nothing of it is. */
export function clip(r: Rect, bounds: Rect): Rect | null {
  const x = Math.max(r.x, bounds.x), y = Math.max(r.y, bounds.y);
  const right = Math.min(r.x + r.w, bounds.x + bounds.w), bottom = Math.min(r.y + r.h, bounds.y + bounds.h);
  return right > x && bottom > y ? { x, y, w: right - x, h: bottom - y } : null;
}

/**
 * The subject's box from the clip, placed on the mirror view: the same share of the picture's height, at the same
 * share across the visible view, keeping the box's shape. A mirror view shows the player on the same side as the
 * clip shows the subject, so there is no flip. Kept to what shows: the view and the picture both.
 */
export function frameRect(subject: Box, clipAspect: number, view: Rect, image: Rect): Rect | null {
  const h = subject.h * image.h;
  const w = subject.w * clipAspect * image.h;
  const cx = view.x + subject.cx * view.w, cy = image.y + subject.cy * image.h;
  return clip({ x: cx - w / 2, y: cy - h / 2, w, h }, clip(view, image) ?? view);
}

const SEEN = 0.5;
const ANKLES = [27, 28];

/**
 * The player's box on the mirror view from the tracker's points (not mirrored), padded up to the top of the head
 * and kept to what shows (`shows`, the view, and the picture) like the frame, and whether their feet show. Null when
 * too little is seen.
 */
export function playerRect(points: readonly Point[] | null | undefined, image: Rect, shows: Rect = image): { rect: Rect; feet: boolean } | null {
  if (!points || points.length < 29) return null;
  const seen = points.filter((p) => (p.visibility ?? 1) >= SEEN);
  const shoulders = [11, 12].some((i) => (points[i]?.visibility ?? 1) >= SEEN);
  if (seen.length < 6 || !shoulders) return null;
  const xs = seen.map((p) => image.x + (1 - p.x) * image.w), ys = seen.map((p) => image.y + p.y * image.h);
  const left = Math.min(...xs), right = Math.max(...xs);
  let top = Math.min(...ys);
  const bottom = Math.max(...ys);
  top -= (bottom - top) * 0.12; // the points stop at the eyes; the head goes on above them
  // Feet count only where the picture shows: a tracker guesses points past the edge, and a cropped view hides some.
  const bounds = clip(shows, image) ?? image;
  const feet = ANKLES.some((i) => (points[i]?.visibility ?? 1) >= SEEN && points[i]!.y <= 1 && image.y + points[i]!.y * image.h <= bounds.y + bounds.h);
  const rect = clip({ x: left, y: top, w: Math.max(1, right - left), h: bottom - top }, bounds);
  return rect ? { rect, feet } : null;
}

/**
 * How the player fits the frame, most important first: not seen, too close (bigger than the frame, or feet out of
 * the picture when the subject's are in theirs), too far, off to one side, or good. On a mirror view the player's
 * left is screen left, so a player right of the frame should move to their left.
 */
export function classifyFit(player: { rect: Rect; feet: boolean } | null, frame: Rect, stageWidth: number, feetExpected: boolean): Fit {
  if (!player) return "unseen";
  if (feetExpected && !player.feet) return "close";
  const ratio = player.rect.h / frame.h;
  if (ratio > FIT.tooBig) return "close";
  if (ratio < FIT.tooSmall) return "far";
  const dx = (player.rect.x + player.rect.w / 2) - (frame.x + frame.w / 2);
  if (dx > FIT.offCentre * stageWidth) return "left";
  if (dx < -FIT.offCentre * stageWidth) return "right";
  return "good";
}

/** The hint for a fit, one at a time. */
export function fitHint(fit: Fit): string {
  switch (fit) {
    case "unseen": return "Step back so all of you is in the picture.";
    case "close": return "Step back until you fit the frame.";
    case "far": return "Come closer until you fill the frame.";
    case "left": return "Move to your left, into the frame.";
    case "right": return "Move to your right, into the frame.";
    case "good": return "That's it. Stay in the frame.";
  }
}

/** Added to the hint after 12 s of trying, when the hint becomes a button. */
export const LATE_HINT = " Can't fit? Tap here to start.";

/**
 * True when the subject's feet show on the mirror view (in the clip, and not cropped off by the view), so the
 * player's should show in theirs.
 */
export function feetExpected(subject: Box, view: Rect, image: Rect): boolean {
  const bottom = subject.cy + subject.h / 2;
  const bounds = clip(view, image) ?? view;
  return bottom < 0.95 && image.y + bottom * image.h < bounds.y + bounds.h * 0.97;
}

// ---- The controller ----

export interface WhereToStand {
  /** Places the frame at play time `ms` (below 0: before the turn, at the subject's first sighting) and returns the fit. */
  follow(ms: number, points: readonly Point[] | null): Fit;
  /** For the framing step, on each camera frame: the hint to show and whether the player has fitted long enough. */
  framing(points: readonly Point[] | null): { passed: boolean; text: string };
  /** Hides the frame and its hint. */
  stop(): void;
}

/** Only the latest turn's frame may move the element, so a turn left mid-countdown cannot fight the next one. */
let current: object | null = null;

/**
 * The frame for one whole-body turn, or null when this stage has no #fitFrame (the practice area). `boxAt` is the
 * role's box at play time ms; `clipAspect` the clip's width over height; `firstMs` where the subject is first seen;
 * `hints` false keeps the turn's hints quiet (the simulated player cannot step anywhere).
 */
export function whereToStand(o: { stage: HTMLElement; canvas: HTMLCanvasElement; boxAt: (ms: number) => Box | null; clipAspect: number; firstMs: number; hints?: boolean }): WhereToStand | null {
  const found = o.stage.querySelector<HTMLElement>("#fitFrame");
  if (!found) return null;
  const frame: HTMLElement = found;
  const me = {};
  current = me;
  const objectFit = getComputedStyle(o.canvas).objectFit === "contain" ? "contain" : "cover";
  // The hint during the turn: the same paper tag as the framing step, made the first time the fit is badly off.
  let hint: HTMLElement | null = null;
  let shown = "";
  let badSince = 0, goodSince = 0, goodHintUntil = 0;
  const set = (prop: "left" | "top" | "width" | "height", pct: number) => {
    const v = `${pct.toFixed(2)}%`;
    if (frame.style[prop] !== v) frame.style[prop] = v;
  };

  function follow(ms: number, points: readonly Point[] | null): Fit {
    if (current !== me) return "unseen";
    const stageBox = o.stage.getBoundingClientRect();
    const canvasBox = o.canvas.getBoundingClientRect();
    if (stageBox.width <= 0 || stageBox.height <= 0) return "unseen";
    const view: Rect = { x: canvasBox.left - stageBox.left, y: canvasBox.top - stageBox.top, w: canvasBox.width, h: canvasBox.height };
    const image = drawnImage(view, o.canvas.width, o.canvas.height, objectFit);
    const subject = o.boxAt(ms < 0 ? o.firstMs : ms);
    const where = subject ? frameRect(subject, o.clipAspect, view, image) : null;
    if (!subject || !where) { frame.hidden = true; return "unseen"; }
    set("left", (where.x / stageBox.width) * 100);
    set("top", (where.y / stageBox.height) * 100);
    set("width", (where.w / stageBox.width) * 100);
    set("height", (where.h / stageBox.height) * 100);
    frame.hidden = false;
    // Framing (before the countdown) or the turn: both run in the playing layout, so the look can tell them apart.
    const phase = ms < 0 ? "framing" : "turn";
    if (frame.dataset.phase !== phase) frame.dataset.phase = phase;
    const player = playerRect(points, image, view);
    const fit = classifyFit(player, where, stageBox.width, feetExpected(subject, view, image));
    if (frame.dataset.fit !== fit) frame.dataset.fit = fit;
    // For checks, like window.__jesterBlind: the last frame, the player's box and the fit, in stage pixels.
    (window as unknown as { __jesterFit?: unknown }).__jesterFit = { ms, subject, frame: where, player, fit, view, image };
    if (ms >= 0 && o.hints !== false) turnHint(fit);
    return fit;
  }

  /** During the turn: a hint only after 1.5 s badly off, never over the "can't see you" notice, and a short "that's it". */
  function turnHint(fit: Fit) {
    const now = performance.now();
    const lost = document.getElementById("lostNotice");
    let text = "";
    if (fit === "unseen") {
      // Not seen for a moment (the tracker flickers): no hint, but the time badly off keeps counting.
    } else if (fit === "good") {
      badSince = 0;
      if (shown && shown !== fitHint("good")) goodHintUntil = now + FIT.goodShownMs;
      if (now < goodHintUntil) text = fitHint("good");
    } else {
      badSince ||= now;
      goodHintUntil = 0;
      if (now - badSince > FIT.badForMs) text = fitHint(fit);
    }
    if (lost && !lost.hidden) text = ""; // one notice at a time: losing the player wins
    if (text === shown) return;
    shown = text;
    if (!hint && text) {
      hint = document.createElement("div");
      hint.className = "framing-hint";
      o.stage.appendChild(hint);
    }
    if (!hint) return;
    hint.textContent = text;
    hint.hidden = !text;
  }

  return {
    follow,
    framing(points) {
      const fit = follow(-1, points);
      const now = performance.now();
      if (fit === "good") goodSince ||= now; else goodSince = 0;
      return { passed: fit === "good" && now - goodSince >= FIT.holdMs, text: fitHint(fit) };
    },
    stop() {
      if (current === me) { current = null; frame.hidden = true; frame.dataset.fit = "unseen"; }
      hint?.remove();
    },
  };
}
