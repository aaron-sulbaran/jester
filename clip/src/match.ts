// Competing mode ("duel"): everyone copies the same single subject at the same moment and is ranked.
// Pure and DOM free: which mode a clip plays in, the places after a round, and elimination rounds.
//
//   modeFor(guides.length, players)          -> "duel" for a one subject clip, else "cast" (blind roles)
//   const places = rankDuel(results);        -> place 1 is best; exact ties share a place
//   let match = startElimination(ids);       -> drop last place each round; best of three once two are left
//   ({ state: match } = advance(match, places));

export type Mode = "duel" | "cast";

/** "duel" when the clip has exactly one subject (everyone copies it), otherwise "cast" (each player gets a role). */
export function modeFor(subjects: number, _players: number): Mode {
  return subjects === 1 ? "duel" : "cast";
}

export interface DuelResult { id: string; score: number | null; lagMs: number | null }
export interface Placed extends DuelResult { place: number }

const absLag = (r: DuelResult) => (r.lagMs === null ? Infinity : Math.abs(r.lagMs));

/** Negative when `a` ranks above `b`, zero for an exact tie. */
function compare(a: DuelResult, b: DuelResult): number {
  if (a.score === null || b.score === null) return a.score === b.score ? 0 : a.score === null ? 1 : -1;
  if (a.score !== b.score) return b.score - a.score;
  const la = absLag(a), lb = absLag(b);
  return la === lb ? 0 : la < lb ? -1 : 1;
}

/**
 * Places for one round: highest score first, a missing score last, ties on score broken by the smaller
 * absolute lag, exact ties sharing a place (1, 1, 3). Players with no score all share the last place.
 */
