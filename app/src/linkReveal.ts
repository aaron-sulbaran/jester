// LINK REVEAL: play a link lab grab (a YouTube clip read through tab capture) as a blind mode game, and
// show its reveal over the real YouTube player. YouTube does not let a page copy its frames, so this
// reveal is live on the page (not recorded): the clip plays once as it was, then again with each played
// subject blurred out (CSS backdrop blur over the player) and the players drawn in their place.
//
// Self-contained on purpose, so it is easy to take out: delete this file and the two lines marked
// "LINK REVEAL" in app/src/ui/game.ts. Nothing else depends on it (ResultRow.layer in blind.ts can stay).

import { subjectGuides, type Prepared } from "./clip.ts";
import type { ResultRow, Scene } from "./blind.ts";
import { drawLayers, type RevealLayer } from "./cutout.ts";
import { createPlayer, STATE, type YtPlayer } from "./clipside/youtube.ts";
import type { Guide } from "../../clip/src/index.ts";

/** Where a grab came from: the YouTube video and the stretch that was grabbed. */
interface LinkSource { videoId: string; startMs: number; endMs: number }

/** The link of the scene started last from a grab, so the results can offer the live reveal. */
let current: { scene: Scene; link: LinkSource } | null = null;

/** The most recent saved analysis in this browser (the link lab saves grabs there), or null. */
function latestPrepared(): Promise<Prepared | null> {
  return new Promise((resolve) => {
    const req = indexedDB.open("jester", 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains("prepared")) req.result.createObjectStore("prepared", { keyPath: "fingerprint" }); };
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      const all = db.transaction("prepared", "readonly").objectStore("prepared").getAll();
      all.onerror = () => { db.close(); resolve(null); };
      all.onsuccess = () => {
        db.close();
        const rows = (all.result as { savedAt: number; prepared: Prepared }[]).sort((a, b) => b.savedAt - a.savedAt);
        resolve(rows[0]?.prepared ?? null);
      };
    };
  });
}

/** Grab keys look like `yt:<videoId>:<startMs>-<endMs>` (clipside/link.ts grabKey). Null for anything else. */
function linkOf(fingerprint: string): LinkSource | null {
  const m = /^yt:([\w-]+):(\d+)-(\d+)$/.exec(fingerprint);
  return m ? { videoId: m[1]!, startMs: Number(m[2]), endMs: Number(m[3]) } : null;
}

/** A blind mode scene from the last grab (drawn roles, no video), or the sentence saying why not. */
async function lastGrabScene(): Promise<Scene | string> {
  const p = await latestPrepared();
  if (!p) return "No grab saved in this browser yet. Grab the moves at /link-lab.html first.";
  const { guides, skipped } = subjectGuides(p);
  if (guides.length === 0) return skipped[0]?.reason ?? "No one to copy in this grab.";
  const g = guides[0]!;
  const scene: Scene = {
    name: "Your last grab", width: g.source.width, height: g.source.height,
    startMs: g.range.startMs, durationMs: g.range.endMs - g.range.startMs, guides, video: null,
  };
  const link = linkOf(p.fingerprint);
  current = link ? { scene, link } : null;
  return scene;
}

function button(text: string, className: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button"; b.className = className; b.textContent = text;
  return b;
}

/**
 * Adds "Use my last grab" beside "Use your own video" on the start screen. `start` opens the cast for the
 * scene; `problem` shows a sentence on the start screen.
 */
export function installLinkGrab(start: (scene: Scene) => void, problem: (text: string) => void) {
  const upload = document.getElementById("upload")?.closest("label");
  if (!upload || document.getElementById("useGrab")) return;
  const b = button("Use my last grab", "link");
  b.id = "useGrab";
  b.addEventListener("click", async () => {
    const s = await lastGrabScene();
    if (typeof s === "string") problem(s); else start(s);
  });
  upload.after(b);
}

/**
 * After a game from a grab: opens the live reveal on the real clip straight away (the recorded reveal
 * underneath can only draw stick figures for a link), and leaves a button on the results to open it again.
 */
export function linkResults(rows: ResultRow[], scene: Scene | null) {
  document.getElementById("linkRevealOpen")?.remove();
  if (!current || current.scene !== scene) return;
  const { link } = current;
  const open = () => void openLinkReveal(link, scene!, rows);
  const actions = document.querySelector("#screen-results .row-actions");
  if (actions) {
    const b = button("Watch it on the real clip", "btn btn-quiet");
    b.id = "linkRevealOpen";
    b.addEventListener("click", open);
    actions.prepend(b);
  }
  open();
}

const PASS_LABELS = ["The original", "Your cast"] as const;

