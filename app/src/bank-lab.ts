// Bank lab (dev server only): adds clips to the video bank. Pick the bank folder once (it is remembered),
// then for each video: find its people and things with the same calls blind mode uses (`prepareVideo`
// with things on, then `subjectGuides`), look at the cast on the clip, give it a title and a credit, and
// write `<id>/clip.<type>`, `<id>/poster.jpg`, `<id>/guides.json` and the updated `index.json`.

import type { Guide } from "../../clip/src/index.ts";
import { prepareVideo, subjectGuides } from "./clip.ts";
import { guideFrameAt, traceOutline } from "./clipside/blind.ts";
import {
  BANK_SCHEMA, bankEntry, emptyBankIndex, guidesJson, readBankIndex, slugFor, withClip, withoutClip,
  type BankEntry, type BankIndex,
} from "./bankIndex.ts";
import { listBank, loadBankGuides } from "./bank.ts";
import { submitClip } from "./submit.ts";

type Result<T> = { data: T; error: null } | { data: null; error: string };
type VideoType = "mp4" | "webm";
interface Found { guides: Guide[]; skipped: { number: number; label?: string; reason: string }[] }

// The folder picker and its permission calls are Chrome and Edge only, so TypeScript's DOM types lack them.
interface WritePermission {
  queryPermission(d: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission(d: { mode: "readwrite" }): Promise<PermissionState>;
}
type FolderPicker = (o: { id: string; mode: "readwrite" }) => Promise<FileSystemDirectoryHandle>;

/** Free clips from Wikimedia Commons, credited as their pages ask. Titles hint without saying who is who. */
const STARTERS: { file: string; title: string; credit: string }[] = [
  { file: "squat.webm", title: "Leg day", credit: "FitnessScape, CC BY 3.0, Wikimedia Commons" },
  { file: "vertical.webm", title: "Heavy lifting", credit: "Your Move, CC BY-SA 4.0, Wikimedia Commons" },
  { file: "frisbee-dog.webm", title: "Frisbee contest", credit: "Abujoy, CC BY 4.0, Wikimedia Commons" },
  { file: "dribble.webm", title: "Dribbling drills", credit: "Mart570, CC BY-SA 3.0, Wikimedia Commons" },
  { file: "skateboard.webm", title: "Skate park", credit: "Zelio007, CC BY-SA 4.0, Wikimedia Commons" },
  { file: "volleyball-serve.webm", title: "The serve", credit: "Daniel Sánchez Moll, CC BY-SA 4.0, Wikimedia Commons" },
  { file: "juggling.webm", title: "Street show", credit: "Nesnad, CC BY-SA 4.0, Wikimedia Commons" },
  { file: "horse-jump.webm", title: "Over the fence", credit: "Ottomar Anschütz, public domain, Wikimedia Commons" },
  { file: "bike-kid.webm", title: "Ride in the park", credit: "Nesnad, CC BY-SA 4.0, Wikimedia Commons" },
  { file: "kite.webm", title: "Windy beach", credit: "Cody Logan, CC BY-SA 4.0, Wikimedia Commons" },
  { file: "cat-laser.webm", title: "Red dot", credit: "Clément Bucco-Lechat, CC BY-SA 3.0, Wikimedia Commons" },
  { file: "dog-fetch.webm", title: "Fetch", credit: "idioterna, CC BY 3.0, Wikimedia Commons" },
];

const COLORS = ["#f5c542", "#4f7bf0", "#f47fa6", "#3ccf91", "#ff7a3c", "#b07cff"];
const POSTER_WIDTH = 640;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>("video");
const overlay = $<HTMLCanvasElement>("overlay");

let dir: FileSystemDirectoryHandle | null = null;
let current: { file: File; type: VideoType; guides: Guide[] } | null = null;
let preview: Guide[] | null = null;
let busy = false;

function say(id: string, text: string, tone: "good" | "bad" | "" = "") {
  const el = $(id);
  el.textContent = text;
  el.className = "status " + tone;
}

function syncButtons() {
  $<HTMLButtonElement>("add").disabled = busy || !dir || !current;
  $<HTMLButtonElement>("seed").disabled = busy || !dir;
  $<HTMLInputElement>("file").disabled = busy;
  $<HTMLInputElement>("files").disabled = busy || !dir;
  for (const b of document.querySelectorAll<HTMLButtonElement>("button.remove")) b.disabled = busy;
}

// ---- The folder, remembered in IndexedDB so it is picked only once ----

function handleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("jester-bank-lab", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("handles");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function rememberFolder(handle: FileSystemDirectoryHandle) {
  try {
    const db = await handleDb();
    db.transaction("handles", "readwrite").objectStore("handles").put(handle, "bank");
  } catch {
    // Remembering is a convenience: without it the folder is picked again next time.
  }
}

async function rememberedFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await handleDb();
    return await new Promise((resolve) => {
      const request = db.transaction("handles").objectStore("handles").get("bank");
      request.onsuccess = () => resolve((request.result as FileSystemDirectoryHandle | undefined) ?? null);
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function useFolder(handle: FileSystemDirectoryHandle) {
  const permission = handle as unknown as WritePermission;
  const granted = (await permission.queryPermission({ mode: "readwrite" })) === "granted"
    || (await permission.requestPermission({ mode: "readwrite" })) === "granted";
  if (!granted) return say("folderStatus", "This page may not write to that folder. Pick it again and choose Allow.", "bad");
  dir = handle;
  await rememberFolder(handle);
  $("reuseFolder").classList.add("hidden");
  // jester-deploy/bank is copied into every deploy of the public site; jester-private-bank stays on this laptop.
  const deploys = handle.name === "bank" ? " If this is jester-deploy/bank, it goes out with the next deploy of the public site." : "";
  say("folderStatus", `Writing to the folder "${handle.name}".${deploys}`, "good");
  syncButtons();
  await showBank();
}

$("pickFolder").addEventListener("click", async () => {
  const picker = (window as unknown as { showDirectoryPicker?: FolderPicker }).showDirectoryPicker;
  if (!picker) return say("folderStatus", "This browser cannot pick a folder. Use Chrome or Edge on a computer.", "bad");
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await picker({ id: "jester-bank", mode: "readwrite" });
  } catch {
    return; // Cancelled.
  }
  await useFolder(handle);
});

void rememberedFolder().then((handle) => {
  if (!handle) return;
  const button = $<HTMLButtonElement>("reuseFolder");
  button.textContent = `Use "${handle.name}" again`;
  button.classList.remove("hidden");
  button.addEventListener("click", () => void useFolder(handle), { once: true });
});

// ---- Files in the folder ----

async function writeFile(folder: FileSystemDirectoryHandle, name: string, data: Blob | string) {
  const handle = await folder.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

async function readIndex(folder: FileSystemDirectoryHandle): Promise<Result<BankIndex>> {
  let text: string;
  try {
    text = await (await (await folder.getFileHandle("index.json")).getFile()).text();
  } catch (err) {
    if ((err as DOMException).name === "NotFoundError") return { data: emptyBankIndex(), error: null };
    return { data: null, error: "index.json could not be read." };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { data: null, error: "index.json is not valid JSON. Fix it or remove it first." };
  }
  const read = readBankIndex(json);
  if (read.error !== null) return { data: null, error: "index.json is not a bank/1 index. Fix it or remove it first." };
  return { data: { schema: BANK_SCHEMA, clips: read.data }, error: null };
}

const writeIndex = (folder: FileSystemDirectoryHandle, index: BankIndex) => writeFile(folder, "index.json", JSON.stringify(index, null, 2) + "\n");

// ---- Analysis and the cast preview ----

/**
 * How the bank stores the file. A phone's MOV is the same container as MP4 (browsers read both with one
 * reader), so it goes in as clip.mp4; the lab reading it for moves shows that it decodes.
 */
function videoType(file: File): VideoType | null {
  if (file.type === "video/mp4" || /\.(mp4|m4v)$/i.test(file.name)) return "mp4";
  if (file.type === "video/quicktime" || /\.mov$/i.test(file.name)) return "mp4";
  if (file.type === "video/webm" || /\.webm$/i.test(file.name)) return "webm";
  return null;
}

/** A title from a file name: no file type, dashes and underscores as spaces. */
const titleFrom = (name: string) => name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim().replace(/\s+/g, " ").slice(0, 80) || "Untitled clip";

async function analyse(file: File, onProgress: (share: number) => void): Promise<Result<Found>> {
  // The reader may decode through the <video> element, so the cast preview lets go of it first.
  preview = null;
  video.pause();
  const prepared = await prepareVideo(file, video, onProgress, { things: true });
  if (prepared.error !== null) return { data: null, error: prepared.error };
  const found = subjectGuides(prepared.data);
  if (found.guides.length === 0) return { data: null, error: found.skipped[0]?.reason ?? "No one to copy in this clip." };
  return { data: found, error: null };
}

function whenReady(): Promise<void> {
  if (video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve) => {
    video.addEventListener("loadeddata", () => resolve(), { once: true });
    setTimeout(resolve, 5000);
  });
}

function seek(seconds: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => resolve();
    video.addEventListener("seeked", done, { once: true });
    setTimeout(done, 3000);
    video.currentTime = seconds;
  });
}

/** Plays the clip's shared stretch on a loop with every subject's outline and label drawn on it. */
async function showCast(guides: Guide[]) {
  preview = guides;
  await whenReady();
  const g = guides[0]!;
  overlay.height = Math.round(overlay.width * (g.source.height / g.source.width));
  video.currentTime = g.range.startMs / 1000;
  void video.play().catch(() => {});
}

function drawOverlay() {
  requestAnimationFrame(drawOverlay);
  const guides = preview;
  if (!guides || video.readyState < 2) return;
  const g0 = guides[0]!;
  const ms = video.currentTime * 1000;
  if (!video.paused && (ms >= g0.range.endMs || video.ended)) {
    video.currentTime = g0.range.startMs / 1000;
    void video.play().catch(() => {});
  }
  const ctx = overlay.getContext("2d")!;
  const W = overlay.width, H = overlay.height;
  ctx.drawImage(video, 0, 0, W, H);
  ctx.lineWidth = 3;
  ctx.font = "bold 16px system-ui, sans-serif";
  guides.forEach((g, k) => {
    const i = guideFrameAt(g, ms);
    const outline = g.outlines[i] ?? null, box = g.boxTrack.frames[i]?.box ?? null;
    const color = COLORS[k % COLORS.length]!;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    if (outline && outline.length >= 3) {
      traceOutline(ctx, outline, (x, y) => [x * W, y * H]);
      ctx.stroke();
    } else if (box) {
      ctx.strokeRect((box.cx - box.w / 2) * W, (box.cy - box.h / 2) * H, box.w * W, box.h * H);
    }
    if (box) ctx.fillText(g.subject.label, (box.cx - box.w / 2) * W, Math.max(16, (box.cy - box.h / 2) * H - 6));
  });
}
requestAnimationFrame(drawOverlay);

function listCast(found: Found) {
  const subjects = $("subjects");
  subjects.replaceChildren();
  found.guides.forEach((g, k) => {
    const seen = g.boxTrack.frames.filter((f) => f.box).length;
    const li = document.createElement("li");
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = COLORS[k % COLORS.length]!;
    li.append(swatch, `${g.subject.label} (${g.subject.kind}), ${g.pace} pace, in ${seen} of ${g.boxTrack.frames.length} frames`);
    subjects.appendChild(li);
  });
  const skipped = $("skipped");
  skipped.replaceChildren();
  for (const s of found.skipped) {
    const li = document.createElement("li");
    li.className = "bad";
    li.textContent = `Left out: ${s.label ?? `subject ${s.number}`}. ${s.reason}`;
    skipped.appendChild(li);
  }
}

// ---- Adding to the bank ----

async function posterOf(g: Guide): Promise<Blob> {
  video.pause();
  await whenReady();
  await seek((g.range.startMs + g.range.endMs) / 2000);
  const scale = Math.min(1, POSTER_WIDTH / (video.videoWidth || POSTER_WIDTH));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round((video.videoWidth || POSTER_WIDTH) * scale);
  canvas.height = Math.round((video.videoHeight || POSTER_WIDTH * 9 / 16) * scale);
  canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("no poster"))), "image/jpeg", 0.82));
}

