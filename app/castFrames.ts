// The cast checker's part without a model. For one bank clip (its video and guides.json) it takes about a dozen
// frames spread evenly over the stretch a round plays, and from each one: a crop of every subject's box where it
// is seen (padded so the model sees some of what is around it), and the whole frame with every box drawn in its
// own colour. For things it also runs a cheap image check: when a box stays put between two samples but the
// picture inside it changes a lot, that is flagged as "same place, contents change" (a tracker that kept one box
// on a spot while different objects passed through it, or a screen showing something new).
//
// Everything here runs on Aaron's laptop with ffmpeg; the frames show real people, so they are written only to a
// folder outside every repo (see scripts/check-cast.ts). Nothing here changes the bank.

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface Box { cx: number; cy: number; w: number; h: number }

export interface CastGuide {
  subject: { kind: "person" | "thing"; label: string };
  range: { startMs: number; endMs: number };
  boxTrack: { source: { width: number; height: number }; frames: { tMs: number; box: Box | null }[] };
}

/** `n` times spread evenly over the range: the middle of each of `n` equal slices, so never the very first or last frame. */
export function sampleTimes(range: { startMs: number; endMs: number }, n = 12): number[] {
  const span = Math.max(0, range.endMs - range.startMs);
  if (span === 0 || n <= 0) return [];
  return Array.from({ length: n }, (_, i) => Math.round(range.startMs + ((i + 0.5) * span) / n));
}

/** The box at `tMs`: the box-track frame nearest to it, if one is within `maxGapMs`. Null where the subject is unseen. */
export function boxAt(frames: readonly { tMs: number; box: Box | null }[], tMs: number, maxGapMs = 100): Box | null {
  let best: { tMs: number; box: Box | null } | undefined;
  for (const f of frames) if (!best || Math.abs(f.tMs - tMs) < Math.abs(best.tMs - tMs)) best = f;
  return best && Math.abs(best.tMs - tMs) <= maxGapMs ? best.box : null;
}

/**
 * A box (centre and size as shares of the frame) as a pixel rectangle in a `width` by `height` frame, grown by
 * `pad` of its size on every side and kept inside the frame. Sizes are even, which ffmpeg's encoders like.
 */
export function cropRect(box: Box, source: { width: number; height: number }, pad = 0.2): { x: number; y: number; w: number; h: number } {
  const halfW = (box.w * (1 + 2 * pad) * source.width) / 2;
  const halfH = (box.h * (1 + 2 * pad) * source.height) / 2;
  const x0 = Math.max(0, Math.floor(box.cx * source.width - halfW));
  const y0 = Math.max(0, Math.floor(box.cy * source.height - halfH));
  const x1 = Math.min(source.width, Math.ceil(box.cx * source.width + halfW));
  const y1 = Math.min(source.height, Math.ceil(box.cy * source.height + halfH));
  const even = (n: number) => Math.max(2, n - (n % 2));
  const w = even(x1 - x0), h = even(y1 - y0);
  return { x: Math.min(x0, source.width - w), y: Math.min(y0, source.height - h), w, h };
}

/** Mean absolute difference of two greyscale thumbnails of the same size, 0 (the same) to 255. */
export function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
}

/** Whether two boxes are at the same place: centres within a quarter of the larger side, sizes within a third. */
export function samePlace(a: Box, b: Box): boolean {
  const side = Math.max(a.w, a.h, b.w, b.h);
  const near = Math.hypot(a.cx - b.cx, a.cy - b.cy) <= 0.25 * side;
  const ratio = (x: number, y: number) => Math.max(x, y) / Math.max(1e-6, Math.min(x, y));
  return near && ratio(a.w, b.w) <= 1.33 && ratio(a.h, b.h) <= 1.33;
}

export interface ChangeFlag { label: string; fromS: number; toS: number; diff: number }

/** How different, out of 255, the picture inside a box that stayed put must be to count as a change. */
export const CHANGE_AT = 30;

