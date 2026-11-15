// The words for the camera card, the rank title for each score (spoken by the host), the awards and the host's lines. Plain wording
// for now: the Jester's voice comes through the design flow (kb/jester-design-flow). Pure: no DOM, so
// app/test/feelText.test.ts can check it with plain node.

export type CameraTroubleKind = "refused" | "missing" | "busy" | "unsupported" | "tracker";

export interface CameraTrouble {
  kind: CameraTroubleKind;
  title: string;
  text: string;
}

/** Turns a camera or tracker failure into the camera card. Unknown errors count as the tracker not starting. */
export function cameraTrouble(err: unknown): CameraTrouble {
  const name = typeof err === "object" && err !== null && "name" in err ? String((err as { name: unknown }).name) : "";
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    return { kind: "refused", title: "The camera is blocked", text: `The browser blocked the camera. Allow it from the camera icon in the address bar, then try again.` };
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return { kind: "missing", title: "No camera found", text: "Plug in a camera, then try again." };
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return { kind: "busy", title: "The camera is in use", text: "Another app or tab is using the camera. Close it, then try again." };
  }
  if (/mediaDevices|getUserMedia/.test(message)) {
    return { kind: "unsupported", title: "No camera on this page", text: "The browser allows the camera only on a secure (https) address. Open the game from its https link, then try again." };
  }
  return { kind: "tracker", title: "The game didn't finish loading", text: "Part of the game did not load. It needs the internet the first time. Try again in a moment." };
}

export interface Rank {
  title: string;
}

/** Score tiers, best first: the lowest score that earns each title. The host says the winner's. */
export const RANKS: readonly (Rank & { min: number })[] = [
  { min: 90, title: "Top marks" },
  { min: 75, title: "Great" },
  { min: 60, title: "Good" },
  { min: 45, title: "Fair" },
  { min: 30, title: "Getting there" },
  { min: 0, title: "Keep practising" },
];

const UNSEEN: Rank = { title: "No score" };

/** The rank title for a score from 0 to 100; no score gets its own. */
export function rankFor(score: number | null): Rank {
  if (score === null || !Number.isFinite(score)) return UNSEEN;
  const r = RANKS.find((x) => score >= x.min) ?? RANKS[RANKS.length - 1]!;
  return { title: r.title };
}

// ---- Awards: everyone leaves with something ----

/** One podium row as the awards see it. `motion` comes from motionOf (null with no recording). */
export interface AwardInput {
  score: number | null;
  winner: boolean;
  motion: number | null;
}

/**
 * The winners as the scores say: rows marked winner that also hold the top score. A winner flag beside a lower
 * score (41 against 12) never makes two winners.
 */
export function winnersOf<T extends { winner: boolean; score: number | null }>(rows: readonly T[]): T[] {
  const top = Math.max(-1, ...rows.map((r) => r.score ?? -1));
  return rows.filter((r) => r.winner && r.score !== null && r.score === top);
}

/** The crowning's and the results' headline. One player is cheered on their own; nobody wins among one. */
export function headlineFor(rows: readonly { name: string; winner: boolean; score: number | null }[]): string {
  if (rows.length === 1) return rows[0]!.score === null ? `Thanks for playing, ${rows[0]!.name}!` : `Well done, ${rows[0]!.name}!`;
  const winners = winnersOf(rows);
  return winners.length === 0 ? "Everyone played!" : winners.length === 1 ? `${winners[0]!.name} wins!` : `${winners.map((w) => w.name).join(" and ")} tie!`;
}

/**
 * One award per player, all different where possible: winner (joint when tied), then most movement, close
 * second (within 10 of the top score), stillest, gave it a go (lowest score), and good sport. A player on
 * their own gets their score's rank title instead, since nobody wins among one.
 */
export function awardsFor(players: readonly AwardInput[]): string[] {
  if (players.length === 1) return [players[0]!.score === null ? "Not seen by the camera" : rankFor(players[0]!.score).title];
  const awards: (string | null)[] = players.map(() => null);
  const winners = new Set(winnersOf(players));
  players.forEach((p, i) => { if (winners.has(p)) awards[i] = winners.size > 1 ? "Joint winner" : "Winner"; });
  const top = Math.max(...players.map((p) => p.score ?? -1));
  const open = () => players.map((p, i) => ({ p, i })).filter(({ i }) => awards[i] === null);
  const give = (title: string, pickFrom: { p: AwardInput; i: number }[], better: (a: AwardInput, b: AwardInput) => number) => {
    const best = [...pickFrom].sort((a, b) => better(a.p, b.p))[0];
    if (best) awards[best.i] = title;
  };
  const moving = () => open().filter(({ p }) => p.motion !== null && p.motion > 0);
  give("Most movement", moving(), (a, b) => b.motion! - a.motion!);
  give("Close second", open().filter(({ p }) => p.score !== null && top - p.score <= 10), (a, b) => b.score! - a.score!);
  give("Stillest", moving(), (a, b) => a.motion! - b.motion!);
  give("Gave it a go", open().filter(({ p }) => p.score !== null), (a, b) => a.score! - b.score!);
  return awards.map((a, i) => a ?? (players[i]!.score === null ? "Not seen by the camera" : "Good sport"));
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

export type HostEvent = "beat" | "roll" | "crown" | "tie" | "nobody" | "solo" | "results";

const HOST_LINES: Record<HostEvent, readonly string[]> = {
  beat: ["That's everyone. Here comes the reveal."],
  roll: ["Drum roll, please."],
  crown: ["{winner} wins!"],
  tie: ["It's a tie. {winner} share the win."],
  nobody: ["Everyone played!"],
  solo: ["Well done, {winner}!"],
  results: ["Here are the scores. {winner}: {title}."],
};

/** A host line for `event`, with {winner} and {title} filled in. `random` is for tests. */
export function hostLine(event: HostEvent, vars: { winner?: string; title?: string } = {}, random: () => number = Math.random): string {
  const lines = HOST_LINES[event];
  const line = lines[Math.min(lines.length - 1, Math.floor(random() * lines.length))]!;
  return line.replace("{winner}", vars.winner ?? "everyone").replace("{title}", vars.title ?? "jester");
}
