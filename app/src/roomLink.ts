// Join by link: opening ?room=CODE goes straight to the room screen with the code filled in. The QR on the room
// screen holds the same link, so a friend can scan it from across the table.

const LIVE_SITE = "https://jester-pi.vercel.app/";
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"];

/** The room code in a page's query (?room=abcd), as capitals, or null when there is none or it is not 4 letters. */
export function roomCodeFromSearch(search: string): string | null {
  const code = (new URLSearchParams(search).get("room") ?? "").trim().toUpperCase();
  return /^[A-Z]{4}$/.test(code) ? code : null;
}

/**
 * The link friends open to join this room: this copy of the game, or the live site when this copy runs on a
 * laptop nobody else can reach (a dev server). Only the room code rides along, never ?dev or other settings.
 */
export function joinLink(code: string, here: { origin: string; hostname: string; pathname: string }): string {
  const url = new URL(LOCAL_HOSTS.includes(here.hostname) ? LIVE_SITE : here.origin + here.pathname);
  url.searchParams.set("room", code);
  return url.toString();
}

/** The link as people would say it aloud: no https://. */
export const linkShown = (link: string) => link.replace(/^https?:\/\//, "");

/** This page's address with ?room= set to the code (or taken off for null), keeping every other setting. */
export function addressWithRoom(href: string, code: string | null): string {
  const url = new URL(href);
  if (code) url.searchParams.set("room", code);
  else url.searchParams.delete("room");
  return url.toString();
}
