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

/**
 * What a player's jester wears, from what their device has sent. A removal (an empty lobby photo) wins, even over a
 * face from a finished round, until they send a new photo; otherwise the newer of the lobby photo and the round's
 * face. Remembered across rounds, which clear the room's media. Null means the grey face. A removal never touches
 * the gate, so taking a photo off does not reset the cooldown or a decode under way.
 */
export class LobbyFaceChoice {
  private off = new Set<string>();
  private lobby = new Map<string, string>();
  private face = new Map<string, string>();
  private prefer = new Map<string, "lobby" | "face">();

  pick(id: string, media: { lobbyface?: string; face?: string }): string | null {
    if (media.lobbyface !== undefined && media.lobbyface !== this.lobby.get(id)) {
      this.lobby.set(id, media.lobbyface);
      if (media.lobbyface === "") this.off.add(id);
      else { this.off.delete(id); this.prefer.set(id, "lobby"); }
    }
    if (media.face && media.face !== this.face.get(id)) { this.face.set(id, media.face); this.prefer.set(id, "face"); }
    if (this.off.has(id)) return null;
    const lobby = this.lobby.get(id) || null, face = this.face.get(id) || null;
    return this.prefer.get(id) === "lobby" ? lobby ?? face : face ?? lobby;
  }
  forget(id: string) { this.off.delete(id); this.lobby.delete(id); this.face.delete(id); this.prefer.delete(id); }
  clear() { this.off.clear(); this.lobby.clear(); this.face.clear(); this.prefer.clear(); }
}
