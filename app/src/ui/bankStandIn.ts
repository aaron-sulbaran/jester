// STAND-IN, delete when aaron/video-bank lands: the same signatures as app/src/bank.ts and app/src/submit.ts
// (agreed in the lead session), so the start screen can be seen tonight. Swap the import in game.ts to
// "../bank.ts" and "../submit.ts" and delete this file.
//
// The bank here is the two drawn starter scenes, so a round really plays. `?bank=empty` shows the empty bank.

import type { Guide } from "../../../clip/src/index.ts";
import { demoScene, dribbleScene, drawDemoScene, type Scene } from "../blind.ts";

export interface BankClip { id: string; title: string; credit: string; durationMs: number; people: number; things: number; video: string; poster: string; guides: string }

type Result<T> = { data: T; error: null } | { data: null; error: string };

const SCENES: Record<string, () => Scene> = { "pickup-game": dribbleScene, "dance-break": demoScene };
const TITLES: Record<string, [string, string]> = { "pickup-game": ["Pickup game", "Jester team"], "dance-break": ["Dance break", "Jester team"] };

/** A poster from the scene's own drawing, a second in. */
function posterOf(scene: Scene): string {
  const c = document.createElement("canvas");
  c.width = 640; c.height = Math.round(640 * (scene.height / scene.width));
  drawDemoScene(c.getContext("2d")!, c.width, c.height, scene, 1000);
  return c.toDataURL("image/jpeg", 0.8);
}

export async function listBank(): Promise<Result<BankClip[]>> {
  if (new URLSearchParams(location.search).get("bank") === "empty") return { data: [], error: null };
  return {
    data: Object.entries(SCENES).map(([id, make]) => {
      const s = make();
      const [title, credit] = TITLES[id]!;
      return {
        id, title, credit, durationMs: s.durationMs,
        people: s.guides.filter((g) => g.subject.kind === "person").length,
        things: s.guides.filter((g) => g.subject.kind === "thing").length,
        video: "", poster: posterOf(s), guides: `stand-in:${id}`,
      };
    }),
    error: null,
  };
}

export async function loadBankGuides(clip: BankClip): Promise<Result<Guide[]>> {
  const make = SCENES[clip.id];
  return make ? { data: make().guides, error: null } : { data: null, error: "That clip is not in the bank any more." };
}

/** Starts a round from a bank clip with no extraction at play time. The real name comes in the bank's hub note. */
export async function bankScene(clip: BankClip): Promise<Result<Scene>> {
  const make = SCENES[clip.id];
  return make ? { data: make(), error: null } : { data: null, error: "That clip is not in the bank any more." };
}

export async function submitClip(_file: File, _info: { title?: string; credit?: string }, onProgress?: (share: number) => void): Promise<Result<{ id: string }>> {
  onProgress?.(0);
  return { data: null, error: "Submissions are not switched on yet. They open when the bank tool goes live." };
}
