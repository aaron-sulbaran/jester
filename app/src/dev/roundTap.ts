// Dev server only. app/round-log-dev-server.ts points every app import of engine/src/index.ts here, so
// solo, rooms, blind, duel, the link reveal and the labs all pass through without a line changed in them.
// The scorer runs untouched and its result goes back as is. Afterwards, when the page is idle, the two
// timelines it compared and the result are sent to the dev server, which saves them to eval/data/rounds.
// Pose data only: no video, no images, no masks.

import * as engine from "../../../engine/src/index.ts";
import type { BoxTrack, PoseTimeline } from "../../../engine/src/index.ts";
import {
  RECORD_SCHEMA, fingerprint, newRoundId, packBoxes, packPose,
  type Channel, type PackedBoxes, type PackedPose, type RoundRecord,
} from "../../../eval/src/record.ts";
import { mountDevPanel, showProblem, showSaved, takeTag } from "./devPanel.ts";

export * from "../../../engine/src/index.ts";

type Result<T> = { data: T; error: null } | { data: null; error: string };

/** Pages may say what is being played (the eval lab does); otherwise the bank guides the page fetched are matched. */
interface RoundContext { bankId?: string; title?: string; subject?: string }
declare global { interface Window { __jesterRoundContext?: RoundContext } }

export const scorePoseRound: typeof engine.scorePoseRound = (reference, player, options = {}) => {
  const result = engine.scorePoseRound(reference, player, options);
  observe("pose", reference, player, { ...options }, result);
  return result;
};

export const scoreTrajectoryRound: typeof engine.scoreTrajectoryRound = (track, player, options = {}) => {
  const result = engine.scoreTrajectoryRound(track, player, options);
  observe("trajectory", track, player, { ...options }, result);
  return result;
};

// ---- Capture: cheap work now, the rest when idle ----

function observe(channel: Channel, reference: PoseTimeline | BoxTrack, player: PoseTimeline, options: Record<string, unknown>, result: RoundRecord["result"]) {
  try {
    // Chrome keeps 10 stack frames by default; the mode is read from the app files on the stack.
    const errorClass = Error as { stackTraceLimit?: number };
    const limit = errorClass.stackTraceLimit;
    errorClass.stackTraceLimit = 40;
    const stack = new Error().stack ?? "";
    errorClass.stackTraceLimit = limit;
    const { tag, note } = takeTag();
    const context = { ...(window.__jesterRoundContext ?? {}) };
    const createdAt = new Date().toISOString();
    later(() => {
      void logRound(buildRecord({ channel, reference, player, options, result, stack, tag, note, context, createdAt }));
    });
  } catch (err) {
    console.warn("[round log] skipped a round:", err);
  }
}

function later(fn: () => void) {
  const idle = (window as { requestIdleCallback?: (cb: () => void, o: { timeout: number }) => number }).requestIdleCallback;
  if (idle) idle(fn, { timeout: 4000 });
  else setTimeout(fn, 300);
}

interface Captured {
  channel: Channel;
  reference: PoseTimeline | BoxTrack;
  player: PoseTimeline;
  options: Record<string, unknown>;
  result: RoundRecord["result"];
  stack: string;
  tag: RoundRecord["tag"];
  note: string | null;
  context: RoundContext;
  createdAt: string;
}

function buildRecord(c: Captured): RoundRecord {
  const reference: PackedPose | PackedBoxes = c.channel === "pose" ? packPose(c.reference as PoseTimeline) : packBoxes(c.reference as BoxTrack);
  const callers = callersOf(c.stack);
  const match = c.context.bankId ? null : matchBankGuide(c.channel, c.reference);
  return {
    schema: RECORD_SCHEMA,
    id: newRoundId(Date.parse(c.createdAt)),
    createdAt: c.createdAt,
    browserId: browserId(),
    mode: modeOf(callers, location.pathname),
    page: location.pathname,
    callers,
    clip: {
      key: fingerprint(reference),
      bankId: c.context.bankId ?? match?.bankId ?? null,
      title: c.context.title ?? match?.title ?? null,
      subject: c.context.subject ?? match?.subject ?? null,
    },
    tag: c.tag,
    note: c.note,
    channel: c.channel,
    options: c.options,
    reference,
    player: packPose(c.player),
    result: c.result,
    scorerVersion: c.result.scorerVersion,
    device: deviceFacts(c.player),
    app: null,
  };
}