/**
 * "Same place, contents change": every pair of samples in a row where the thing is seen in both, its box stayed
 * at the same place, and the picture inside the box differs by CHANGE_AT or more.
 */
export function changeFlags(label: string, samples: readonly { tMs: number; box: Box | null; thumb: Uint8Array | null }[], threshold = CHANGE_AT): ChangeFlag[] {
  const seen = samples.filter((s): s is { tMs: number; box: Box; thumb: Uint8Array } => s.box !== null && s.thumb !== null);
  const flags: ChangeFlag[] = [];
  for (let i = 1; i < seen.length; i++) {
    const a = seen[i - 1]!, b = seen[i]!;
    if (!samePlace(a.box, b.box)) continue;
    const diff = meanAbsDiff(a.thumb, b.thumb);
    if (diff >= threshold) flags.push({ label, fromS: round1(a.tMs / 1000), toS: round1(b.tMs / 1000), diff: Math.round(diff) });
  }
  return flags;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** The colours boxes are drawn in, one per subject in cast order (ffmpeg colour names). */
export const BOX_COLOURS = ["red", "lime", "blue", "yellow", "magenta", "cyan", "orange", "white"] as const;

export interface SubjectFrames {
  label: string;
  kind: "person" | "thing";
  colour: string;
  /** Share of the stretch the box track sees it, 0 to 1. */
  seenShare: number;
  /** One crop per sample where it is seen. */
  crops: { tMs: number; path: string }[];
  /** Sample times, in ms, where the box track does not see it. */
  unseen: number[];
}

export interface ClipFrames {
  id: string;
  video: string;
  width: number;
  height: number;
  times: number[];
  /** The whole frame at each sample time with every box drawn, in the order of `times`. */
  boxed: string[];
  subjects: SubjectFrames[];
  flags: ChangeFlag[];
}

const FFMPEG = process.env.JESTER_FFMPEG ?? "/opt/homebrew/bin/ffmpeg";
const FFPROBE = process.env.JESTER_FFPROBE ?? "/opt/homebrew/bin/ffprobe";

function run(cmd: string, args: string[]): Promise<Buffer> {
  return new Promise((ok, fail) => {
    execFile(cmd, args, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) fail(new Error(`${cmd.split("/").pop()} failed: ${stderr.toString().trim().split("\n").slice(-2).join(" ")}`));
      else ok(stdout);
    });
  });
}

/** Runs `jobs` at most `limit` at a time, keeping their order. */
async function pool<T>(jobs: (() => Promise<T>)[], limit = 6): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]!();
    }
  }));
  return out;
}

/** The clip's video in a bank folder: clip.mp4, clip.webm or clip.mov. */
export function videoIn(clipDir: string): string | null {
  const name = readdirSync(clipDir).find((f) => /^clip\.(mp4|webm|mov)$/.test(f));
  return name ? join(clipDir, name) : null;
}

export function readGuides(clipDir: string): CastGuide[] {
  return JSON.parse(readFileSync(join(clipDir, "guides.json"), "utf8")) as CastGuide[];
}

