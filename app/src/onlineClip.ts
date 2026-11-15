// Online rooms with a clip of the host's choice: one from the video bank, or one the host uploads.
//
// Bank clip: the room carries the id ("bank:<id>"); every device loads the same saved guides from the bank
// (static files), so nothing big travels through the room.
// Uploaded clip: only the host's laptop can read the file, so the host finds the people in it (videoScene),
// and sends the guides through the room as media ("scene"). The others play from the guides alone: they see
// the shape to copy, not the source video. That keeps the clip private to the host and works on any Wi-Fi.

import { looksLikeGuide, listBank } from "./bank.ts";
import { bankScene } from "./bankRound.ts";
import type { Scene } from "./blind.ts";
import type { Guide } from "../../clip/src/index.ts";

/** The most text a room carries as one media piece (rooms.mjs MAX_MEDIA_CHARS is 3,000,000). */
const MAX_SCENE_CHARS = 2_900_000;
export const UPLOAD_ID = "upload";
export const BANK_PREFIX = "bank:";
export const bankSceneId = (id: string) => BANK_PREFIX + id;

const TOO_BIG = "That clip is too long to send to your friends. Trim it to about 15 seconds and try again.";
const SCENE_BROKEN = "The clip the host sent is damaged. Ask them to deal again.";
const SCENE_LATE = "The host's clip did not arrive. Check your connection and ask them to deal again.";

type Result<T> = { data: T; error: null } | { data: null; error: string };

/** The host's own analysed upload, kept so the host plays the same scene without reading it back from the room. */
let hostUpload: Scene | null = null;
export const setHostUpload = (scene: Scene | null) => { hostUpload = scene; };
export const getHostUpload = () => hostUpload;

/** A scene as text for the room, or an error when it is too big to send. */
export function packScene(scene: Scene): Result<string> {
  const text = JSON.stringify({ v: 1, name: scene.name, width: scene.width, height: scene.height, startMs: scene.startMs, durationMs: scene.durationMs, guides: scene.guides }, (_k, v) => (typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 10000) / 10000 : v));
  return text.length > MAX_SCENE_CHARS ? { data: null, error: TOO_BIG } : { data: text, error: null };
}

/** The scene packScene made, with no video. */
export function unpackScene(text: string | undefined): Result<Scene> {
  if (!text) return { data: null, error: SCENE_LATE };
  try {
    const j = JSON.parse(text) as Partial<Scene> & { v?: number; guides?: unknown };
    const ok = j.v === 1 && Array.isArray(j.guides) && j.guides.length > 0 && j.guides.every(looksLikeGuide)
      && typeof j.width === "number" && typeof j.height === "number" && typeof j.startMs === "number" && typeof j.durationMs === "number";
    if (!ok) return { data: null, error: SCENE_BROKEN };
    return { data: { name: String(j.name ?? "Your friend's clip"), width: j.width!, height: j.height!, startMs: j.startMs!, durationMs: j.durationMs!, guides: j.guides as Guide[], video: null }, error: null };
  } catch {
    return { data: null, error: SCENE_BROKEN };
  }
}

type RoomLike = { isHost: boolean; hostId: string; media: Map<string, Record<string, string>>; on(event: "update", fn: () => void): () => void };

/** Guest: waits for the host's uploaded clip to come in through the room, then reads it. */
export function waitForUploadedScene(room: RoomLike, maxMs = 90000): Promise<Result<Scene>> {
  const have = () => room.media.get(room.hostId)?.scene;
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); off(); resolve(unpackScene(have())); };
    const timer = window.setTimeout(finish, maxMs);
    const off = room.on("update", () => { if (have()) finish(); });
    if (have()) finish();
  });
}

/** The scene for a bank clip id, on this device. */
export async function sceneFromBank(id: string, video: HTMLVideoElement): Promise<Result<Scene>> {
  const listed = await listBank();
  if (listed.error !== null) return listed;
  const clip = listed.data.find((c) => c.id === id);
  if (!clip) return { data: null, error: "That bank clip is not in your copy of the bank. Ask the host to pick another." };
  return bankScene(clip, video);
}
