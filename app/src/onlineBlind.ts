// Blind mode across devices: the host deals one role per player, each player plays their own role on their
// own device with Alex's game (runBlindGame, one seat), the recordings come back through the room, and the
// group reveal puts every player on their role. No edit to blind.ts is needed.
//
// Hook for a screen that already has the blind UI (BlindUi and BlindDeps from blind.ts):
//   const scene = demoScene();                          // every device builds the same built-in scene
//   room.on("start", async (round) => {
//     await playMyRole(room, scene, ui, deps, { speed: 1 });   // deal comes in round.extra.assign
//     await whenAllDone(room);
//     const roles = revealRoles(room, scene);                  // feed drawReveal(canvas, roles, ms, { clipAspect })
//   });
//   hostDeal(room, scene, "demo");                      // host only, once everyone has joined

import { serializeTimeline, deserializeTimeline } from "../../spikes/pose-match/serialize.mjs";
import { deal, runBlindGame, type BlindDeps, type BlindUi, type GameOptions, type ResultRow, type Scene } from "./blind.ts";
import { packCutouts, packFace } from "./packMedia.ts";
import type { RevealRole } from "./composite.ts";

type RoomLike = {
  me: string; name: string; round: { roundNo: number; extra?: { assign?: Record<string, number> } } | null; allDone: boolean;
  roster(): { id: string; name: string }[];
  standings(): { id: string; name: string; score: number | null; timeline: unknown; media?: Record<string, string>; extra: { guideIndex: number; role: string; part?: string; lagMs?: number } | null }[];
  sendMedia(kind: string, text: string, options?: { chunkChars?: number; delayMs?: number }): Promise<void>;
  start(clipId: string, delayMs?: number, extra?: object): unknown;
  submitResult(r: { score: number; timeline?: unknown; extra?: unknown }): void;
  on(event: "update" | "start", fn: (arg: never) => void): () => void;
};

/** Host: pick a random role for every player in the room and start the round with the deal attached. `extra` rides along (e.g. the speed). */
export function hostDeal(room: RoomLike, scene: Scene, sceneId: string, extra: object = {}) {
  const players = room.roster();
  const seats = deal(players.map((p) => p.id), scene.guides);
  const assign: Record<string, number> = {};
  players.forEach((p, i) => { assign[p.id] = scene.guides.indexOf(seats[i]!.guide); });
  return room.start(sceneId, 0, { ...extra, assign });
}

/** Play my own role on this device, then send my score and recording (pose only) to the room. */
export async function playMyRole(room: RoomLike, scene: Scene, ui: BlindUi, deps: BlindDeps, options: GameOptions = {}) {
  const idx = room.round?.extra?.assign?.[room.me];
  if (idx === undefined || !scene.guides[idx]) throw new Error("The host has not dealt me a role.");
  const mine: Scene = { ...scene, guides: [scene.guides[idx]!] };
  const row = (await runBlindGame(mine, [room.name], ui, deps, options))[0]!;
  const frames = row.timeline?.frames ?? [];
  const packed = row.timeline
    ? serializeTimeline({ aspect: row.timeline.aspect, durationMs: frames.length ? frames[frames.length - 1]!.t : 0, coverage: 1, model: "blind", frames: frames.map((f) => ({ t: f.t, landmarks: f.landmarks as never, outline: null })) } as never, { every: 2 })
    : null;
  room.submitResult({ score: row.score ?? 0, timeline: packed, extra: { guideIndex: idx, role: row.role, part: row.part ?? "body", lagMs: row.lagMs ?? 0 } });
  return row;
}

/** Resolves once every player in the room has sent a result for this round. */
export function whenAllDone(room: RoomLike): Promise<void> {
  return new Promise((resolve) => {
    if (room.allDone) return resolve();
    const off = room.on("update", () => { if (room.allDone) { off(); resolve(); } });
  });
}

/** Everyone's role, recording and score, in the shape drawReveal takes. */
export function revealRoles(room: RoomLike, scene: Scene): RevealRole[] {
  return room.standings()
    .filter((r) => r.timeline && r.extra && scene.guides[r.extra.guideIndex])
    .map((r) => ({ name: `${r.name} (${r.extra!.role})`, score: r.score, guide: scene.guides[r.extra!.guideIndex]!, timeline: deserializeTimeline(r.timeline) as never }));
}

/**
 * Sends my face and my cutouts to the others in the room (pictures only travel to them, after the round), then a
 * "done" marker so they know nothing more is coming. A failure just means the others see a stick figure for me.
 */
export async function sendMyMedia(room: RoomLike, row: ResultRow) {
  try {
    const face = packFace(row.face);
    if (face) await room.sendMedia("face", face, { chunkChars: 60000, delayMs: 40 });
    const cutouts = row.layer?.cutouts ?? [];
    if (cutouts.length > 0) await room.sendMedia("cuts", packCutouts(cutouts), { chunkChars: 60000, delayMs: 40 });
  } catch (err) {
    console.warn("Could not send my pictures:", err);
  }
  try { await room.sendMedia("done", "1"); } catch { /* the others stop waiting after a while anyway */ }
}

/**
 * Resolves once every other player has sent their pictures (or said they have none). It gives up only when nothing
 * has arrived for `idleMs` (a hidden browser tab slows its sender down to about a piece a second, so a big set of
 * pictures can take a minute and must not be cut off while it is still coming in), or after `maxMs` in all.
 */
export function whenMediaIn(room: RoomLike, idleMs = 20000, maxMs = 120000): Promise<void> {
  const ready = () => room.standings().every((r) => r.id === room.me || !r.timeline || !!r.media?.done);
  return new Promise((resolve) => {
    if (ready()) return resolve();
    let idle = window.setTimeout(finish, idleMs);
    const hard = window.setTimeout(finish, maxMs);
    const off = room.on("update", () => {
      if (ready()) return finish();
      clearTimeout(idle);
      idle = window.setTimeout(finish, idleMs); // something arrived: keep waiting
    });
    function finish() { clearTimeout(idle); clearTimeout(hard); off(); resolve(); }
  });
}
