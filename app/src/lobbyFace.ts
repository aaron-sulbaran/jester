// Which incoming lobby photos a device decodes and puts on a jester. A photo comes from another player's device, so
// every limit holds on receipt: players in the room only, a picture short enough and small enough, at most one
// new picture per player every few seconds (the newest one waits its turn), and one decode per player at a time.

export const LOBBY_FACE_MAX_CHARS = 200_000;
/** The photo is sent at 160 by 160; anything larger than this on a side is not decoded into a canvas. */
export const LOBBY_FACE_MAX_SIDE = 512;
export const LOBBY_FACE_EVERY_MS = 3000;

export const lobbyFaceSideOk = (width: number, height: number) =>
  width > 0 && height > 0 && width <= LOBBY_FACE_MAX_SIDE && height <= LOBBY_FACE_MAX_SIDE;

export class LobbyFaceGate {
  private last = new Map<string, { text: string; at: number }>();
  private busy = new Set<string>();
  private now: () => number;
  constructor(now: () => number = () => Date.now()) { this.now = now; }

  /** True when this picture should be decoded now. Call done(id) once the decode has finished. */
  take(id: string, text: string | undefined, inRoom: boolean): boolean {
    if (!inRoom || !text || text.length > LOBBY_FACE_MAX_CHARS || this.busy.has(id)) return false;
    const prev = this.last.get(id);
    if (prev && (prev.text === text || this.now() - prev.at < LOBBY_FACE_EVERY_MS)) return false;
    this.last.set(id, { text, at: this.now() });
    this.busy.add(id);
    return true;
  }
  done(id: string) { this.busy.delete(id); }
  /** The picture last taken for this player, so a decode that finishes late can tell it is out of date. */
  current(id: string) { return this.last.get(id)?.text; }
  forget(id: string) { this.last.delete(id); this.busy.delete(id); }
  clear() { this.last.clear(); this.busy.clear(); }
}
