// The Chamberlain's desk (review.html, dev server only): reviews clips sent with Submit your own.
// For each pending submission it downloads the video through the dev server (review-dev-server.ts), reads it
// for people and things with the game's own calls, grabs four frames and asks the Chamberlain, a LangChain
// deep agent (review-agent.ts). Clips it approves are written into the bank folder, whose index.json change
// the deploy watcher publishes; ones it is unsure about wait under "Needs you" for Aaron's yes. Approving and
// turning away by hand need only the Supabase key; the Chamberlain also needs the model key.

import type { Guide } from "../../clip/src/index.ts";
import { addClip, analyseClip, bankLock, mayWrite, pickFolder, readIndex, rememberFolder, rememberedFolder, seek, videoType, whenReady, writeIndex, type Found, type Result, type VideoType } from "./bankLabCore.ts";
import { cleanText, withClip } from "./bankIndex.ts";
import { jesterBars } from "./ui/jesterBar.ts";

interface Finding { from: string; text: string }
interface Logged { verdict: "approved" | "rejected" | "ask_a_person"; reason: string; title: string | null; steps?: string[]; findings?: Finding[]; framesCheck?: string }
interface Pending { id: string; created_at: string; video_path: string; title: string | null; credit: string | null; logged: Logged | null }
type NameCheck = "fits" | "does_not_fit" | "inappropriate" | "missing";
interface Decision { verdict: "approve" | "reject" | "ask_a_person"; reason: string; nameCheck: NameCheck; nameNote: string; framesCheck: string; findings: Finding[]; steps: string[] }
interface Status { missing: string[]; canQueue: boolean; canJudge: boolean; model: string; bankFolder: string | null; envFile: string | null; publish: { state: string; at: string | null; detail: string } }
interface LogLine { title: string | null; verdict: string; by: string; reason: string; bankId?: string; at: string }

const SUBMITTED_CREDIT = "Sent in with Submit your own";
const FRAME_WIDTH = 384;
const ENV_FILE = "jester-deploy/.env.review";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>("deskVideo");
const bar = $<HTMLProgressElement>("deskBar");

let dir: FileSystemDirectoryHandle | null = null;
let remembered: FileSystemDirectoryHandle | null = null;
let status: Status | null = null;
let busy = false;

const pressed = (id: string) => $(id).getAttribute("aria-pressed") === "true";
function problem(text: string | null) {
  const el = $("deskProblem");
  el.textContent = text ?? "";
  el.hidden = !text;
}
let statusBase = "";
const setStatus = (text: string) => { statusBase = text; $("deskStatus").textContent = text; };

