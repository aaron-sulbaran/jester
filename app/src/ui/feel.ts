// The game's feel: what makes it seem finished. A sound on every button, the jester's card when the camera
// lets us down, a loading card with Cancel while the camera and tracker start, a "can't see you" notice during
// a turn, the demo switch (?demo=1), Esc for home and one key to skip the waiting screens, and the score that
// counts up. game.ts hooks these in with a few lines; the markup is in index.html (ids below).

import type { Player } from "../round.ts";
import { cameraTrouble } from "../feelText.ts";
import * as sfx from "../sfx.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const left = () => new DOMException("Left the game", "AbortError");

/** `?demo=1`: the simulated player (the understudy) can play every turn in the main game, so no camera is needed. */
export const DEMO = (() => {
  const p = new URLSearchParams(location.search);
  return p.has("demo") && p.get("demo") !== "0";
})();

/** Sounds on clicks, Esc and the skip key, and the demo switch on the cast screen. Call once. */
export function installFeel() {
  sfx.installSfx();
  // A soft tap for every button and clip card. Programmatic clicks from the skip key count too.
  document.addEventListener("click", (e) => {
    const hit = (e.target as Element | null)?.closest?.("button, summary, label.upload");
    if (hit && !(hit as HTMLButtonElement).disabled) sfx.click();
  }, { capture: true });
  installKeys();
  $("demoRow").hidden = !DEMO;
}

// ---- Keys: Esc for home, the right arrow (or a clicker's Page Down) to skip a waiting screen ----

/** The button each waiting screen moves on with. */
const SKIP_BUTTONS: Partial<Record<string, string>> = {
  howto: "howtoGo", handover: "handoverGo", watch: "watchGo", reveal: "revealSkip", crown: "crownGo",
};
/** Waits that the skip key ends early (the drum roll before the reveal). */
const skipWaits = new Set<() => void>();

function installKeys() {
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    // An open card handles its own keys (Esc closes it); the practice area has its own page.
    if (document.querySelector("dialog[open]") || document.body.classList.contains("solo")) return;
    if (e.key === "Escape") {
      if ($("gameNav").hidden) return;
      e.preventDefault();
      $("home").click(); // mid-game this asks first, as the Home tab does
      return;
    }
    if (e.key !== "ArrowRight" && e.key !== "PageDown") return;
    if (e.repeat || (e.target as Element | null)?.closest?.("input, textarea, select, [contenteditable]")) return;
    if (skipWaits.size) {
      e.preventDefault();
      for (const done of [...skipWaits]) done();
      return;
    }
    const id = SKIP_BUTTONS[document.body.dataset.screen ?? ""];
    const b = id ? document.getElementById(id) as HTMLButtonElement | null : null;
    if (b && !b.disabled && b.offsetParent !== null) {
      e.preventDefault();
      b.click();
    }
  });
}

/** Waits `ms`, or less if the skip key is pressed; rejects at once if the game is left. */
export function waitOrSkip(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(left());
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      skipWaits.delete(done);
      signal?.removeEventListener("abort", stop);
      if (ok) resolve(); else reject(left());
    };
    const done = () => finish(true);
    const stop = () => finish(false);
    const timer = window.setTimeout(done, ms);
    skipWaits.add(done);
    signal?.addEventListener("abort", stop, { once: true });
  });
}

// ---- The camera: a loading card, the jester's card when it fails, and the "can't see you" notice ----

export interface CameraGuard {
  /** The camera for a turn. Shows the loading card while it starts and the jester's card if it fails. */
  getCamera(): Promise<Player>;
  /** True when this turn is played by the understudy (the simulated player). */
  simMode(): boolean;
  /** A new player's turn: back on the camera, unless the demo switch is on. */
  newTurn(): void;
  /** The jester's line for the part screen after Cancel on the loading card (read once), or null. */
  partNote(): string | null;
}

/** How long a turn can go without seeing the player before the notice shows. */
const LOST_MS = 1500;
/** Wait this long before showing the loading card, so a camera that is already on never flashes it. */
const LOADING_AFTER_MS = 250;

type Started = { player: Player } | { error: unknown } | { cancelled: true };
type Choice = "retry" | "understudy" | "home";

/**
 * Wraps the app's camera for the game. On a refused or missing camera it shows the jester's card: try again,
 * let the understudy take the turn (it turns `simMode` on and rejects; blind.ts then hands the turn to the
 * simulated player), or go home.
 */