async function addToBank(folder: FileSystemDirectoryHandle, file: File, type: VideoType, guides: Guide[], title: string, credit: string): Promise<Result<{ entry: BankEntry; guidesBytes: number }>> {
  const index = await readIndex(folder);
  if (index.error !== null) return index;
  const g = guides[0]!;
  const id = slugFor(title, index.data.clips.map((c) => c.id));
  try {
    const clipFolder = await folder.getDirectoryHandle(id, { create: true });
    await writeFile(clipFolder, `clip.${type}`, file);
    await writeFile(clipFolder, "poster.jpg", await posterOf(g));
    const json = guidesJson(guides);
    await writeFile(clipFolder, "guides.json", json);
    const entry = bankEntry({
      id, title, credit,
      durationMs: Math.round(g.range.endMs - g.range.startMs),
      people: guides.filter((x) => x.subject.kind === "person").length,
      things: guides.filter((x) => x.subject.kind === "thing").length,
    }, type);
    // The index is written last, so a clip that failed halfway never shows up in the game.
    const latest = await readIndex(folder);
    if (latest.error !== null) return latest;
    await writeIndex(folder, withClip(latest.data, entry));
    return { data: { entry, guidesBytes: json.length }, error: null };
  } catch (err) {
    return { data: null, error: `Writing to the bank folder failed: ${(err as Error).message}` };
  }
}

