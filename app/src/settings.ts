// The player's settings, remembered in this browser: sound effects and their volume, calm motion, the announcer's
// voice, and developer mode. The game reads them from here; a settings screen (ids below) changes them.
//
// Storage: the sound switch stays where it always was (localStorage jester.sound, "on" or "off"), so the Sound tag
// and older pages keep working; everything else is one JSON object under jester.settings.
//
// Ids bound by bindSettings() (any may be missing): #setSound checkbox, #setVolume range 0 to 100, #setMotion select
// (system | calm | full), #setVoice select (off | browser | recorded), #setDev checkbox.
// Hooks for the look: body.dev (developer mode) and html[data-motion="calm" | "full"].

export type Motion = "system" | "calm" | "full";
export type Voice = "off" | "browser" | "recorded";

export interface Settings {
  /** Sound effects on or off (the clip's own sound never follows this). */
  sound: boolean;
  /** Sound effects volume, 0 to 1. */
  volume: number;
  /** Calm motion: "system" follows prefers-reduced-motion. */
  motion: Motion;
  /** The announcer: off, the browser's own speech, or lines recorded ahead of time. */
  voice: Voice;
  /** Developer mode: the team's tools, the build stamp and the refresh notice. */
  developer: boolean;
}

export const DEFAULTS: Settings = { sound: true, volume: 1, motion: "system", voice: "off", developer: false };

export const SOUND_KEY = "jester.sound";
export const SETTINGS_KEY = "jester.settings";

const MOTIONS: readonly Motion[] = ["system", "calm", "full"];
const VOICES: readonly Voice[] = ["off", "browser", "recorded"];

/**
 * Settings from what the browser stored: the sound switch's own value and the JSON object. Anything missing,
 * broken or out of range falls back to its default. Pure, for tests.
 */
export function readSettings(sound: string | null, json: string | null): Settings {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = json ? JSON.parse(json) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch { /* broken JSON: defaults */ }
  const volume = typeof raw.volume === "number" && Number.isFinite(raw.volume) ? Math.min(1, Math.max(0, raw.volume)) : DEFAULTS.volume;
  return {
    sound: sound !== "off",
    volume,
    motion: MOTIONS.includes(raw.motion as Motion) ? (raw.motion as Motion) : DEFAULTS.motion,
    voice: VOICES.includes(raw.voice as Voice) ? (raw.voice as Voice) : DEFAULTS.voice,
    developer: raw.developer === true,
  };
}

/** What to store for `s`: the sound switch's value and the JSON for the rest. Pure, for tests. */
export function writeSettings(s: Settings): { sound: string; json: string } {
  return { sound: s.sound ? "on" : "off", json: JSON.stringify({ volume: s.volume, motion: s.motion, voice: s.voice, developer: s.developer }) };
}

/** Calm motion on: chosen, or following a system that asks for reduced motion. Pure, for tests. */
export function calmFor(motion: Motion, systemReduces: boolean): boolean {
  return motion === "calm" || (motion === "system" && systemReduces);
}

/**
 * Developer mode on: ?dev=1 (and ?dev=0 off) wins; then the stored setting; then a local dev server, as before.
 * Pure, for tests.
 */
export function developerFor(devParam: string | null, hostname: string, stored: boolean): boolean {
  if (devParam !== null) return devParam !== "0";
  return stored || ["localhost", "127.0.0.1"].includes(hostname);
}

/** The announcer's voice for this page: ?host=1 still asks for the browser's speech, as before. Pure, for tests. */
export function voiceFor(hostParam: string | null, stored: Voice): Voice {
  return hostParam === "1" && stored === "off" ? "browser" : stored;
}

// ---- The store, in the browser ----

const storage = (): Storage | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };
const params = () => new URLSearchParams(globalThis.location?.search ?? "");

let current: Settings = (() => {
  const st = storage();
  try { return readSettings(st?.getItem(SOUND_KEY) ?? null, st?.getItem(SETTINGS_KEY) ?? null); } catch { return { ...DEFAULTS }; }
})();
const listeners = new Set<(s: Settings) => void>();

/** The settings now. */
export function getSettings(): Settings {
  return current;
}

/** Changes one setting, remembers it and tells everyone listening. */
export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  if (current[key] === value) return;
  current = { ...current, [key]: value };
  const out = writeSettings(current);
  try { storage()?.setItem(SOUND_KEY, out.sound); storage()?.setItem(SETTINGS_KEY, out.json); } catch { /* private window: lasts this visit */ }
  for (const fn of [...listeners]) fn(current);
}

/** Calls `fn` on every change; returns a way to stop. */
export function onSettings(fn: (s: Settings) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Calm motion on for this page. */
export function calmMotion(): boolean {
  const reduces = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  return calmFor(current.motion, reduces);
}

/** Developer mode on for this page (the setting, ?dev=1 or ?dev=0, or a local dev server). */
export function developerMode(): boolean {
  return developerFor(params().get("dev"), globalThis.location?.hostname ?? "", current.developer);
}

/** The announcer's voice for this page. */
export function announcerVoice(): Voice {
  return voiceFor(params().get("host"), current.voice);
}

/** Puts the settings on the page: body.dev and html[data-motion]. Called at start and on every change. */
export function applySettings() {
  if (typeof document === "undefined") return;
  document.body?.classList.toggle("dev", developerMode());
  document.documentElement.dataset.motion = calmMotion() ? "calm" : "full";
}

/** Binds the settings controls under `root` by id, both ways. Safe to call again. */
export function bindSettings(root: ParentNode = document) {
  const find = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`);
  const sound = find<HTMLInputElement>("setSound");
  const volume = find<HTMLInputElement>("setVolume");
  const motion = find<HTMLSelectElement>("setMotion");
  const voice = find<HTMLSelectElement>("setVoice");
  const dev = find<HTMLInputElement>("setDev");
  const show = (s: Settings) => {
    if (sound) sound.checked = s.sound;
    if (volume) { volume.value = String(Math.round(s.volume * 100)); volume.disabled = !s.sound; }
    if (motion) motion.value = s.motion;
    if (voice) voice.value = s.voice;
    if (dev) dev.checked = developerMode();
  };
  const once = (el: HTMLElement | null, type: string, fn: () => void) => {
    if (!el || el.dataset.settingsBound) return;
    el.dataset.settingsBound = "1";
    el.addEventListener(type, fn);
  };
  once(sound, "change", () => setSetting("sound", !!sound?.checked));
  once(volume, "input", () => setSetting("volume", Math.min(1, Math.max(0, Number(volume?.value ?? 100) / 100))));
  once(motion, "change", () => setSetting("motion", (MOTIONS.includes(motion?.value as Motion) ? motion!.value : "system") as Motion));
  once(voice, "change", () => setSetting("voice", (VOICES.includes(voice?.value as Voice) ? voice!.value : "off") as Voice));
  once(dev, "change", () => setSetting("developer", !!dev?.checked));
  show(current);
  onSettings(show);
}

// Developer mode and calm motion follow every change, and a system switch to reduced motion too.
onSettings(applySettings);
if (typeof matchMedia === "function") {
  try { matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", applySettings); } catch { /* old browsers */ }
}