// ---- Saving ----

const pending: RoundRecord[] = [];
let retryTimer = 0;

/** Sends one record to the dev server. Never throws; a failed send waits and goes again with the next one. */
export async function logRound(record: RoundRecord): Promise<Result<{ id: string }>> {
  pending.push(record);
  let last: Result<{ id: string }> = { data: null, error: "Nothing sent." };
  for (const r of pending.splice(0)) {
    last = await send(r);
    if (last.error !== null) {
      pending.unshift(r);
      showProblem(`Not saved yet (${last.error}); trying again in 15 s.`);
      clearTimeout(retryTimer);
      retryTimer = window.setTimeout(() => { const next = pending.shift(); if (next) void logRound(next); }, 15000);
      return last;
    }
    const score = r.result.score === null ? "no score" : `score ${r.result.score}`;
    const line = `Saved ${r.id} (${score}${r.tag ? ", " + r.tag : ""}, ${r.mode}).`;
    showSaved(line);
    console.info("[round log] " + line);
    window.dispatchEvent(new CustomEvent("jester-round-saved", { detail: { id: r.id, score: r.result.score, tag: r.tag, mode: r.mode } }));
  }
  return last;
}

async function send(r: RoundRecord): Promise<Result<{ id: string }>> {
  try {
    const response = await fetch("/__jester/rounds", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(r) });
    const body = (await response.json()) as Result<{ id: string }>;
    return response.ok ? body : { data: null, error: body.error ?? `dev server answered ${response.status}` };
  } catch {
    return { data: null, error: "the dev server did not answer" };
  }
}

// ---- Context ----

function callersOf(stack: string): string[] {
  const out: string[] = [];
  for (const m of stack.matchAll(/\/src\/([\w./-]+?)\.ts\b/g)) {
    const file = m[1]!;
    if (file === "dev/roundTap" || file.startsWith("dev/") || out.includes(file)) continue;
    out.push(file);
  }
  return out;
}

function modeOf(callers: string[], page: string): string {
  const has = (f: string) => callers.includes(f);
  if (has("eval-lab") || page.endsWith("/eval-lab.html")) return "eval-lab";
  if (has("onlineDuel") || has("duel-lab")) return "duel";
  if (has("onlineBlind")) return "blind-online";
  if (has("linkReveal") || has("link-lab")) return "link";
  if (has("blind")) return "blind";
  if (has("online") || page.endsWith("/room.html")) return "room";
  if (has("main") || has("ui/game")) return "solo";
  if (/-lab\.html$/.test(page)) return "lab";
  return "unknown";
}

function browserId(): string {
  const key = "jester.browserId";
  try {
    const known = localStorage.getItem(key);
    if (known) return known;
    const id = "b-" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem(key, id);
    return id;
  } catch {
    return "b-unknown";
  }
}

let gpu: string | null | undefined;

function deviceFacts(player: PoseTimeline): RoundRecord["device"] {
  if (gpu === undefined) {
    try {
      const gl = document.createElement("canvas").getContext("webgl");
      const info = gl?.getExtension("WEBGL_debug_renderer_info");
      gpu = gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : null;
    } catch {
      gpu = null;
    }
  }
  let camera: RoundRecord["device"]["camera"] = null;
  for (const v of document.querySelectorAll("video")) {
    const track = v.srcObject instanceof MediaStream ? v.srcObject.getVideoTracks()[0] : undefined;
    if (!track) continue;
    const s = track.getSettings();
    camera = { label: track.label, width: s.width ?? null, height: s.height ?? null, frameRate: s.frameRate ?? null };
    break;
  }
  const seen = player.frames.filter((f) => f.landmarks);
  const spanMs = seen.length > 1 ? seen[seen.length - 1]!.tMs - seen[0]!.tMs : 0;
  return {
    userAgent: navigator.userAgent,
    cores: navigator.hardwareConcurrency ?? null,
    gpu,
    camera,
    playerFps: spanMs > 0 ? Math.round(((seen.length - 1) / spanMs) * 10000) / 10 : null,
  };
}

