// What the bank lab and the Chamberlain's desk share (dev server pages only): the bank folder, remembered once
// picked; reading a clip for its people and things with the game's own calls; and writing a clip into the bank
// (`<id>/clip.<type>`, `<id>/poster.jpg`, `<id>/guides.json`, then `index.json` last).

import type { Guide } from "../../clip/src/index.ts";
import { prepareVideo, subjectGuides } from "./clip.ts";
import { addHands } from "./clipside/hands.ts";
import {
  BANK_SCHEMA, bankEntry, bankIdFor, cleanText, emptyBankIndex, guidesJson, readBankIndex, withClip,
  type BankEntry, type BankIndex,
} from "./bankIndex.ts";

export type Result<T> = { data: T; error: null } | { data: null; error: string };
export type VideoType = "mp4" | "webm";
export interface Found { guides: Guide[]; skipped: { number: number; label?: string; reason: string }[] }

// The folder picker and its permission calls are Chrome and Edge only, so TypeScript's DOM types lack them.
interface WritePermission {
  queryPermission(d: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission(d: { mode: "readwrite" }): Promise<PermissionState>;
}
type FolderPicker = (o: { id: string; mode: "readwrite" }) => Promise<FileSystemDirectoryHandle>;

const POSTER_WIDTH = 640;

// ---- The folder, remembered in IndexedDB so it is picked only once ----

function handleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("jester-bank-lab", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("handles");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function rememberFolder(handle: FileSystemDirectoryHandle) {
  try {
    const db = await handleDb();
    db.transaction("handles", "readwrite").objectStore("handles").put(handle, "bank");
  } catch {
    // Remembering is a convenience: without it the folder is picked again next time.
  }
}

export async function rememberedFolder(): Promise<FileSystemDirectoryHandle | null> {
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

/** Asks (once per visit) to write into `handle`. Needs a click when the browser has not allowed it yet. */
export async function mayWrite(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const permission = handle as unknown as WritePermission;
  return (await permission.queryPermission({ mode: "readwrite" })) === "granted"
    || (await permission.requestPermission({ mode: "readwrite" })) === "granted";
}

/** The browser's folder picker, or the sentence why not. Null when the person cancelled. */
export async function pickFolder(): Promise<{ data: FileSystemDirectoryHandle | null; error: null } | { data: null; error: string }> {
  const picker = (window as unknown as { showDirectoryPicker?: FolderPicker }).showDirectoryPicker;
  if (!picker) return { data: null, error: "This browser cannot pick a folder. Use Chrome or Edge on a computer." };
  try {
    return { data: await picker({ id: "jester-bank", mode: "readwrite" }), error: null };
  } catch {
    return { data: null, error: null };
  }
}

// ---- Files in the folder ----

export async function writeFile(folder: FileSystemDirectoryHandle, name: string, data: Blob | string) {
  const handle = await folder.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

export async function readIndex(folder: FileSystemDirectoryHandle): Promise<Result<BankIndex>> {
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

export const writeIndex = (folder: FileSystemDirectoryHandle, index: BankIndex) => writeFile(folder, "index.json", JSON.stringify(index, null, 2) + "\n");

// ---- Reading a clip ----

/**
 * How the bank stores the file. A phone's MOV is the same container as MP4 (browsers read both with one
 * reader), so it goes in as clip.mp4; reading it for moves shows that it decodes.
 */
export function videoType(file: File): VideoType | null {
  if (file.type === "video/mp4" || /\.(mp4|m4v)$/i.test(file.name)) return "mp4";
  if (file.type === "video/quicktime" || /\.mov$/i.test(file.name)) return "mp4";
  if (file.type === "video/webm" || /\.webm$/i.test(file.name)) return "webm";
  return null;
}

/** A title from a file name: no file type, dashes and underscores as spaces. */
export const titleFrom = (name: string) => name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim().replace(/\s+/g, " ").slice(0, 80) || "Untitled clip";

/** People and things in the clip, by the calls blind mode uses. `video` is left pointing at the file. */
export async function analyseClip(file: File, video: HTMLVideoElement, onProgress: (share: number) => void): Promise<Result<Found>> {
  video.pause();
  const prepared = await prepareVideo(file, video, (share) => onProgress(share * 0.8), { things: true });
  if (prepared.error !== null) return { data: null, error: prepared.error };
  const found = subjectGuides(prepared.data);
  if (found.guides.length === 0) return { data: null, error: found.skipped[0]?.reason ?? "No one to copy in this clip." };
  // Finger detail for every person in the clip (a second pass at a larger size).
  const guides = await addHands(found.guides, file, video, (share) => onProgress(0.8 + share * 0.2));
  return { data: { ...found, guides }, error: null };
}

export function whenReady(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve) => {
    video.addEventListener("loadeddata", () => resolve(), { once: true });
    setTimeout(resolve, 5000);
  });
}

export function seek(video: HTMLVideoElement, seconds: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => resolve();
    video.addEventListener("seeked", done, { once: true });
    setTimeout(done, 3000);
    video.currentTime = seconds;
  });
}

// ---- Writing a clip into the bank ----

let bankQueue: Promise<unknown> = Promise.resolve();
/**
 * Runs bank changes one at a time on this page: each reads index.json, changes it and writes it back, so two at
 * once (an approval and a rename) would each write their own copy and one would be lost.
 */
export function bankLock<T>(change: () => Promise<T>): Promise<T> {
  const run = bankQueue.then(change, change);
  bankQueue = run.catch(() => {});
  return run;
}

async function posterOf(video: HTMLVideoElement, g: Guide): Promise<Blob> {
  video.pause();
  await whenReady(video);
  await seek(video, (g.range.startMs + g.range.endMs) / 2000);
  const scale = Math.min(1, POSTER_WIDTH / (video.videoWidth || POSTER_WIDTH));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round((video.videoWidth || POSTER_WIDTH) * scale);
  canvas.height = Math.round((video.videoHeight || POSTER_WIDTH * 9 / 16) * scale);
  canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("no poster"))), "image/jpeg", 0.82));
}