const describe = (e: BankEntry) => `${e.people} ${e.people === 1 ? "person" : "people"}, ${e.things} ${e.things === 1 ? "thing" : "things"}, ${(e.durationMs / 1000).toFixed(1)} s`;

$("file").addEventListener("change", async (event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || busy) return;
  current = null;
  preview = null;
  $("found").classList.add("hidden");
  const type = videoType(file);
  if (!type) return say("addStatus", "The bank takes MP4, WebM or MOV files. Export this one as MP4 and try again.", "bad");
  busy = true;
  syncButtons();
  say("addStatus", `Finding the people and things in ${file.name}...`);
  const progress = $<HTMLProgressElement>("progress");
  const found = await analyse(file, (share) => { progress.value = share; });
  busy = false;
  if (found.error !== null) {
    syncButtons();
    return say("addStatus", `${file.name}: ${found.error}`, "bad");
  }
  current = { file, type, guides: found.data.guides };
  listCast(found.data);
  $<HTMLInputElement>("title").value = titleFrom(file.name);
  $<HTMLInputElement>("credit").value = "";
  $("found").classList.remove("hidden");
  say("addStatus", `${file.name}: ${found.data.guides.length} to copy. Check the outlines sit on the right people and things, then add it.`, "good");
  syncButtons();
  await showCast(found.data.guides);
});