export function rankDuel(results: readonly DuelResult[]): Placed[] {
  const sorted = [...results].sort((a, b) => compare(a, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: Placed[] = [];
  sorted.forEach((r, i) => {
    const prev = out[i - 1];
    const place = prev && compare(prev, r) === 0 ? prev.place : i + 1;
    out.push({ id: r.id, score: r.score, lagMs: r.lagMs, place });
  });
  return out;
}

export interface NextRound {
  /** Who plays the next round. */
  alive: string[];
  /** Who was dropped this round (everyone tied for last). */
  dropped: string[];
  /** True when everyone tied for last: nobody is dropped and the round is played again. */
  replay: boolean;
  /** The last player standing, or null while two or more are left. */
  winner: string | null;
}

/**
 * One elimination step. Ranks only the players still in (a player with no result counts as no score)
 * and drops everyone tied for last place, unless that would drop all of them.
 */
export function nextRound(alive: readonly string[], places: readonly DuelResult[]): NextRound {
  if (alive.length <= 1) return { alive: [...alive], dropped: [], replay: false, winner: alive[0] ?? null };
  const byId = new Map(places.map((p) => [p.id, p]));
  const ranked = rankDuel(alive.map((id) => byId.get(id) ?? { id, score: null, lagMs: null }));
  const lastPlace = Math.max(...ranked.map((r) => r.place));
  const dropped = ranked.filter((r) => r.place === lastPlace).map((r) => r.id);
  if (dropped.length === alive.length) return { alive: [...alive], dropped: [], replay: true, winner: null };
  const left = alive.filter((id) => !dropped.includes(id));
  return { alive: left, dropped, replay: false, winner: left.length === 1 ? left[0]! : null };
}

export interface BestOf {
  /** Rounds a player must win: more than half of n. */
  needed: number;
  wins: Record<string, number>;
  /** Rounds that counted (a round with a tie for first counts for nobody). */
  decided: number;
  winner: string | null;
}

/**
 * A head to head over up to `n` rounds (n odd, e.g. 3): a round goes to the single player in first place;
 * a tie for first counts for nobody and is played again. `rounds` is each finished round's places.
 */
export function bestOf(n: number, players: readonly string[], rounds: readonly (readonly DuelResult[])[]): BestOf {
  const needed = Math.floor(n / 2) + 1;
  const wins: Record<string, number> = Object.fromEntries(players.map((id) => [id, 0]));
  let decided = 0;
  let winner: string | null = null;
  for (const round of rounds) {
    if (winner) break;
    const ranked = rankDuel(players.map((id) => round.find((r) => r.id === id) ?? { id, score: null, lagMs: null }));
    const first = ranked.filter((r) => r.place === 1);
    if (first.length !== 1) continue;
    const id = first[0]!.id;
    wins[id] = (wins[id] ?? 0) + 1;
    decided += 1;
    if (wins[id]! >= needed) winner = id;
  }
  return { needed, wins, decided, winner };
}

/** Elimination across rounds: drop last place each round until two are left, then best of three. */
export interface Elimination {
  alive: string[];
  /** Everyone dropped so far, first dropped first. */
  out: string[];
  /** The best of three final's rounds, once two players are left. */
  finalRounds: DuelResult[][];
  winner: string | null;
}

export const FINAL_BEST_OF = 3;

export function startElimination(ids: readonly string[]): Elimination {
  return { alive: [...ids], out: [], finalRounds: [], winner: ids.length === 1 ? ids[0]! : null };
}

/** What happened this round, in words a screen can show. */
export interface Advance { state: Elimination; dropped: string[]; replay: boolean; final: BestOf | null }

export function advance(state: Elimination, places: readonly DuelResult[]): Advance {
  if (state.winner) return { state, dropped: [], replay: false, final: null };
  if (state.alive.length === 2) {
    const thisRound = state.alive.map((id) => places.find((p) => p.id === id) ?? { id, score: null, lagMs: null });
    const finalRounds = [...state.finalRounds, thisRound];
    const final = bestOf(FINAL_BEST_OF, state.alive, finalRounds);
    const replay = rankDuel(thisRound).filter((r) => r.place === 1).length !== 1;
    const loser = final.winner ? state.alive.filter((id) => id !== final.winner) : [];
    return {
      state: { alive: final.winner ? [final.winner] : state.alive, out: [...state.out, ...loser], finalRounds, winner: final.winner },
      dropped: loser, replay, final,
    };
  }
  const step = nextRound(state.alive, places);
  return {
    state: { alive: step.alive, out: [...state.out, ...step.dropped], finalRounds: [], winner: step.winner },
    dropped: step.dropped, replay: step.replay, final: null,
  };
}

// ---- Where a player fell behind (cheap: from the engine's per frame credits) ----

/**
 * The engine's per grid frame credits (0..1 or null, frame k at k * gridMs media ms), averaged into
 * buckets of `bucketMs` over the round's stretch, as whole numbers 0..100 (null where nothing scored).
 * Small enough to send with a result: 20 s at 200 ms is 100 numbers.
 */
export function bucketCredits(frameCredits: readonly (number | null)[], startMs: number, endMs: number, gridMs: number, bucketMs = 200): (number | null)[] {
  const out: (number | null)[] = [];
  for (let from = startMs; from < endMs; from += bucketMs) {
    let sum = 0, count = 0;
    for (let k = Math.ceil(from / gridMs); k * gridMs < Math.min(endMs, from + bucketMs); k++) {
      const c = frameCredits[k];
      if (c !== null && c !== undefined) { sum += c; count++; }
    }
    out.push(count ? Math.round((sum / count) * 100) : null);
  }
  return out;
}

/**
 * Where `trailer` fell furthest behind `leader`: the middle of the `windowMs` stretch with the largest
 * average credit gap, in ms from the round's start. Null when the gap never reaches `minGap` points.
 */
export function fellBehind(leader: readonly (number | null)[], trailer: readonly (number | null)[], bucketMs = 200, windowMs = 1000, minGap = 10): number | null {
  const span = Math.max(1, Math.round(windowMs / bucketMs));
  let best: { at: number; gap: number } | null = null;
  for (let k = 0; k + span <= Math.max(leader.length, trailer.length); k++) {
    let sum = 0, count = 0;
    for (let j = k; j < k + span; j++) {
      const a = leader[j], b = trailer[j];
      if (a === null || a === undefined || b === null || b === undefined) continue;
      sum += a - b; count++;
    }
    if (count * 2 < span) continue;
    const gap = sum / count;
    if (!best || gap > best.gap) best = { at: k * bucketMs + (span * bucketMs) / 2, gap };
  }
  return best && best.gap >= minGap ? best.at : null;
}

/** "0:07" for 7000 ms. */
export function clockText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
