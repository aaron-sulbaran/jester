// What the jester says when the camera lets us down, and the rank title for each score. Pure: no DOM, so
// app/test/feelText.test.ts can check it with plain node.

export type CameraTroubleKind = "refused" | "missing" | "busy" | "unsupported" | "tracker";

export interface CameraTrouble {
  kind: CameraTroubleKind;
  title: string;
  text: string;
}

const UNDERSTUDY = "Or let the understudy take this turn.";

/** Turns a camera or tracker failure into the jester's card. Unknown errors count as the tracker not starting. */
export function cameraTrouble(err: unknown): CameraTrouble {
  const name = typeof err === "object" && err !== null && "name" in err ? String((err as { name: unknown }).name) : "";
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    return { kind: "refused", title: "The jester can't see a thing!", text: `Your browser said no to the camera. Allow it from the camera icon in the address bar, then try again. ${UNDERSTUDY}` };
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return { kind: "missing", title: "No camera in sight.", text: `I looked everywhere, even under my hat. Plug a camera in, then try again. ${UNDERSTUDY}` };
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return { kind: "busy", title: "Someone else has the camera.", text: `Another app or tab is holding on to it. Close that one, then try again. ${UNDERSTUDY}` };
  }
  if (/mediaDevices|getUserMedia/.test(message)) {
    return { kind: "unsupported", title: "This page can't borrow the camera.", text: `The browser keeps the camera away from this address. Open the game from its https link and try again. ${UNDERSTUDY}` };
  }
  return { kind: "tracker", title: "My spectacles won't go on.", text: `The pose tracker did not start. It needs the internet the first time it loads. Try again in a moment. ${UNDERSTUDY}` };
}

export interface Rank {
  title: string;
  blurb: string;
}

/** Score tiers, best first: the lowest score that earns each title. */
export const RANKS: readonly (Rank & { min: number })[] = [
  { min: 90, title: "Court Favourite", blurb: "The king laughed so hard he forgot to collect taxes." },
  { min: 75, title: "Royal Jester", blurb: "Bells on, timing sharp. The court wants an encore." },
  { min: 60, title: "Juggler of the Hall", blurb: "Most of the balls stayed in the air. Most." },
  { min: 45, title: "Apprentice Fool", blurb: "You have the hat. The moves are on their way." },
  { min: 30, title: "Village Clown", blurb: "The goats were impressed. The goats are easy to impress." },
  { min: 0, title: "Stable Hand in Bells", blurb: "Bold of you to dance like nobody was watching. We were." },
];

const UNSEEN: Rank = { title: "Lost in the Crowd", blurb: "The camera never found you, so the jester kept your seat warm." };

/** The jester's title for a score from 0 to 100; no score gets its own. */
export function rankFor(score: number | null): Rank {
  if (score === null || !Number.isFinite(score)) return UNSEEN;
  const r = RANKS.find((x) => score >= x.min) ?? RANKS[RANKS.length - 1]!;
  return { title: r.title, blurb: r.blurb };
}