$("add").addEventListener("click", async () => {
  if (!dir || !current || busy) return;
  const title = $<HTMLInputElement>("title").value.trim().replace(/\s+/g, " ");
  const credit = $<HTMLInputElement>("credit").value.trim().replace(/\s+/g, " ");
  if (!title) return say("addStatus", "Give the clip a title.", "bad");
  if (!credit) return say("addStatus", "Add a credit: who made the clip and its licence (for your own clips, your names).", "bad");
  busy = true;
  syncButtons();
  say("addStatus", "Writing the clip into the bank...");
  const added = await addToBank(dir, current.file, current.type, current.guides, title, credit);
  busy = false;
  if (added.error !== null) {
    syncButtons();
    return say("addStatus", added.error, "bad");
  }
  current = null;
  syncButtons();
  say("addStatus", `Added "${title}" as ${added.data.entry.id}: ${describe(added.data.entry)}, moves ${(added.data.guidesBytes / 1e6).toFixed(1)} MB.`, "good");
  await showBank();
});

// ---- Many at once: a batch of files, or the starter clips ----

interface Queued { title: string; credit: string; file: () => Promise<File | string> }

/** Reads and adds each clip in turn, one line each in `logId`. A clip that fails is listed and skipped. */
async function addMany(items: Queued[], logId: string) {
  if (!dir || busy) return;
  const folder = dir;
  busy = true;
  syncButtons();
  const log = $(logId);
  log.replaceChildren();
  const note = (text: string, tone: "good" | "bad" | "" = "") => {
    const li = document.createElement("li");
    li.textContent = text;
    if (tone) li.className = tone;
    log.appendChild(li);
    return li;
  };
  const progress = $<HTMLProgressElement>("progress");
  let added = 0;
  for (const [n, item] of items.entries()) {
    const index = await readIndex(folder);
    if (index.error !== null) { note(index.error, "bad"); break; }
    if (index.data.clips.some((c) => c.title === item.title)) { note(`${item.title}: already in the bank.`); continue; }
    const line = note(`${item.title} (${n + 1} of ${items.length}): finding the people and things...`);
    const fail = (why: string) => { line.textContent = `${item.title}: ${why}`; line.className = "bad"; };
    const file = await item.file();
    if (typeof file === "string") { fail(file); continue; }
    const type = videoType(file);
    if (!type) { fail("not an MP4, WebM or MOV file."); continue; }
    const found = await analyse(file, (share) => { progress.value = share; });
    if (found.error !== null) { fail(found.error); continue; }
    await showCast(found.data.guides);
    const result = await addToBank(folder, file, type, found.data.guides, item.title, item.credit);
    if (result.error !== null) { fail(result.error); continue; }
    added++;
    line.textContent = `${item.title}: added as ${result.data.entry.id}, ${describe(result.data.entry)}.`;
    line.className = "good";
    await showBank();
  }
  note(`Done: ${added} added.`);
  busy = false;
  syncButtons();
}