export function guardCamera(base: { getCamera(): Promise<Player>; simMode(): boolean }, goHome: () => void): CameraGuard {
  let understudy = false;
  let note: string | null = null;
  /** A start still under way, kept across Cancel so pressing Start again picks it up instead of starting twice. */
  let pending: Promise<Player> | null = null;

  async function starting(): Promise<Started> {
    let current = pending;
    if (!current) {
      const p = base.getCamera();
      current = pending = p;
      p.then(() => { pending = null; }, () => { pending = null; });
    }
    const dialog = $<HTMLDialogElement>("cameraWait");
    const bar = $<HTMLProgressElement>("cameraWaitBar");
    const cancelButton = $("cameraWaitCancel");
    const t0 = performance.now();
    let raf = 0;
    const later = window.setTimeout(() => {
      bar.value = 0;
      if (!dialog.open) dialog.showModal();
      // The camera and tracker report no progress, so the bar eases toward the end and waits there.
      const step = () => { bar.value = 0.92 * (1 - Math.exp(-(performance.now() - t0) / 5000)); raf = requestAnimationFrame(step); };
      step();
    }, LOADING_AFTER_MS);
    let cancel = () => {};
    const cancelled = new Promise<Started>((resolve) => { cancel = () => resolve({ cancelled: true }); });
    const onEsc = (e: Event) => { e.preventDefault(); cancel(); };
    cancelButton.addEventListener("click", cancel);
    dialog.addEventListener("cancel", onEsc);
    try {
      return await Promise.race([current.then((player): Started => ({ player }), (error): Started => ({ error })), cancelled]);
    } finally {
      clearTimeout(later);
      cancelAnimationFrame(raf);
      cancelButton.removeEventListener("click", cancel);
      dialog.removeEventListener("cancel", onEsc);
      if (dialog.open) dialog.close();
    }
  }

  async function getCamera(): Promise<Player> {
    for (;;) {
      const r = await starting();
      if ("player" in r) { note = null; return watched(r.player); }
      if ("cancelled" in r) {
        note = "No rush. The camera is still warming up; press Start when you're ready.";
        throw new Error("Cancelled while the camera started");
      }
      console.warn("The camera did not start:", r.error);
      const choice = await cameraCard(r.error);
      if (choice === "retry") continue;
      if (choice === "understudy") {
        understudy = true;
        throw new Error("The understudy takes this turn");
      }
      goHome();
      throw left();
    }
  }

  return {
    getCamera,
    simMode: () => understudy || (DEMO && $<HTMLInputElement>("demoUnderstudy").checked) || base.simMode(),
    newTurn: () => { understudy = false; note = null; },
    partNote: () => { const n = note; note = null; return n; },
  };
}

/** The jester's card for a camera that failed. Resolves with what the player picked; Esc means home. */
function cameraCard(err: unknown): Promise<Choice> {
  const trouble = cameraTrouble(err);
  const dialog = $<HTMLDialogElement>("cameraDialog");
  dialog.dataset.kind = trouble.kind;
  $("cameraTitle").textContent = trouble.title;
  $("cameraText").textContent = trouble.text;
  sfx.oops();
  return new Promise((resolve) => {
    const buttons: [HTMLElement, Choice][] = [[$("cameraRetry"), "retry"], [$("cameraUnderstudy"), "understudy"], [$("cameraHome"), "home"]];
    const handlers = buttons.map(([b, choice]) => { const h = () => pick(choice); b.addEventListener("click", h); return [b, h] as const; });
    const onEsc = (e: Event) => { e.preventDefault(); pick("home"); };
    const pick = (choice: Choice) => {
      for (const [b, h] of handlers) b.removeEventListener("click", h);
      dialog.removeEventListener("cancel", onEsc);
      if (dialog.open) dialog.close();
      resolve(choice);
    };
    dialog.addEventListener("cancel", onEsc);
    dialog.showModal();
    $("cameraRetry").focus();
  });
}

/** True when the tracker sees enough of a person to score them. */
function inView(landmarks: readonly { visibility?: number }[] | null | undefined) {
  if (!landmarks || landmarks.length < 25) return false;
  let seen = 0;
  for (const l of landmarks) if ((l.visibility ?? 1) >= 0.5 && ++seen >= 4) return true;
  return false;
}

/**
 * The camera player, plus the "can't see you" notice: when no pose has come for LOST_MS while the moves count,
 * it shows on the stage until the player is back. A notice only; the turn carries on.
 */
function watched(p: Player): Player {
  let unwatch: (() => void) | null = null;
  const player: Player = {
    start(onFrame, clipClockMs) {
      unwatch?.();
      const notice = $("lostNotice");
      let lastSeen = performance.now();
      let showing = false;
      const timer = window.setInterval(() => {
        const now = performance.now();
        if (clipClockMs() < 0) lastSeen = now; // only while the moves count (not while framing)
        const lost = now - lastSeen > LOST_MS;
        if (lost === showing) return;
        showing = lost;
        notice.hidden = !lost;
        if (lost) sfx.lost();
      }, 100);
      unwatch = () => { clearInterval(timer); notice.hidden = true; unwatch = null; };
      p.start((f) => {
        if (inView(f.landmarks)) lastSeen = performance.now();
        onFrame(f);
      }, clipClockMs);
    },
    stop() { unwatch?.(); p.stop(); },
  };
  if (p.setCapture) player.setCapture = (fn) => p.setCapture!(fn);
  return player;
}

// ---- Results ----

/** Counts `el` up from 0 to `to`, easing out; shows the number at once when motion is reduced. */
export function countUp(el: HTMLElement, to: number, delayMs = 0) {
  if (to <= 0 || matchMedia("(prefers-reduced-motion: reduce)").matches) { el.textContent = String(to); return; }
  el.textContent = "0";
  const durationMs = 700 + to * 8;
  const t0 = performance.now() + delayMs;
  const step = (now: number) => {
    if (!el.isConnected) return;
    const u = Math.min(1, Math.max(0, (now - t0) / durationMs));
    el.textContent = String(Math.round(to * (1 - (1 - u) ** 3)));
    if (u < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
