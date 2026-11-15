// The round log's corner panel, shown only with ?dev=1 (remembered for the tab). Before a round the tester
// picks what they are about to do on purpose (it stays picked until changed); after it the panel says which record was saved.
// It sits in its own shadow root, outside the game's screens, so no page style reaches it or is reached.

import { DEV_TAGS, isDevTag, type DevTag } from "../../../eval/src/record.ts";

const DEV_KEY = "jester.dev";
export const TAG_HINTS: Record<DevTag, string> = {
  "nailed": "copy it as well as you can",
  "stood-still": "stand in view and do not move",
  "seated": "sit down, upper body in view",
  "late-half-second": "copy it well, about half a second behind",
  "wrong-moves": "stay in view and do different moves",
  "left-right-swapped": "copy it, but not as a mirror",
  "walked-out-of-frame": "copy it, then walk out of view halfway",
};

let nextTag: DevTag | null = null;
let nextNote = "";

/** `?tag=nailed` in the address tags every round on this page load (the panel shows it, so it is not forgotten). */
const stickyTag: DevTag | null = (() => {
  try {
    const t = new URLSearchParams(location.search).get("tag");
    return isDevTag(t) ? t : null;
  } catch {
    return null;
  }
})();
let lastLine = "No round saved yet on this page.";
let saved = 0;
let render: (() => void) | null = null;

export function devMode(): boolean {
  try {
    const on = new URLSearchParams(location.search).get("dev");
    if (on === "1") sessionStorage.setItem(DEV_KEY, "1");
    if (on === "0") sessionStorage.removeItem(DEV_KEY);
    return sessionStorage.getItem(DEV_KEY) === "1";
  } catch {
    return false;
  }
}

/** Sets the tag (and note) for the next scored round; the eval lab calls this from its own picker. */
export function setNextTag(tag: DevTag | null, note = ""): void {
  nextTag = tag;
  nextNote = note;
  render?.();
}

/**
 * The tag and note for the round being scored now. A picked tag stays for every round (a blind game scores each
 * turn as its own round) until the tester picks another; the note counts for one round only.
 */
export function takeTag(): { tag: DevTag | null; note: string | null } {
  const taken = { tag: nextTag ?? stickyTag, note: nextNote.trim() || null };
  nextNote = "";
  render?.();
  return taken;
}

export function showSaved(line: string): void {
  lastLine = line;
  saved++;
  render?.();
}

export function showProblem(line: string): void {
  lastLine = line;
  render?.();
}

export function mountDevPanel(): void {
  // The eval lab has its own picker.
  if (render || !(devMode() || stickyTag) || !document.body || location.pathname.endsWith("/eval-lab.html")) return;
  const host = document.createElement("div");
  host.id = "jester-round-log";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      .box { position: fixed; left: 8px; bottom: 8px; z-index: 2147483647; max-width: 300px; padding: 8px 10px;
             font: 12px/1.35 system-ui, sans-serif; color: #111; background: #fffbe8; border: 1px solid #b9a64b;
             border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,.25); }
      .box.closed .body { display: none; }
      b { font-weight: 600; }
      select, input { font: inherit; width: 100%; box-sizing: border-box; margin-top: 4px; }
      .hint, .last { color: #555; margin-top: 4px; }
      button { font: inherit; border: 0; background: none; padding: 0; cursor: pointer; color: #6b5a00; }
    </style>
    <div class="box">
      <button class="toggle"><b>Round log</b> <span class="count"></span></button>
      <div class="body">
        <label>Next round, on purpose:
          <select class="tag"><option value="">nothing special</option>${DEV_TAGS.map((t) => `<option value="${t}">${t}</option>`).join("")}</select>
        </label>
        <div class="hint"></div>
        <input class="note" maxlength="120" placeholder="Note (optional)" />
        <div class="last"></div>
      </div>
    </div>`;
  const box = root.querySelector<HTMLDivElement>(".box")!;
  // On a phone the open panel would cover the game: start folded to its title line.
  if (innerWidth < 600) box.classList.add("closed");
  const select = root.querySelector<HTMLSelectElement>(".tag")!;
  const note = root.querySelector<HTMLInputElement>(".note")!;
  root.querySelector(".toggle")!.addEventListener("click", () => box.classList.toggle("closed"));
  select.addEventListener("change", () => { nextTag = isDevTag(select.value) ? select.value : null; render?.(); });
  note.addEventListener("input", () => { nextNote = note.value; });
  render = () => {
    select.value = nextTag ?? "";
    if (document.activeElement !== host) note.value = nextNote;
    root.querySelector(".hint")!.textContent = nextTag
      ? `${TAG_HINTS[nextTag]} (stays on for every round until you change it)`
      : stickyTag
        ? `Every round on this page counts as ${stickyTag} (from the address): ${TAG_HINTS[stickyTag]}.`
        : "Pick one before Start to make this round a test case.";
    root.querySelector(".last")!.textContent = lastLine;
    root.querySelector(".count")!.textContent = saved ? `(${saved} saved)` : "";
  };
  render();
  document.body.appendChild(host);
}
