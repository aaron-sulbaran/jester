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
import { deal, runBlindGame, type BlindDeps, type BlindUi, type GameOptions, type Scene } from "./blind.ts";
import type { RevealRole } from "./composite.ts";

type RoomLike = {
  me: string; name: string; round: { roundNo: number; extra?: { assign?: Record<string, number> } } | null; allDone: boolean;
  roster(): { id: string; name: string }[];
  standings(): { id: string; name: string; score: number | null; timeline: unknown; extra: { guideIndex: number; role: string } | null }[];
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
  room.submitResult({ score: row.score ?? 0, timeline: packed, extra: { guideIndex: idx, role: row.role } });
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
