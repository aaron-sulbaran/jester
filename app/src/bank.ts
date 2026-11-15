// The video bank: clips whose moves were found ahead of time (in bank-lab.html), served as static files.
// The game lists them with `listBank` and starts a round from one with no analysis at play time:
// `loadBankGuides` gives the saved guides, and ./bankRound.ts turns a clip into a blind mode scene.
//
// On the public site the bank is at /bank on the same origin. A local run without its own /bank
// (the usual case: the bank's files live outside the repo) reads the public site's bank instead.

import type { Guide } from "../../clip/src/index.ts";
import { readBankIndex, resolveBankPath, type BankEntry } from "./bankIndex.ts";

/** A clip in the bank, with `video`, `poster` and `guides` already full addresses. */
export interface BankClip {
  id: string;
  title: string;
  credit: string;
  /** Length of the stretch a round plays, in ms. */
  durationMs: number;
  people: number;
  things: number;
  video: string;
  poster: string;
  guides: string;
}

type Result<T> = { data: T; error: null } | { data: null; error: string };

const SAME_ORIGIN_BASE = "/bank";
const PUBLIC_BASE = "https://jester-pi.vercel.app/bank";
const BANK_UNREACHABLE = "The clip bank did not load. Check your connection and try again.";
const GUIDES_UNREACHABLE = "The moves for this clip did not load. Check your connection, or pick another clip.";
const GUIDES_BROKEN = "The moves saved for this clip are damaged. Pick another clip.";

const resolved = (base: string, e: BankEntry): BankClip => ({
  ...e,
  video: resolveBankPath(base, e.video),
  poster: resolveBankPath(base, e.poster),
  guides: resolveBankPath(base, e.guides),
});

/** The bank at `base`, or null when there is none there (a dev server answers a missing file with its page, so that counts too). */
async function readBank(base: string): Promise<BankClip[] | null> {
  try {
    // A slow venue network should end in the "did not load" message, not a library that stays blank.
    const response = await fetch(resolveBankPath(base, "index.json"), { cache: "no-cache", signal: AbortSignal.timeout(10000) });
    if (!response.ok) return null;
    const read = readBankIndex(await response.json());
    return read.error === null ? read.data.map((e) => resolved(base, e)) : null;
  } catch {
    return null;
  }
}

let listed: BankClip[] | null = null;

/**
 * Every clip in the bank, in the bank's own order. The list is kept for the page's lifetime once it
 * loads, so screens may call this as often as they like.
 */
export async function listBank(): Promise<{ data: BankClip[]; error: null } | { data: null; error: string }> {
  if (listed) return { data: listed, error: null };
  const here = new URL(SAME_ORIGIN_BASE, location.href).href;
  let clips = await readBank(here);
  if (clips === null && new URL(PUBLIC_BASE).origin !== location.origin) clips = await readBank(PUBLIC_BASE);
  if (clips === null) return { data: null, error: BANK_UNREACHABLE };
  listed = clips;
  return { data: clips, error: null };
}

/** The bank read again, not from the page's copy: for noticing a clip that joined it while the page was open. */
export async function refreshBank(): Promise<{ data: BankClip[]; error: null } | { data: null; error: string }> {
  listed = null;
  return listBank();
}

/** Enough of a guide to draw and score it; the rest was written by the same code that reads it. */
export function looksLikeGuide(x: unknown): x is Guide {
  if (typeof x !== "object" || x === null) return false;
  const g = x as Partial<Guide>;
  return g.schema === "guide/1"
    && typeof g.subject?.label === "string"
    && (g.subject.kind === "person" || g.subject.kind === "thing")
    && Array.isArray(g.boxTrack?.frames)
    && Array.isArray(g.outlines)
    && g.outlines.length === g.boxTrack.frames.length
    && typeof g.range?.startMs === "number"
    && typeof g.source?.sampleHz === "number"
    && (g.subject.kind === "thing" || Array.isArray(g.timeline?.frames));
}

const guideCache = new Map<string, Guide[]>();

/** The saved guides for one clip (people first, then things), all over the same stretch of the clip. */
export async function loadBankGuides(clip: BankClip): Promise<{ data: Guide[]; error: null } | { data: null; error: string }> {
  const cached = guideCache.get(clip.guides);
  if (cached) return { data: cached, error: null };
  let json: unknown;
  try {
    const response = await fetch(clip.guides);
    if (!response.ok) return { data: null, error: GUIDES_UNREACHABLE };
    json = await response.json();
  } catch {
    return { data: null, error: GUIDES_UNREACHABLE };
  }
  if (!Array.isArray(json) || json.length === 0 || !json.every(looksLikeGuide)) return { data: null, error: GUIDES_BROKEN };
  guideCache.set(clip.guides, json);
  return { data: json, error: null };
}