$("files").addEventListener("change", async (event) => {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = "";
  if (files.length === 0) return;
  if (!dir) return say("folderStatus", "Pick the bank folder first.", "bad");
  const credit = $<HTMLInputElement>("manyCredit").value.trim().replace(/\s+/g, " ") || "Saved for a private test, not for sharing";
  await addMany(files.map((f) => ({ title: titleFrom(f.name), credit, file: async () => f })), "manyLog");
});

$("seed").addEventListener("click", () => {
  void addMany(STARTERS.map((s) => ({
    title: s.title,
    credit: s.credit,
    file: async () => {
      const response = await fetch(`/_clips/${s.file}`).catch(() => null);
      const kind = response?.headers.get("content-type") ?? "";
      // A dev server answers a missing file with its page, so only a video counts as found.
      if (!response?.ok || !kind.startsWith("video/")) return `${s.file} is not in app/public/_clips.`;
      return new File([await response.blob()], s.file, { type: kind.split(";")[0] });
    },
  })), "seedLog");
});

// ---- What is in the bank ----

let posterUrls: string[] = [];

async function showBank() {
  if (!dir) return;
  const folder = dir;
  const index = await readIndex(folder);
  if (index.error !== null) return say("bankStatus", index.error, "bad");
  for (const url of posterUrls) URL.revokeObjectURL(url);
  posterUrls = [];
  const list = $("bankList");
  list.replaceChildren();
  say("bankStatus", index.data.clips.length ? `${index.data.clips.length} clips in the bank.` : "The bank is empty.");
  for (const e of index.data.clips) {
    const row = document.createElement("div");
    row.className = "clip";
    const img = document.createElement("img");
    img.alt = "";
    try {
      const poster = await (await (await folder.getDirectoryHandle(e.id)).getFileHandle("poster.jpg")).getFile();
      img.src = URL.createObjectURL(poster);
      posterUrls.push(img.src);
    } catch {
      // No poster: the grey box stays.
    }
    const what = document.createElement("div");
    what.className = "what";
    const name = document.createElement("strong");
    name.textContent = e.title;
    const credit = document.createElement("div");
    credit.className = "credit";
    credit.textContent = `${e.credit} (${e.id}, ${describe(e)})`;
    what.append(name, credit);
    const remove = document.createElement("button");
    remove.className = "remove";
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      if (busy || !confirm(`Remove "${e.title}" from the bank? Its folder ${e.id} is deleted.`)) return;
      busy = true;
      syncButtons();
      const latest = await readIndex(folder);
      if (latest.error === null) {
        await writeIndex(folder, withoutClip(latest.data, e.id));
        await folder.removeEntry(e.id, { recursive: true }).catch(() => {});
      }
      busy = false;
      await showBank();
      syncButtons();
    });
    row.append(img, what, remove);
    list.appendChild(row);
  }
  syncButtons();
}

$("check").addEventListener("click", async () => {
  say("checkStatus", "Reading the bank the way the game does...");
  const listed = await listBank();
  if (listed.error !== null) return say("checkStatus", listed.error, "bad");
  if (listed.data.length === 0) return say("checkStatus", "The game sees an empty bank.");
  const where = new URL(listed.data[0]!.video).origin;
  let ok = 0;
  const problems: string[] = [];
  for (const clip of listed.data) {
    const guides = await loadBankGuides(clip);
    if (guides.error === null) ok++;
    else problems.push(`${clip.title}: ${guides.error}`);
  }
  say("checkStatus", `The game sees ${listed.data.length} clips at ${where}/bank; ${ok} have their moves.${problems.length ? " " + problems.join(" ") : ""} Reload the page to check again.`, problems.length ? "bad" : "good");
});

// ---- Review submissions: the reviewer agent decides, unsure ones wait for a person ----

