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
  say("folderStatus", `Writing to the folder "${handle.name}".`, "good");
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

function videoType(file: File): VideoType | null {
  if (file.type === "video/mp4" || /\.mp4$/i.test(file.name)) return "mp4";
  if (file.type === "video/webm" || /\.webm$/i.test(file.name)) return "webm";
  return null;
}

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
  if (!type) return say("addStatus", "The bank takes MP4 or WebM files. Export this one as MP4 and try again.", "bad");
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
  $<HTMLInputElement>("title").value = file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
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

// ---- Starter clips ----

$("seed").addEventListener("click", async () => {
  if (!dir || busy) return;
  busy = true;
  syncButtons();
  const log = $("seedLog");
  log.replaceChildren();
  const note = (text: string, tone: "good" | "bad" | "" = "") => {
    const li = document.createElement("li");
    li.textContent = text;
    if (tone) li.className = tone;
    log.appendChild(li);
    return li;
  };
  const progress = $<HTMLProgressElement>("progress");
  for (const s of STARTERS) {
    const index = await readIndex(dir);
    if (index.error !== null) { note(index.error, "bad"); break; }
    if (index.data.clips.some((c) => c.title === s.title)) { note(`${s.title}: already in the bank.`); continue; }
    const line = note(`${s.title}: finding the people and things...`);
    const response = await fetch(`/_clips/${s.file}`).catch(() => null);
    const kind = response?.headers.get("content-type") ?? "";
    if (!response?.ok || !kind.startsWith("video/")) { line.textContent = `${s.title}: ${s.file} is not in app/public/_clips.`; line.className = "bad"; continue; }
    const file = new File([await response.blob()], s.file, { type: kind.split(";")[0] });
    const type = videoType(file);
    const found = type ? await analyse(file, (share) => { progress.value = share; }) : { data: null, error: "Not an MP4 or WebM file." };
    if (found.error !== null) { line.textContent = `${s.title}: ${found.error}`; line.className = "bad"; continue; }
    await showCast(found.data.guides);
    const added = await addToBank(dir, file, type!, found.data.guides, s.title, s.credit);
    if (added.error !== null) { line.textContent = `${s.title}: ${added.error}`; line.className = "bad"; continue; }
    line.textContent = `${s.title}: added as ${added.data.entry.id}, ${describe(added.data.entry)}.`;
    line.className = "good";
    await showBank();
  }
  note("Done.");
  busy = false;
  syncButtons();
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

syncButtons();
