// "Submit your own": a player offers a clip for the video bank. The video goes to the private Supabase
// bucket `submissions` under a random name, and one row in table `submissions` says what it is. Nothing is
// read back: the page's key may add a video and a row but never list, read or change them. A person on
// the team reviews each one by hand, and an approved clip joins the bank through the bank lab.

import { createClient } from "@supabase/supabase-js";

const MAX_BYTES = 25 * 1024 * 1024;
const BUCKET = "submissions";
const TABLE = "submissions";
const TYPES = { mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime" } as const;
type Kind = keyof typeof TYPES;

const NOT_A_VIDEO = "That file is not a video.";
const TOO_BIG = "That video is over 25 MB. Trim it and try again.";
const WRONG_KIND = "Jester takes MP4, WebM or MOV videos. Save it as one of those and try again.";
const NO_NAME = "Give your clip a name.";
const TITLE_TOO_LONG = "Keep the name to 80 characters or fewer.";
const CREDIT_TOO_LONG = "Keep the credit to 60 characters or fewer.";
const NOT_SET_UP = "Submitting is not set up on this copy of the game.";
const UPLOAD_FAILED = "The video did not upload. Check your connection and try again.";
const SAVE_FAILED = "The video uploaded but its details did not save. Try again.";

/** The file's kind from its type, or from its name when the browser gave no type. */
function kindOf(file: File): Kind | "other video" | null {
  const type = file.type.toLowerCase();
  if (type === "video/mp4") return "mp4";
  if (type === "video/webm") return "webm";
  if (type === "video/quicktime") return "mov";
  if (type.startsWith("video/")) return "other video";
  if (type !== "") return null;
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  if (ext === "mp4" || ext === "m4v") return "mp4";
  if (ext === "webm") return "webm";
  if (ext === "mov") return "mov";
  return null;
}

/** Trimmed, with runs of spaces made one; empty becomes null. */
const tidy = (text: string | undefined) => {
  const t = (text ?? "").trim().replace(/\s+/g, " ");
  return t === "" ? null : t;
};

/** Uploads with progress (fetch cannot report it), with the same headers the Supabase client sends. */
function upload(url: string, key: string, path: string, body: Blob, onProgress?: (share: number) => void): Promise<boolean> {
  return new Promise((resolve) => {
    const form = new FormData();
    form.append("cacheControl", "3600");
    form.append("", body, path);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${url.replace(/\/+$/, "")}/storage/v1/object/${BUCKET}/${path}`);
    xhr.setRequestHeader("apikey", key);
    xhr.setRequestHeader("Authorization", `Bearer ${key}`);
    xhr.setRequestHeader("x-upsert", "false");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(Math.min(0.99, e.loaded / e.total)); };
    xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300);
    xhr.onerror = () => resolve(false);
    xhr.ontimeout = () => resolve(false);
    xhr.send(form);
  });
}

/**
 * Offers `file` for the video bank. `onProgress` runs from 0 to 1 while the video uploads. On success the
 * id is the random name the video was saved under (without its file type).
 */
export async function submitClip(
  file: File,
  info: { title: string; credit?: string },
  onProgress?: (share: number) => void,
): Promise<{ data: { id: string }; error: null } | { data: null; error: string }> {
  const kind = kindOf(file);
  if (kind === null || file.size === 0) return { data: null, error: NOT_A_VIDEO };
  if (file.size > MAX_BYTES) return { data: null, error: TOO_BIG };
  if (kind === "other video") return { data: null, error: WRONG_KIND };
  const title = tidy(info.title), credit = tidy(info.credit);
  // The name is what the bank shows; the Chamberlain checks that it fits the clip.
  if (!title) return { data: null, error: NO_NAME };
  if (title.length > 80) return { data: null, error: TITLE_TOO_LONG };
  if (credit && credit.length > 60) return { data: null, error: CREDIT_TOO_LONG };

  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!url || !key) return { data: null, error: NOT_SET_UP };

  const id = crypto.randomUUID();
  const path = `${id}.${kind}`;
  onProgress?.(0);
  // The bucket accepts only these three types, so the upload names its type even when the browser gave none.
  const uploaded = await upload(url, key, path, file.slice(0, file.size, TYPES[kind]), onProgress);
  if (!uploaded) return { data: null, error: UPLOAD_FAILED };
  onProgress?.(1);

  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  // No .select(): the page's key may add a row but not read one back.
  const { error } = await client.from(TABLE).insert({ video_path: path, title, credit });
  if (error) return { data: null, error: SAVE_FAILED };
  return { data: { id }, error: null };
}