/** Writes the clip's files, then its index entry last, so a clip that fails halfway never shows up in the game. */
export function addClip(folder: FileSystemDirectoryHandle, video: HTMLVideoElement, file: File, type: VideoType, guides: Guide[], title: string, credit: string): Promise<Result<{ entry: BankEntry; guidesBytes: number }>> {
  return bankLock(() => addClipNow(folder, video, file, type, guides, title, credit));
}

async function addClipNow(folder: FileSystemDirectoryHandle, video: HTMLVideoElement, file: File, type: VideoType, guides: Guide[], title: string, credit: string): Promise<Result<{ entry: BankEntry; guidesBytes: number }>> {
  // The name players see: refused when nothing is left of it after cleaning (only spaces or invisible characters).
  if (!cleanText(title, 80)) return { data: null, error: "Give your clip a name." };
  const index = await readIndex(folder);
  if (index.error !== null) return index;
  const g = guides[0]!;
  // A backend id: the title as a slug plus a piece of the clip's fingerprint. Players only ever see the title.
  const id = bankIdFor(cleanText(title, 80), g.fingerprint, index.data.clips.map((c) => c.id));
  try {
    const clipFolder = await folder.getDirectoryHandle(id, { create: true });
    await writeFile(clipFolder, `clip.${type}`, file);
    await writeFile(clipFolder, "poster.jpg", await posterOf(video, g));
    const json = guidesJson(guides);
    await writeFile(clipFolder, "guides.json", json);
    const entry = bankEntry({
      id, title, credit,
      durationMs: Math.round(g.range.endMs - g.range.startMs),
      people: guides.filter((x) => x.subject.kind === "person").length,
      things: guides.filter((x) => x.subject.kind === "thing").length,
    }, type);
    const latest = await readIndex(folder);
    if (latest.error !== null) return latest;
    await writeIndex(folder, withClip(latest.data, entry));
    return { data: { entry, guidesBytes: json.length }, error: null };
  } catch (err) {
    return { data: null, error: `Writing to the bank folder failed: ${(err as Error).message}` };
  }
}

export const describe = (e: BankEntry) => `${e.people} ${e.people === 1 ? "person" : "people"}, ${e.things} ${e.things === 1 ? "thing" : "things"}, ${(e.durationMs / 1000).toFixed(1)} s`;