/** The dev server's review queue. Every answer is { data, error }. */
async function api<T>(route: string, body?: unknown): Promise<Result<T>> {
  try {
    const response = await fetch(`/__review/${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-jester-review": "1", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return (await response.json()) as Result<T>;
  } catch {
    return { data: null, error: "The review queue is not on this dev server. Start it with the jester-bank launch settings." };
  }
}

// ---- The bank folder ----

function syncFolder() {
  const button = $<HTMLButtonElement>("deskFolder");
  button.textContent = dir ? `Writing to "${dir.name}"` : remembered ? `Use "${remembered.name}" again` : "Pick the bank folder";
}

$("deskFolder").addEventListener("click", async () => {
  problem(null);
  if (busy) return problem("Wait for the review to finish before switching folders.");
  let handle = remembered;
  if (!handle || dir) {
    const picked = await pickFolder();
    if (picked.error !== null) return problem(picked.error);
    if (!picked.data) return;
    handle = picked.data;
  }
  if (status?.bankFolder && handle.name !== status.bankFolder) return problem(`Pick the folder "${status.bankFolder}": it is the bank this dev server serves and the deploy publishes.`);
  if (!(await mayWrite(handle))) return problem("This page may not write to that folder. Pick it again and choose Allow.");
  dir = handle;
  remembered = handle;
  await rememberFolder(handle);
  syncFolder();
  await showBank();
  syncAuto();
});

// ---- Reading a submission ----

/** The analysis facts the Chamberlain reads: who was found, for how much of the stretch, and why anyone was left out. */
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

/** `count` small JPEG frames spread across the stretch a round plays: exactly what is sent to the model. */
async function framesOf(g: Guide, count = 4): Promise<string[]> {
  video.pause();
  await whenReady(video);
  const canvas = document.createElement("canvas");
  const w = video.videoWidth || FRAME_WIDTH, h = video.videoHeight || Math.round(FRAME_WIDTH * 9 / 16);
  canvas.width = Math.min(FRAME_WIDTH, w);
  canvas.height = Math.round(canvas.width * (h / w));
  const ctx = canvas.getContext("2d")!;
  const frames: string[] = [];
  for (let i = 0; i < count; i++) {
    await seek(video, (g.range.startMs + ((i + 0.5) / count) * (g.range.endMs - g.range.startMs)) / 1000);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    frames.push(canvas.toDataURL("image/jpeg", 0.7));
  }
  return frames;
}

/** Read and analysed submissions, kept so approving by hand does not read a clip twice. */
const readied = new Map<string, { file: File; type: VideoType; found: Found }>();

/** A failure that says nothing about the clip (a dropped download, a model that did not load): try again later. */
const TRANSIENT = /did not download|did not load|Check the connection|Reload the page/;

let ownUrl: string | null = null;
/** Points the reading video back at `file`, since reading another clip moved it. Frames and posters come from it. */
async function pointAt(file: File) {
  if (ownUrl) URL.revokeObjectURL(ownUrl);
  ownUrl = URL.createObjectURL(file);
  video.src = ownUrl;
  await whenReady(video);
}

async function readySubmission(p: Pending): Promise<Result<{ file: File; type: VideoType; found: Found }>> {
  const known = readied.get(p.id);
  if (known) {
    await pointAt(known.file);
    return { data: known, error: null };
  }
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
  bar.hidden = false;
  const found = await analyseClip(file, video, (share) => { bar.value = share; });
  bar.hidden = true;
  if (found.error !== null) return found;
  const ready = { file, type, found: found.data };
  readied.set(p.id, ready);
  return { data: ready, error: null };
}

// ---- Duplicates ----

/**
 * The bank clip that already holds this exact video, if any. Bank ids end in the start of the clip's
 * fingerprint (bankIdFor) and each clip's guides.json carries all of it, so the check is exact.
 */
async function alreadyInBank(fingerprint: string, folder: FileSystemDirectoryHandle | null): Promise<{ id: string; title: string } | null> {
  if (!folder) return null;
  const index = await readIndex(folder);
  if (index.error !== null) return null;
  const ends = new RegExp(`-${fingerprint.slice(0, 6)}(?:[0-9a-f]*|-\\d+)$`);
  for (const clip of index.data.clips.filter((c) => ends.test(c.id))) {
    try {
      const file = await (await (await folder.getDirectoryHandle(clip.id)).getFileHandle("guides.json")).getFile();
      const guides = JSON.parse(await file.text()) as { fingerprint?: string }[];
      if (guides.length > 0 && guides.every((g) => g.fingerprint === fingerprint)) return { id: clip.id, title: clip.title };
    } catch {
      // A clip folder that cannot be read is not a match.
    }
  }
  return null;
}

/**
 * Clips still pending in this page session, by fingerprint, so a second copy of one is caught. A clip never
 * matches itself (a retry after a failed review), and one that was turned away is forgotten, so its sender can
 * send it again under a better name. Approved ones are caught by the bank check instead.
 */
const pendingByPrint = new Map<string, { id: string; label: string }>();
const forget = (id: string) => { for (const [fp, e] of pendingByPrint) if (e.id === id) pendingByPrint.delete(fp); };

// ---- Decisions ----

async function approve(p: Pending, title: string, by: "agent" | "aaron", d: Partial<Decision> = {}, into: FileSystemDirectoryHandle | null = dir): Promise<Result<string>> {
  // One folder for the whole decision, even if the folder button is pressed meanwhile.
  const folder = into;
  if (!folder) return { data: null, error: `Pick the bank folder${status?.bankFolder ? ` "${status.bankFolder}"` : ""} first: approved clips go there.` };
  const ready = await readySubmission(p);
  if (ready.error !== null) return ready;
  const twin = await alreadyInBank(ready.data.found.guides[0]!.fingerprint, folder);
  if (twin) return { data: null, error: `This video is already in the bank as "${twin.title}". Turn this copy away.` };
  const name = cleanText(title, 80);
  if (!name) return { data: null, error: "Name the move or dance first." };
  const added = await addClip(folder, video, ready.data.file, ready.data.type, ready.data.found.guides, name, cleanText(p.credit ?? "", 60) || SUBMITTED_CREDIT);
  if (added.error !== null) return added;
  const saved = await api("decide", {
    id: p.id, video_path: p.video_path, title: added.data.entry.title, status: "approved", by, bankId: added.data.entry.id,
    reason: d.reason ?? "Let in by hand.", steps: d.steps, findings: d.findings, framesCheck: d.framesCheck,
  });
  if (saved.error !== null) return { data: null, error: `It is in the bank folder as ${added.data.entry.id}, but the queue did not save that: ${saved.error}` };
  readied.delete(p.id);
  forget(p.id);
  return { data: added.data.entry.id, error: null };
}

async function reject(p: Pending, by: "agent" | "aaron" | "check", reason: string, d: Partial<Decision> = {}): Promise<Result<unknown>> {
  const saved = await api("decide", { id: p.id, video_path: p.video_path, title: p.title, status: "rejected", by, reason, steps: d.steps, findings: d.findings, framesCheck: d.framesCheck });
  if (saved.error === null) forget(p.id);
  return saved;
}

// ---- Showing the Chamberlain's work ----

function showWork(p: Pending, line: string) {
  $("deskWork").hidden = false;
  $("workTitle").textContent = `${p.title ?? "Untitled clip"}${p.credit ? ` (${p.credit})` : ""}: ${line}`;
  for (const id of ["workFrames", "workPlan"]) $(id).replaceChildren();
  for (const id of ["workFinding", "workName", "workSaw", "workDecision"]) $(id).textContent = "";
}

function showFrames(frames: string[]) {
  const box = $("workFrames");
  box.replaceChildren(...frames.map((src, i) => Object.assign(document.createElement("img"), { src, alt: `Frame ${i + 1} sent to the Chamberlain`, width: 192 })));
}

const NAME_WORDS: Record<NameCheck, string> = { fits: "fits the clip", does_not_fit: "does not fit the clip", inappropriate: "is not appropriate", missing: "is missing" };

function showDecision(d: Decision, outcome: string, title: string | null) {
  $("workPlan").replaceChildren(...d.steps.map((s) => {
    const li = document.createElement("li");
    li.className = "step";
    const b = document.createElement("b");
    b.textContent = s;
    li.appendChild(b);
    return li;
  }));
  $("workFinding").textContent = d.findings.map((f) => `The ${f.from.replace(/-/g, " ")}: ${f.text}`).join(" ") || "The playability checker did not answer.";
  $("workName").textContent = title ? `The name "${title}" ${NAME_WORDS[d.nameCheck]}. ${d.nameNote}` : `No name was given. ${d.nameNote}`;
  $("workSaw").textContent = d.framesCheck ? `In the frames: ${d.framesCheck}` : "";
  $("workDecision").textContent = outcome;
}

// ---- Reviewing the queue ----

async function reviewQueue() {
  // Taken before the first wait, so two runs (the minute timer, a click, startup) or a run and a hand decision
  // never overlap.
  if (busy) return;
  busy = true;
  $<HTMLButtonElement>("deskReview").disabled = true;
  let letIn = 0;
  try {
    problem(null);
    const s = await api<Status>("status");
    if (s.error !== null) return problem(s.error);
    status = s.data;
    if (!status.canQueue) return problem(`Put ${status.missing.join(" and ")} in ${ENV_FILE}. No restart needed.`);
    // One folder for the whole run: the folder button is refused while a review runs.
    const folder = dir;
    if (!folder) return problem(`Pick the bank folder${status.bankFolder ? ` "${status.bankFolder}"` : ""} first: approved clips go there.`);
    const pending = await api<Pending[]>("pending");
    if (pending.error !== null) return problem(pending.error);
    renderNeedsYou(pending.data);
    const fresh = status.canJudge ? pending.data.filter((p) => !p.logged) : [];
    if (fresh.length === 0) {
      setStatus(status.canJudge ? `Checked at ${new Date().toLocaleTimeString()}: nothing new.` : "The Chamberlain has no model key, so every clip waits for you below.");
      return;
    }
    for (const [n, p] of fresh.entries()) {
      setStatus(`Reviewing ${n + 1} of ${fresh.length}...`);
      showWork(p, "reading the clip...");
      const ready = await readySubmission(p);
      if (ready.error !== null && TRANSIENT.test(ready.error)) {
        $("workDecision").textContent = `${ready.error} It stays in the queue for next time.`;
        continue;
      }
      if (ready.error !== null) {
        // The game's own analysis cannot use it (or no video arrived): no need to ask the Chamberlain.
        const saved = await reject(p, "check", ready.error);
        $("workDecision").textContent = saved.error === null ? `Turned away by the analysis: ${ready.error}` : saved.error;
        continue;
      }
      // The same video sent twice (Lisa's double send), or one already in the bank: turned away, no model call.
      const fingerprint = ready.data.found.guides[0]!.fingerprint;
      const twin = await alreadyInBank(fingerprint, folder);
      const seen = pendingByPrint.get(fingerprint);
      const earlier = seen && seen.id !== p.id ? seen.label : null;
      if (twin || earlier) {
        const why = twin ? `Same video as "${twin.title}", already in the bank.` : `Same video as ${earlier}, sent earlier and still waiting.`;
        const saved = await reject(p, "check", why);
        $("workDecision").textContent = saved.error === null ? `Turned away as a copy. ${why}` : saved.error;
        continue;
      }
      pendingByPrint.set(fingerprint, { id: p.id, label: p.title ? `"${p.title}"` : "another clip" });
      const frames = await framesOf(ready.data.found.guides[0]!);
      showFrames(frames);
      $("workTitle").textContent = `${p.title ?? "Untitled clip"}: the Chamberlain is looking at it...`;
      const judged = await api<Decision>("judge", { title: p.title, credit: p.credit, facts: factsOf(ready.data.found), frames });
      if (judged.error !== null) { problem(`${judged.error} It stays in the queue for next time.`); continue; }
      const d = judged.data;
      // The Chamberlain only approves under the submitter's own name (review-agent.ts enforces it).
      if (d.verdict === "approve" && p.title && !pressed("deskAskFirst")) {
        const added = await approve(p, p.title, "agent", d, folder);
        if (added.error === null) letIn++;
        showDecision(d, added.error === null ? `Let in as "${p.title}". ${d.reason}` : added.error, p.title);
      } else if (d.verdict === "reject") {
        const saved = await reject(p, "agent", d.reason, d);
        showDecision(d, saved.error === null ? `Turned away. ${d.reason}` : saved.error, p.title);
      } else {
        const reason = d.verdict === "approve" ? `The Chamberlain would let it in: ${d.reason}` : d.reason;
        const saved = await api("flag", { id: p.id, video_path: p.video_path, title: p.title, reason, steps: d.steps, findings: d.findings, framesCheck: d.framesCheck });
        showDecision(d, saved.error === null ? `Waiting for you. ${reason}` : saved.error, p.title);
      }
    }
    setStatus(`Reviewed at ${new Date().toLocaleTimeString()}.`);
    void showPublish();
    const after = await api<Pending[]>("pending");
    if (after.error === null) renderNeedsYou(after.data);
  } catch (err) {
    problem(`The review stopped: ${(err as Error).message}`);
  } finally {
    busy = false;
    bar.hidden = true;
    $<HTMLButtonElement>("deskReview").disabled = false;
  }
  if (letIn > 0) await showBank();
  await showLog();
}

// ---- Needs you: the human approval step ----

function ask(question: string): Promise<boolean> {
  const dialog = $<HTMLDialogElement>("approveDialog");
  $("approveAsk").textContent = question;
  return new Promise((resolve) => {
    const done = (yes: boolean) => { dialog.close(); resolve(yes); };
    $("approveYes").onclick = () => done(true);
    $("approveNo").onclick = () => done(false);
    dialog.oncancel = () => resolve(false);
    dialog.showModal();
  });
}

/** Waiting for the Chamberlain: new clips it has not looked at yet. Not a person's job unless it hands one over. */
function renderQueue(pending: Pending[]) {
  const fresh = status?.canJudge ? pending.filter((p) => !p.logged) : [];
  const list = $("deskQueue");
  list.replaceChildren();
  $("deskQueueCount").textContent = fresh.length === 0 ? "Nothing new." : `${fresh.length} new ${fresh.length === 1 ? "clip" : "clips"}, reviewed next.`;
  for (const p of fresh) {
    const li = document.createElement("li");
    li.textContent = `${p.title ? `"${p.title}"` : "No name"}${p.credit ? `, by ${p.credit}` : ""}, sent at ${new Date(p.created_at).toLocaleTimeString()}`;
    list.appendChild(li);
  }
}

function renderNeedsYou(pending: Pending[]) {
  const box = $("needsYou");
  box.replaceChildren();
  // Waiting: what the Chamberlain left for a person, and with no model key every clip it has not seen.
  renderQueue(pending);
  // Needs you: what the Chamberlain handed to a person. With no model key it cannot review, so every new clip
  // is a person's to decide too.
  const waiting = pending.filter((p) => p.logged?.verdict === "ask_a_person" || (!p.logged && status !== null && !status.canJudge));
  if (waiting.length === 0) {
    const none = document.createElement("p");
    none.className = "typed";
    none.textContent = "Nothing waiting.";
    box.appendChild(none);
    return;
  }
  for (const p of waiting) {
    const card = document.createElement("article");
    card.className = "print";
    const name = document.createElement("p");
    name.className = "typed";
    name.textContent = `${p.title ? `Sent in as "${p.title}"` : "Sent in with no name"}${p.credit ? `, by ${p.credit}` : ""}`;
    const field = document.createElement("label");
    field.className = "field";
    const fieldLabel = document.createElement("span");
    fieldLabel.textContent = "Name the move or dance";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.maxLength = 80;
    nameInput.autocomplete = "off";
    nameInput.value = cleanText(p.title ?? "", 80);
    field.append(fieldLabel, nameInput);
    const clip = document.createElement("video");
    clip.controls = true;
    clip.playsInline = true;
    clip.preload = "metadata";
    clip.width = 360;
    clip.src = `/__review/video?path=${encodeURIComponent(p.video_path)}`;
    const why = document.createElement("p");
    why.className = "aside";
    why.textContent = p.logged ? `The Chamberlain: ${p.logged.reason}` : "Not seen by the Chamberlain (no model key). Name it and decide yourself.";
    const result = document.createElement("p");
    result.className = "problem";
    result.setAttribute("role", "alert");
    result.hidden = true;
    const row = document.createElement("div");
    row.className = "row-actions";
    const no = document.createElement("button");
    no.type = "button";
    no.className = "btn btn-quiet";
    no.textContent = "Turn it away";
    const yes = document.createElement("button");
    yes.type = "button";
    yes.className = "btn btn-main";
    yes.innerHTML = '<span class="ticket"><span class="ticket-text"></span></span>';
    yes.querySelector(".ticket-text")!.textContent = "Let it in";
    const act = async (fn: () => Promise<Result<unknown>>) => {
      if (busy) return;
      busy = true;
      yes.disabled = no.disabled = true;
      try {
        const r = await fn();
        if (r.error !== null) { result.textContent = r.error; result.hidden = false; return; }
        card.remove();
        await showLog();
        void showPublish();
      } finally {
        busy = false;
        yes.disabled = no.disabled = false;
      }
    };
    yes.addEventListener("click", async () => {
      const title = cleanText(nameInput.value, 80);
      if (!title) { result.textContent = "Name the move or dance first."; result.hidden = false; nameInput.focus(); return; }
      if (await ask(`Let "${title}" into the bank? Everyone playing on the site can pick it a few minutes later.`)) {
        void act(() => approve(p, title, "aaron", { reason: title === p.title ? "Let in by hand." : `Let in by hand, named "${title}".` })).then(() => showBank());
      }
    });
    no.addEventListener("click", () => void act(() => reject(p, "aaron", "Turned away by hand.")));
    row.append(no, yes);
    card.append(name, clip, why, field, row, result);
    box.appendChild(card);
  }
}

/** Clips already in the bank, each with its name to fix. Saving rewrites index.json and publishes the bank. */
async function showBank() {
  const list = $("deskBank");
  list.replaceChildren();
  if (!dir) return;
  const folder = dir;
  const index = await readIndex(folder);
  if (index.error !== null) return problem(index.error);
  if (index.data.clips.length === 0) {
    const none = document.createElement("p");
    none.className = "typed";
    none.textContent = "The bank is empty.";
    list.appendChild(none);
    return;
  }
  for (const clip of index.data.clips) {
    const card = document.createElement("article");
    card.className = "print";
    const field = document.createElement("label");
    field.className = "field";
    const label = document.createElement("span");
    label.textContent = `Name (${clip.people} ${clip.people === 1 ? "person" : "people"}, ${(clip.durationMs / 1000).toFixed(1)} s, ${clip.credit})`;
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 80;
    input.autocomplete = "off";
    input.value = clip.title;
    field.append(label, input);
    const save = document.createElement("button");
    save.type = "button";
    save.className = "btn btn-quiet";
    save.textContent = "Save the name";
    const note = document.createElement("p");
    note.className = "aside";
    save.addEventListener("click", async () => {
      const title = cleanText(input.value, 80);
      if (!title) { note.textContent = "A clip needs a name."; return; }
      if (title === clip.title) { note.textContent = "That is already its name."; return; }
      save.disabled = true;
      try {
        // One bank change at a time, so a rename and an approval never overwrite each other's index.json.
        const saved = await bankLock(async (): Promise<string | null> => {
          const latest = await readIndex(folder);
          if (latest.error !== null) return latest.error;
          const now = latest.data.clips.find((c) => c.id === clip.id);
          if (!now) return "That clip is not in the bank any more.";
          await writeIndex(folder, withClip(latest.data, { ...now, title }));
          return null;
        });
        if (saved !== null) { note.textContent = saved; return; }
        await api("publish", {});
        clip.title = title;
        input.value = title;
        note.textContent = `Renamed to "${title}". The site shows it after the bank publishes, in about half a minute.`;
        void showPublish();
      } catch (err) {
        note.textContent = `Saving the name failed: ${(err as Error).message}`;
      } finally {
        save.disabled = false;
      }
    });
    card.append(field, save, note);
    list.appendChild(card);
  }
}

/** How the last publish of the bank went (an approval publishes it a few seconds later). */
async function showPublish(tries = 12) {
  const s = await api<Status>("status");
  if (s.error !== null || s.data.publish.state === "idle") return;
  $("deskStatus").textContent = `${statusBase} ${s.data.publish.detail}`;
  if ((s.data.publish.state === "waiting" || s.data.publish.state === "running") && tries > 0) setTimeout(() => void showPublish(tries - 1), 5000);
}

async function showLog() {
  const log = await api<LogLine[]>("log");
  const list = $("deskLog");
  list.replaceChildren();
  if (log.error !== null) return;
  const words: Record<string, string> = { approved: "Let in", rejected: "Turned away", ask_a_person: "Left for you" };
  const who: Record<string, string> = { agent: "the Chamberlain", aaron: "you", check: "the analysis" };
  for (const e of log.data.slice(0, 15)) {
    const li = document.createElement("li");
    li.textContent = `${words[e.verdict] ?? e.verdict}${e.bankId ? ` as ${e.bankId}` : ""}: ${e.title ?? "untitled"}, by ${who[e.by] ?? e.by} at ${new Date(e.at).toLocaleTimeString()}. ${e.reason}`;
    list.appendChild(li);
  }
}

// ---- Wiring ----

$("deskReview").addEventListener("click", () => void reviewQueue());
let timer = 0;
/** Keeps the Chamberlain working on its own: reviews new clips now and every minute while the chip is pressed. */
function syncAuto() {
  clearInterval(timer);
  timer = 0;
  if (!pressed("deskAuto") || !dir || !status?.canJudge) return;
  void reviewQueue();
  timer = window.setInterval(() => { if (dir) void reviewQueue(); }, 60000);
}
$("deskAuto").addEventListener("click", () => {
  $("deskAuto").setAttribute("aria-pressed", String(!pressed("deskAuto")));
  syncAuto();
});
$("deskAskFirst").addEventListener("click", () => {
  $("deskAskFirst").setAttribute("aria-pressed", String(!pressed("deskAskFirst")));
});

jesterBars();
void rememberedFolder().then(async (handle) => {
  remembered = handle;
  // Already allowed in this browser: use it straight away, so the bank list shows without a click.
  const permission = handle as unknown as { queryPermission?: (d: { mode: "readwrite" }) => Promise<PermissionState> } | null;
  if (handle && (await permission?.queryPermission?.({ mode: "readwrite" }).catch(() => "denied")) === "granted"
      && (!status?.bankFolder || handle.name === status.bankFolder)) {
    dir = handle;
    await showBank();
  }
  syncFolder();
  syncAuto();
});
void api<Status>("status").then(async (s) => {
  if (s.error !== null) return problem(s.error);
  status = s.data;
  if (!status.canQueue) setStatus(`Not ready: put ${status.missing.join(" and ")} in ${ENV_FILE}.`);
  else if (!status.canJudge) setStatus("Ready to decide by hand. Add ANTHROPIC_API_KEY to let the Chamberlain review on its own.");
  else setStatus(`Ready. The Chamberlain runs on ${status.model} and reviews new clips on its own every minute while this page is open.`);
  if (status.canQueue) {
    const pending = await api<Pending[]>("pending");
    if (pending.error === null) {
      renderNeedsYou(pending.data);
    }
  }
  await showLog();
  syncAuto();
});