interface Pending {
  id: string;
  created_at: string;
  video_path: string;
  title: string | null;
  credit: string | null;
  logged: { verdict: "approved" | "rejected" | "ask_a_person"; reason: string; title: string | null; steps?: string[] } | null;
}
interface AgentDecision { verdict: "approve" | "reject" | "ask_a_person"; reason: string; title: string; steps: string[] }
interface LogLine { title: string | null; verdict: string; by: string; reason: string; bankId?: string; at: string }

const SUBMITTED_CREDIT = "Sent in with Submit your own";
const FRAME_WIDTH = 384;

/** The dev server's review queue (review-dev-server.ts). Every answer is { data, error }. */
async function reviewApi<T>(route: string, body?: unknown): Promise<Result<T>> {
  try {
    const response = await fetch(`/__review/${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-jester-review": "1", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await response.json()) as Result<T>;
    return json.error === null || typeof json.error === "string" ? json : { data: null, error: "The review queue gave an answer it should not." };
  } catch {
    return { data: null, error: "The review queue is not on this dev server. Start it with the jester-bank launch settings." };
  }
}

/** The analysis facts the agent reads: who was found, for how much of the stretch, and why anyone was left out. */
function factsOf(found: Found) {
  const g0 = found.guides[0]!;
  return {
    error: null,
    durationMs: Math.round(g0.range.endMs - g0.range.startMs),
    subjects: found.guides.map((g) => ({
      label: g.subject.label, kind: g.subject.kind, pace: g.pace,
      seenShare: Math.round((g.boxTrack.frames.filter((f) => f.box).length / Math.max(1, g.boxTrack.frames.length)) * 100) / 100,
    })),
    skipped: found.skipped.map((s) => ({ ...(s.label ? { label: s.label } : {}), reason: s.reason })),
    warnings: g0.warnings,
  };
}

/** `count` small JPEG frames spread across the stretch a round plays. */
async function framesOf(g: Guide, count = 4): Promise<string[]> {
  video.pause();
  await whenReady();
  const canvas = document.createElement("canvas");
  const w = video.videoWidth || FRAME_WIDTH, h = video.videoHeight || Math.round(FRAME_WIDTH * 9 / 16);
  canvas.width = Math.min(FRAME_WIDTH, w);
  canvas.height = Math.round(canvas.width * (h / w));
  const ctx = canvas.getContext("2d")!;
  const frames: string[] = [];
  for (let i = 0; i < count; i++) {
    const ms = g.range.startMs + ((i + 0.5) / count) * (g.range.endMs - g.range.startMs);
    await seek(ms / 1000);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    frames.push(canvas.toDataURL("image/jpeg", 0.7));
  }
  return frames;
}

/** A submission's video, read and analysed: kept for the "Needs you" buttons, so approving does not read it twice. */
const readied = new Map<string, { file: File; type: VideoType; found: Found }>();

async function readySubmission(p: Pending, onProgress: (share: number) => void): Promise<Result<{ file: File; type: VideoType; found: Found }>> {
  const known = readied.get(p.id);
  if (known) return { data: known, error: null };
  let blob: Blob;
  try {
    const response = await fetch(`/__review/video?path=${encodeURIComponent(p.video_path)}`, { headers: { "x-jester-review": "1" } });
    if (!response.ok) return { data: null, error: "The video never arrived." };
    blob = await response.blob();
  } catch {
    return { data: null, error: "The video did not download. Try again." };
  }
  const file = new File([blob], p.video_path, { type: blob.type });
  const type = videoType(file);
  if (!type) return { data: null, error: "Not an MP4, WebM or MOV file." };
  const found = await analyse(file, onProgress);
  if (found.error !== null) return found;
  const ready = { file, type, found: found.data };
  readied.set(p.id, ready);
  return { data: ready, error: null };
}

/** Puts an approved submission in the bank folder and marks its row approved. */
async function approveSubmission(p: Pending, title: string, by: "agent" | "aaron", reason: string, steps: string[] = []): Promise<Result<string>> {
  if (!dir) return { data: null, error: "Pick the bank folder first: approved clips go there." };
  const ready = await readySubmission(p, (share) => { $<HTMLProgressElement>("progress").value = share; });
  if (ready.error !== null) return ready;
  const added = await addToBank(dir, ready.data.file, ready.data.type, ready.data.found.guides, p.title ?? title, p.credit ?? SUBMITTED_CREDIT);
  if (added.error !== null) return added;
  const saved = await reviewApi("decide", { id: p.id, video_path: p.video_path, title: added.data.entry.title, status: "approved", by, reason, steps, bankId: added.data.entry.id });
  if (saved.error !== null) return { data: null, error: `It is in the bank as ${added.data.entry.id}, but the queue did not save that: ${saved.error}` };
  readied.delete(p.id);
  return { data: added.data.entry.id, error: null };
}

const rejectSubmission = (p: Pending, by: "agent" | "aaron" | "check", reason: string, steps: string[] = []) =>
  reviewApi("decide", { id: p.id, video_path: p.video_path, title: p.title, status: "rejected", by, reason, steps });

let reviewing = false;

async function reviewPending() {
  if (reviewing || busy) return;
  const run = $("reviewRun");
  const note = (text: string, tone: "good" | "bad" | "" = "") => {
    const li = document.createElement("li");
    li.textContent = text;
    if (tone) li.className = tone;
    run.appendChild(li);
    return li;
  };
  const status = await reviewApi<{ missing: string[] }>("status");
  if (status.error !== null) return say("reviewStatus", status.error, "bad");
  if (status.data.missing.length) return say("reviewStatus", `Put ${status.data.missing.join(" and ")} in hack-princeton/jester-review.env, then press Review again. No restart needed.`, "bad");
  if (!dir) return say("reviewStatus", "Pick the bank folder first (step 1): approved clips go there.", "bad");
  const pending = await reviewApi<Pending[]>("pending");
  if (pending.error !== null) return say("reviewStatus", pending.error, "bad");
  const fresh = pending.data.filter((p) => !p.logged);
  renderNeedsYou(pending.data);
  if (fresh.length === 0) {
    say("reviewStatus", `Checked at ${new Date().toLocaleTimeString()}: nothing new.`, "");
    return showReviewLog();
  }
  reviewing = true;
  busy = true;
  syncButtons();
  $<HTMLButtonElement>("reviewNow").disabled = true;
  run.replaceChildren();
  say("reviewStatus", `Reviewing ${fresh.length} new ${fresh.length === 1 ? "submission" : "submissions"}...`);
  const progress = $<HTMLProgressElement>("progress");
  for (const p of fresh) {
    const name = p.title ?? p.video_path.slice(0, 8);
    const line = note(`${name}: reading the clip...`);
    const set = (text: string, tone: "good" | "bad" | "" = "") => { line.textContent = `${name}: ${text}`; line.className = tone; };
    const ready = await readySubmission(p, (share) => { progress.value = share; });
    if (ready.error !== null) {
      // The game's own analysis found no one to copy (or no video arrived): no need to ask the agent.
      const saved = await rejectSubmission(p, "check", ready.error);
      set(saved.error === null ? `turned away. ${ready.error}` : `could not save the decision: ${saved.error}`, saved.error === null ? "" : "bad");
      continue;
    }
    const g0 = ready.data.found.guides[0]!;
    await showCast(ready.data.found.guides);
    set("the reviewer is looking at it...");
    const frames = await framesOf(g0);
    const judged = await reviewApi<AgentDecision>("judge", { title: p.title, credit: p.credit, facts: factsOf(ready.data.found), frames });
    if (judged.error !== null) { set(`${judged.error} It stays in the queue for next time.`, "bad"); continue; }
    const d = judged.data;
    if (d.verdict === "approve") {
      const added = await approveSubmission(p, d.title, "agent", d.reason, d.steps);
      set(added.error === null ? `added to the bank as ${added.data}. ${d.reason}` : added.error, added.error === null ? "good" : "bad");
    } else if (d.verdict === "reject") {
      const saved = await rejectSubmission(p, "agent", d.reason, d.steps);
      set(saved.error === null ? `turned away. ${d.reason}` : `could not save the decision: ${saved.error}`, saved.error === null ? "" : "bad");
    } else {
      const saved = await reviewApi("flag", { id: p.id, video_path: p.video_path, title: p.title ?? d.title, reason: d.reason, steps: d.steps });
      set(saved.error === null ? `waiting for you. ${d.reason}` : `could not save: ${saved.error}`, saved.error === null ? "" : "bad");
    }
  }
  reviewing = false;
  busy = false;
  syncButtons();
  $<HTMLButtonElement>("reviewNow").disabled = false;
  say("reviewStatus", `Reviewed at ${new Date().toLocaleTimeString()}.`, "good");
  const after = await reviewApi<Pending[]>("pending");
  if (after.error === null) renderNeedsYou(after.data);
  await showReviewLog();
}

function renderNeedsYou(pending: Pending[]) {
  const box = $("needsYou");
  box.replaceChildren();
  const waiting = pending.filter((p) => p.logged?.verdict === "ask_a_person");
  if (waiting.length === 0) {
    const p = document.createElement("p");
    p.className = "sub";
    p.textContent = "Nothing waiting.";
    box.appendChild(p);
    return;
  }
  for (const p of waiting) {
    const card = document.createElement("div");
    card.className = "waiting";
    const title = p.title ?? p.logged?.title ?? "Untitled clip";
    const name = document.createElement("strong");
    name.textContent = `${title}${p.credit ? ` (${p.credit})` : ""}`;
    const clip = document.createElement("video");
    clip.controls = true;
    clip.playsInline = true;
    clip.preload = "metadata";
    clip.src = `/__review/video?path=${encodeURIComponent(p.video_path)}`;
    const why = document.createElement("p");
    why.className = "why";
    why.textContent = `The reviewer: ${p.logged?.reason ?? ""}`;
    const steps = document.createElement("p");
    steps.className = "steps";
    steps.textContent = p.logged?.steps?.length ? `Its plan: ${p.logged.steps.join("; ")}` : "";
    const result = document.createElement("p");
    result.className = "status";
    const approve = document.createElement("button");
    approve.textContent = "Approve, add to the bank";
    const reject = document.createElement("button");
    reject.textContent = "Turn it away";
    const act = async (fn: () => Promise<Result<unknown>>, done: string) => {
      if (busy) return;
      busy = true;
      approve.disabled = reject.disabled = true;
      result.textContent = "Working...";
      const r = await fn();
      busy = false;
      syncButtons();
      if (r.error !== null) { result.textContent = r.error; result.className = "status bad"; approve.disabled = reject.disabled = false; return; }
      result.textContent = done;
      result.className = "status good";
      await showReviewLog();
    };
    approve.addEventListener("click", () => void act(() => approveSubmission(p, title, "aaron", "Approved by hand."), "Added to the bank.").then(() => showBank()));
    reject.addEventListener("click", () => void act(() => rejectSubmission(p, "aaron", "Turned away by hand."), "Turned away."));
    card.append(name, clip, why, steps, approve, document.createTextNode(" "), reject, result);
    box.appendChild(card);
  }
}

async function showReviewLog() {
  const log = await reviewApi<LogLine[]>("log");
  const list = $("reviewLog");
  list.replaceChildren();
  if (log.error !== null) return;
  const words: Record<string, string> = { approved: "Added", rejected: "Turned away", ask_a_person: "Waiting for you" };
  const who: Record<string, string> = { agent: "the reviewer", aaron: "you", check: "the analysis" };
  for (const e of log.data.slice(0, 15)) {
    const li = document.createElement("li");
    li.textContent = `${words[e.verdict] ?? e.verdict}${e.bankId ? ` as ${e.bankId}` : ""}: ${e.title ?? "untitled"} (${who[e.by] ?? e.by}, ${new Date(e.at).toLocaleTimeString()}). ${e.reason}`;
    list.appendChild(li);
  }
}

$("reviewNow").addEventListener("click", () => void reviewPending());
let reviewTimer = 0;
$("reviewAuto").addEventListener("change", (event) => {
  clearInterval(reviewTimer);
  if ((event.target as HTMLInputElement).checked) {
    void reviewPending();
    reviewTimer = window.setInterval(() => void reviewPending(), 60000);
  }
});
void reviewApi<{ missing: string[] }>("status").then((s) => {
  if (s.error !== null) return say("reviewStatus", s.error, "bad");
  say("reviewStatus", s.data.missing.length ? `Not ready: put ${s.data.missing.join(" and ")} in hack-princeton/jester-review.env.` : "Ready. Pick the bank folder, then press Review or tick the box.", s.data.missing.length ? "bad" : "good");
  void showReviewLog();
});

// ---- Submit your own, as the game sends it ----

$("submitFile").addEventListener("change", async (event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const progress = $<HTMLProgressElement>("submitProgress");
  progress.value = 0;
  say("submitStatus", `Sending ${file.name}...`);
  const sent = await submitClip(file, { title: $<HTMLInputElement>("submitTitle").value, credit: $<HTMLInputElement>("submitCredit").value }, (share) => { progress.value = share; });
  if (sent.error !== null) return say("submitStatus", sent.error, "bad");
  say("submitStatus", `Sent for review as ${sent.data.id}.`, "good");
});

syncButtons();
