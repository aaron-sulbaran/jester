// What the jester says when the camera lets us down, the rank title for each score, the awards and the host's
// lines. Pure: no DOM, so app/test/feelText.test.ts can check it with plain node.

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

// ---- Awards: everyone leaves with something ----

/** One podium row as the awards see it. `motion` comes from motionOf (null with no recording). */
export interface AwardInput {
  score: number | null;
  winner: boolean;
  motion: number | null;
}

/**
 * One award per player, all different where possible: the crown for the winner (shared when tied), then the
 * most energetic, the nearly royal (within 10 of the top score), the statue, the bravest attempt, and a good sport.
 */
export function awardsFor(players: readonly AwardInput[]): string[] {
  const awards: (string | null)[] = players.map(() => null);
  const winners = players.filter((p) => p.winner).length;
  players.forEach((p, i) => { if (p.winner) awards[i] = winners > 1 ? "Shared Crown" : "The Crown"; });
  const top = Math.max(...players.map((p) => p.score ?? -1));
  const open = () => players.map((p, i) => ({ p, i })).filter(({ i }) => awards[i] === null);
  const give = (title: string, pickFrom: { p: AwardInput; i: number }[], better: (a: AwardInput, b: AwardInput) => number) => {
    const best = [...pickFrom].sort((a, b) => better(a.p, b.p))[0];
    if (best) awards[best.i] = title;
  };
  const moving = () => open().filter(({ p }) => p.motion !== null && p.motion > 0);
  give("Most Energetic", moving(), (a, b) => b.motion! - a.motion!);
  give("Nearly Royal", open().filter(({ p }) => p.score !== null && top - p.score <= 10), (a, b) => b.score! - a.score!);
  give("Statue of the Court", moving(), (a, b) => a.motion! - b.motion!);
  give("Bravest Attempt", open().filter(({ p }) => p.score !== null), (a, b) => a.score! - b.score!);
  return awards.map((a, i) => a ?? (players[i]!.score === null ? "Mystery Guest" : "Good Sport"));
}

type Point = { x: number; y: number; visibility?: number };

/**
 * How much a player moved: wrists and ankles, in image heights per second, from their recording
 * ({ frames: [{ t, landmarks }] }). Null when there is too little to tell.
 */
export function motionOf(timeline: { frames: readonly { t: number; landmarks: readonly unknown[] | null }[] } | null): number | null {
  const frames = timeline?.frames ?? [];
  if (frames.length < 2) return null;
  let travel = 0;
  for (let k = 1; k < frames.length; k++) {
    const a = frames[k - 1]!.landmarks as readonly Point[] | null, b = frames[k]!.landmarks as readonly Point[] | null;
    if (!a || !b) continue;
    for (const j of [15, 16, 27, 28]) {
      const p = a[j], q = b[j];
      if (!p || !q || (p.visibility ?? 1) < 0.5 || (q.visibility ?? 1) < 0.5) continue;
      travel += Math.hypot(q.x - p.x, q.y - p.y);
    }
  }
  const seconds = (frames[frames.length - 1]!.t - frames[0]!.t) / 1000;
  return seconds > 0 ? travel / seconds : null;
}

// ---- The host: canned lines, spoken by the browser ----

export type HostEvent = "beat" | "roll" | "crown" | "tie" | "nobody" | "results";

const HOST_LINES: Record<HostEvent, readonly string[]> = {
  beat: ["That's everyone! Gather round.", "Pencils down, jesters. Time for the truth.", "And that's the show. Or is it?"],
  roll: ["Drum roll, please!", "Who wears the crown tonight?", "The court holds its breath."],
  crown: ["{winner} takes the crown!", "All hail {winner}!", "Bow to {winner}, the finest fool in the land!"],
  tie: ["A tie! {winner} share the crown.", "Two heads, one crown. Well played, {winner}."],
  nobody: ["Everyone played! The crown stays in its box tonight.", "No crown tonight. The court will talk about this."],
  results: ["{winner} is our {title}!", "Here are the scrolls. {winner} is our {title}.", "The court has spoken. {winner}, {title}!"],
};

/** A host line for `event`, with {winner} and {title} filled in. `random` is for tests. */
export function hostLine(event: HostEvent, vars: { winner?: string; title?: string } = {}, random: () => number = Math.random): string {
  const lines = HOST_LINES[event];
  const line = lines[Math.min(lines.length - 1, Math.floor(random() * lines.length))]!;
  return line.replace("{winner}", vars.winner ?? "everyone").replace("{title}", vars.title ?? "jester");
}