// ---- Which bank clip: the page's own fetches of guides.json, matched to the reference ----

interface KnownGuide { bankId: string; title: string | null; subject: string; kind: "person" | "thing"; sig: number[][] }
const known: KnownGuide[] = [];
const titles = new Map<string, string>();
const SIG_FRAMES = 30;
const BODY_POINTS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

type Frames = readonly { landmarks?: readonly (readonly number[])[] | null; box?: { cx: number; cy: number; w: number; h: number } | null }[];

function signature(frames: Frames, kind: "person" | "thing"): number[][] {
  const out: number[][] = [];
  for (const f of frames) {
    if (out.length >= SIG_FRAMES) break;
    if (kind === "person" && f.landmarks && f.landmarks.length >= 33) out.push(BODY_POINTS.flatMap((i) => [f.landmarks![i]![0]!, f.landmarks![i]![1]!]));
    if (kind === "thing" && f.box) out.push([f.box.cx, f.box.cy]);
  }
  return out;
}

function distance(a: number[][], b: number[][]): number {
  const n = Math.min(a.length, b.length);
  if (n < 5) return Infinity;
  let sum = 0, count = 0;
  for (let i = 0; i < n; i++) for (let k = 0; k < a[i]!.length; k++) { sum += Math.abs(a[i]![k]! - (b[i]![k] ?? 0)); count++; }
  return sum / count;
}

function matchBankGuide(channel: Channel, reference: PoseTimeline | BoxTrack) {
  const kind = channel === "pose" ? "person" : "thing";
  const sig = signature(reference.frames as Frames, kind);
  let best: KnownGuide | null = null, bestD = 0.03;
  for (const g of known) {
    if (g.kind !== kind) continue;
    const d = distance(sig, g.sig);
    if (d < bestD) { best = g; bestD = d; }
  }
  return best ? { bankId: best.bankId, title: best.title ?? titles.get(best.bankId) ?? null, subject: best.subject } : null;
}

function rememberGuides(bankId: string, json: unknown) {
  if (!Array.isArray(json)) return;
  for (const g of json as { subject?: { label?: string; kind?: string }; timeline?: { frames?: Frames }; boxTrack?: { frames?: Frames } }[]) {
    const kind = g.subject?.kind === "thing" ? "thing" : "person";
    const frames = kind === "person" ? g.timeline?.frames : g.boxTrack?.frames;
    if (!frames) continue;
    known.push({ bankId, title: titles.get(bankId) ?? null, subject: g.subject?.label ?? kind, kind, sig: signature(frames, kind) });
  }
}

function watchBankFetches() {
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const response = await original(input, init);
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const guides = /\/([a-z0-9-]+)\/guides\.json(?:[?#]|$)/.exec(url);
      if (response.ok && guides) void response.clone().json().then((j) => rememberGuides(guides[1]!, j), () => {});
      if (response.ok && /\/index\.json(?:[?#]|$)/.test(url)) {
        void response.clone().json().then((j: { schema?: string; clips?: { id?: string; title?: string }[] }) => {
          if (j?.schema === "bank/1") for (const c of j.clips ?? []) if (c.id && c.title) titles.set(c.id, c.title);
        }, () => {});
      }
    } catch {
      // Watching is best effort; the page's own fetch already has its answer.
    }
    return response;
  };
}

watchBankFetches();
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountDevPanel, { once: true });
else mountDevPanel();
