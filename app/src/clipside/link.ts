// Pasted links, read without any network: which site, which video, where to start, and the key a
// grabbed analysis is saved under. Also evens out frames grabbed live onto a fixed rate.
// Pure: no DOM, no fetching. Tested from clip/test/link.test.ts.

import type { FrameDetections } from "../../../clip/src/index.ts";

export const NOT_A_LINK = "That link is not one Jester can open. Try a YouTube link, or grab it from another tab.";

export type ParsedLink =
  | { site: "youtube"; videoId: string; startSeconds: number; short: boolean; key: string; url: string }
  | { site: "tiktok"; videoId: string | null; embedUrl: string | null; key: string; url: string }
  | { site: "instagram"; code: string; embedUrl: string; key: string; url: string };

export type LinkResult = { data: ParsedLink; error: null } | { data: null; error: string };

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(["youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com"]);

/** "90", "90s", "1m30s", "1h2m3s" or "1:30" as seconds; 0 when it cannot be read. */
export function readStartTime(text: string | null): number {
  if (!text) return 0;
  const value = text.trim();
  if (/^\d+(\.\d+)?$/.test(value)) return Math.floor(Number(value));
  const clock = value.match(/^(?:(\d+):)?(\d+):(\d{1,2})$/);
  if (clock) return Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  const parts = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (parts && (parts[1] || parts[2] || parts[3])) return Number(parts[1] ?? 0) * 3600 + Number(parts[2] ?? 0) * 60 + Number(parts[3] ?? 0);
  return 0;
}

function toUrl(text: string): URL | null {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  try {
    return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
}

function youtube(url: URL, host: string): ParsedLink | null {
  let id: string | null = null;
  let short = false;
  const segments = url.pathname.split("/").filter(Boolean);
  if (host === "youtu.be") id = segments[0] ?? null;
  else if (YOUTUBE_HOSTS.has(host)) {
    if (segments[0] === "watch") id = url.searchParams.get("v");
    else if (segments[0] === "shorts") { id = segments[1] ?? null; short = true; }
    else if (segments[0] === "embed" || segments[0] === "live" || segments[0] === "v") id = segments[1] ?? null;
  }
  if (!id || !YOUTUBE_ID.test(id)) return null;
  const hashTime = url.hash.match(/t=([^&]+)/)?.[1] ?? null;
  const startSeconds = readStartTime(url.searchParams.get("t") ?? url.searchParams.get("start") ?? hashTime);
  return { site: "youtube", videoId: id, startSeconds, short, key: `yt:${id}`, url: url.href };
}

function tiktok(url: URL, host: string): ParsedLink | null {
  const segments = url.pathname.split("/").filter(Boolean);
  if (host === "vm.tiktok.com" || host === "vt.tiktok.com" || (host === "tiktok.com" && segments[0] === "t")) {
    const code = host === "tiktok.com" ? segments[1] : segments[0];
    if (!code) return null;
    return { site: "tiktok", videoId: null, embedUrl: null, key: `tt:short:${code}`, url: url.href };
  }
  if (host !== "tiktok.com" && host !== "m.tiktok.com") return null;
  const at = segments.findIndex((s) => s === "video" || s === "embed" || s === "player");
  const id = segments.slice(at + 1).find((s) => /^\d{8,25}$/.test(s));
  if (at < 0 || !id) return null;
  return { site: "tiktok", videoId: id, embedUrl: `https://www.tiktok.com/player/v1/${id}`, key: `tt:${id}`, url: url.href };
}

function instagram(url: URL, host: string): ParsedLink | null {
  if (host !== "instagram.com") return null;
  const segments = url.pathname.split("/").filter(Boolean);
  const kind = segments[0];
  const code = segments[1];
  if (!kind || !code || !["reel", "reels", "p", "tv"].includes(kind) || !/^[A-Za-z0-9_-]{5,}$/.test(code)) return null;
  const path = kind === "reels" ? "reel" : kind;
  return { site: "instagram", code, embedUrl: `https://www.instagram.com/${path}/${code}/embed`, key: `ig:${code}`, url: url.href };
}

/** Reads a pasted YouTube, Shorts, TikTok or Instagram link. Anything else is the NOT_A_LINK sentence. */
export function parseLink(text: string): LinkResult {
  const url = toUrl(text);
  if (!url) return { data: null, error: NOT_A_LINK };
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const parsed = youtube(url, host) ?? tiktok(url, host) ?? instagram(url, host);
  return parsed ? { data: parsed, error: null } : { data: null, error: NOT_A_LINK };
}

/** The key a grab is saved under: the link's key and the range, in whole milliseconds. */
export function grabKey(linkKey: string, startMs: number, endMs: number): string {
  return `${linkKey}:${Math.round(startMs)}-${Math.round(endMs)}`;
}

/**
 * Frames grabbed live arrive unevenly (the tracker is busy, the tab stutters). The clip side
 * expects one frame every 1000 / sampleHz ms, so each slot from `startMs` to `endMs` takes the
 * grabbed frame nearest to it, stamped with the slot's time. `nearest` is that grabbed frame for
 * each slot, so anything else read from it can follow. `stretched` counts slots whose nearest
 * frame was more than one slot away.
 */
export function evenFrames<T extends FrameDetections>(
  grabbed: readonly T[],
  startMs: number,
  endMs: number,
  sampleHz: number,
): { frames: FrameDetections[]; nearest: T[]; stretched: number } {
  const sorted = [...grabbed].sort((a, b) => a.tMs - b.tMs);
  const frames: FrameDetections[] = [];
  const nearest: T[] = [];
  let stretched = 0;
  if (sorted.length === 0) return { frames, nearest, stretched };
  const stepMs = 1000 / sampleHz;
  let j = 0;
  for (let k = 0; startMs + k * stepMs < endMs; k++) {
    const t = startMs + k * stepMs;
    while (j + 1 < sorted.length && Math.abs(sorted[j + 1]!.tMs - t) <= Math.abs(sorted[j]!.tMs - t)) j++;
    const from = sorted[j]!;
    if (Math.abs(from.tMs - t) > stepMs) stretched++;
    frames.push({ tMs: Math.round(t), people: from.people, signature: from.signature });
    nearest.push(from);
  }
  return { frames, nearest, stretched };
}