async function videoSize(video: string): Promise<{ width: number; height: number }> {
  const out = (await run(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", video])).toString().trim();
  const [w, h] = out.split(",").map(Number);
  if (!w || !h) throw new Error(`Could not read the size of ${video}.`);
  return { width: w, height: h };
}

/** Longest side of what is sent to the model, in pixels. */
const FULL_SIDE = 768;
const CROP_SIDE = 384;
const scaleTo = (side: number) => `scale='if(gt(iw,ih),min(${side},iw),-2)':'if(gt(iw,ih),-2,min(${side},ih))'`;

/**
 * Frames, crops and change flags for one bank clip, written as JPEGs under `outDir`. Box tracks are in the clip's
 * own time, so each sample seeks the video at its time.
 */
export async function castFrames(clipDir: string, outDir: string, n = 12): Promise<ClipFrames> {
  const video = videoIn(clipDir);
  if (!video) throw new Error(`No clip video in ${clipDir}.`);
  const guides = readGuides(clipDir);
  if (guides.length === 0) throw new Error(`No guides in ${clipDir}.`);
  const { width, height } = await videoSize(video);
  const times = sampleTimes(guides[0]!.range, n);
  mkdirSync(outDir, { recursive: true });
  const at = (tMs: number) => (tMs / 1000).toFixed(3);
  const tag = (tMs: number) => String(Math.round(tMs)).padStart(6, "0");

  const subjects: SubjectFrames[] = guides.map((g, i) => {
    const frames = g.boxTrack.frames;
    return {
      label: g.subject.label, kind: g.subject.kind, colour: BOX_COLOURS[i % BOX_COLOURS.length]!,
      seenShare: Math.round((frames.filter((f) => f.box).length / Math.max(1, frames.length)) * 100) / 100,
      crops: [], unseen: [],
    };
  });
  const boxes = guides.map((g) => times.map((t) => boxAt(g.boxTrack.frames, t)));

  const jobs: (() => Promise<void>)[] = [];
  const boxed: string[] = times.map((t) => join(outDir, `frame-${tag(t)}.jpg`));
  times.forEach((t, ti) => {
    const draws = guides.flatMap((_, gi) => {
      const b = boxes[gi]![ti];
      if (!b) return [];
      const r = cropRect(b, { width, height }, 0);
      return [`drawbox=x=${r.x}:y=${r.y}:w=${r.w}:h=${r.h}:color=${subjects[gi]!.colour}:t=${Math.max(3, Math.round(Math.max(width, height) / 200))}`];
    });
    jobs.push(async () => { await run(FFMPEG, ["-v", "error", "-y", "-ss", at(t), "-i", video, "-frames:v", "1", "-vf", [...draws, scaleTo(FULL_SIDE)].join(","), "-q:v", "4", boxed[ti]!]); });
    guides.forEach((_, gi) => {
      const b = boxes[gi]![ti];
      const s = subjects[gi]!;
      if (!b) { s.unseen.push(t); return; }
      const r = cropRect(b, { width, height });
      const path = join(outDir, `subject-${gi + 1}-${tag(t)}.jpg`);
      s.crops.push({ tMs: t, path });
      jobs.push(async () => { await run(FFMPEG, ["-v", "error", "-y", "-ss", at(t), "-i", video, "-frames:v", "1", "-vf", `crop=${r.w}:${r.h}:${r.x}:${r.y},${scaleTo(CROP_SIDE)}`, "-q:v", "4", path]); });
    });
  });
  await pool(jobs);

  // The change check, for things only: a 16 by 16 greyscale thumbnail of the box itself (no padding) at each sample.
  const flags: ChangeFlag[] = [];
  for (const [gi, g] of guides.entries()) {
    if (g.subject.kind !== "thing") continue;
    const thumbs = await pool(times.map((t, ti) => async () => {
      const b = boxes[gi]![ti];
      if (!b) return null;
      const r = cropRect(b, { width, height }, 0);
      const raw = await run(FFMPEG, ["-v", "error", "-ss", at(t), "-i", video, "-frames:v", "1", "-vf", `crop=${r.w}:${r.h}:${r.x}:${r.y},scale=16:16:flags=area,format=gray`, "-f", "rawvideo", "pipe:1"]);
      return raw.length === 256 ? new Uint8Array(raw) : null;
    }));
    flags.push(...changeFlags(g.subject.label, times.map((t, ti) => ({ tMs: t, box: boxes[gi]![ti] ?? null, thumb: thumbs[ti] ?? null }))));
  }

  return { id: clipDir.split("/").filter(Boolean).pop() ?? clipDir, video, width, height, times, boxed, subjects, flags };
}