/** A full-screen player: the clip once as it was, then once with the cast in place of its subjects. */
async function openLinkReveal(link: LinkSource, scene: Scene, rows: ResultRow[]) {
  const shade = document.createElement("div");
  shade.style.cssText = "position:fixed;inset:0;z-index:1000;background:rgba(10,10,14,.92);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px";
  const aspect = scene.width / scene.height;
  const box = document.createElement("div");
  box.style.cssText = `position:relative;height:min(82vh, ${Math.round(90 / aspect)}vw);aspect-ratio:${scene.width} / ${scene.height};background:#000;overflow:hidden;border-radius:6px`;
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;inset:0";
  // The player must not take clicks or show its controls over the overlay.
  const blurs = document.createElement("div");
  blurs.style.cssText = "position:absolute;inset:0;pointer-events:none";
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none";
  const label = document.createElement("div");
  label.style.cssText = "position:absolute;top:6%;left:0;right:0;text-align:center;font:800 clamp(18px,4vh,34px) system-ui,sans-serif;color:#fff;text-shadow:0 2px 6px #000,0 0 2px #000;pointer-events:none";
  // A big play button over the clip once it ends, so the whole picture is the way to watch again.
  const replay = button("\u25B6  Replay", "btn btn-main");
  replay.style.cssText = "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-size:clamp(16px,3vh,26px);padding:.6em 1.2em;display:none;cursor:pointer";
  box.append(host, blurs, canvas, label, replay);
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;gap:10px";
  const again = button("Play it again", "btn btn-quiet");
  const close = button("Close", "btn btn-quiet");
  bar.append(again, close);
  shade.append(box, bar);
  document.body.append(shade);

  let timer = 0, control = 0;
  let player: YtPlayer | null = null;
  const stop = () => {
    cancelAnimationFrame(timer); clearInterval(control);
    try { player?.destroy(); } catch { /* already gone */ }
    shade.remove();
  };
  close.addEventListener("click", stop);

  const made = await createPlayer(host, link.videoId, scene.startMs / 1000);
  if (made.error !== null) { label.textContent = made.error; return; }
  player = made.data;
  (host.querySelector("iframe") as HTMLIFrameElement | null)?.style.setProperty("pointer-events", "none");

  // One blurred patch per role someone played, over that subject.
  const guides = [...new Set(rows.map((r) => r.guide))];
  const patches = guides.map(() => {
    const d = document.createElement("div");
    d.style.cssText = "position:absolute;inset:0;backdrop-filter:blur(18px) brightness(.85);-webkit-backdrop-filter:blur(18px) brightness(.85)";
    blurs.append(d);
    return d;
  });
  const layers = rows.map((r) => r.layer).filter((l): l is RevealLayer => !!l);

  // The player reports its time in coarse steps; between steps, run on from the last report with the
  // wall clock, so the overlay moves every frame instead of jumping with each report.
  let reported = -1, reportedAt = 0;
  const clipMs = () => {
    const t = player!.getCurrentTime() * 1000;
    const now = performance.now();
    if (t !== reported) { reported = t; reportedAt = now; }
    const running = player!.getPlayerState() === STATE.PLAYING;
    return (running ? reported + (now - reportedAt) : reported) - scene.startMs;
  };

  // 0: the original, 1: the cast, 2: finished. `seeking`: after a jump back to the start the player
  // still reports the old time for a moment, so nothing counts until it reports a time near the start.
  let pass = 0, seeking = false;
  const toStart = () => { seeking = true; reported = -1; player!.seekTo(scene.startMs / 1000, true); player!.playVideo(); };
  const play = () => {
    pass = 0;
    toStart();
    // Opened with no click (straight after a game), the browser may block sound: then play it muted.
    setTimeout(() => { if (player && pass < 2 && player.getPlayerState() !== STATE.PLAYING) { player.mute(); player.playVideo(); } }, 1500);
  };
  again.addEventListener("click", play);
  replay.addEventListener("click", play);

  /** The stretch time now (0 while a jump back is landing). Moves from one pass to the next at the end. */
  const step = (): number => {
    if (pass === 2) return 0;
    let ms = clipMs();
    if (seeking) {
      if (ms >= 0 && ms < 1000) seeking = false;
      else return 0;
    }
    if (ms >= scene.durationMs || player!.getPlayerState() === STATE.ENDED) {
      if (pass === 0) { pass = 1; toStart(); return 0; }
      pass = 2;
      player!.pauseVideo();
      ms = 0;
    }
    return ms;
  };
  // The passes are kept on a timer, which runs even when the page is in the background; drawing follows
  // the screen's refresh.
  control = window.setInterval(step, 100);

  const ctx = canvas.getContext("2d")!;
  function draw() {
    const W = Math.round(box.clientWidth * devicePixelRatio), H = Math.round(box.clientHeight * devicePixelRatio);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    ctx.clearRect(0, 0, W, H);
    const ms = step();
    label.textContent = pass === 2 ? "That's the cast." : PASS_LABELS[pass]!;
    replay.style.display = pass === 2 ? "block" : "none";
    const cast = pass === 1 && !seeking;
    guides.forEach((g, i) => { patches[i]!.style.clipPath = cast ? coverPath(g, ms) : "inset(100%)"; });
    if (cast) drawLayers(ctx, W, H, layers, ms);
    timer = requestAnimationFrame(draw);
  }
  play();
  draw();
}

/**
 * A CSS clip-path over subject `g` at stretch time `ms`: an ellipse just past its box, blended between
 * samples. (Its raw outline changes shape from frame to frame, which made the cover flicker.)
 */
function coverPath(g: Guide, ms: number): string {
  const frames = g.boxTrack.frames;
  const pos = Math.min(frames.length - 1, Math.max(0, (ms * g.source.sampleHz) / 1000));
  const i = Math.floor(pos), j = Math.min(frames.length - 1, i + 1), u = pos - i;
  const a = frames[i]?.box ?? null, b = frames[j]?.box ?? null;
  const box = a && b ? { cx: a.cx + (b.cx - a.cx) * u, cy: a.cy + (b.cy - a.cy) * u, w: a.w + (b.w - a.w) * u, h: a.h + (b.h - a.h) * u } : a ?? b;
  if (!box) return "inset(100%)";
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  return `ellipse(${pct((box.w / 2) * 1.45)} ${pct((box.h / 2) * 1.3)} at ${pct(box.cx)} ${pct(box.cy)})`;
}
