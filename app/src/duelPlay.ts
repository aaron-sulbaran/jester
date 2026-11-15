// Duel in the main game: two or more players copy a one-person clip's person, one after another on the
// same laptop, and the best copy wins. Pure and DOM free, so the rules are unit tested (test/duelPlay.test.ts).
// blind.ts deals with `duelGuides` and ranks with `duelPlaces`; the results and crowning say `duelHeadline`.

import { rankDuel } from "../../clip/src/match.ts";
import type { Guide } from "../../clip/src/index.ts";

/**
 * The one guide every player copies in a duel: the clip's person, never a thing (on a clip with a person
 * and balls, the person). With several people the first is used, so everyone still copies the same one.
 * A clip with no person keeps all its guides, so the game falls back to dealing roles as usual.
 */
export function duelGuides(guides: readonly Guide[]): Guide[] {
  const person = guides.find((g) => g.subject.kind === "person");
  return person ? [person] : [...guides];
}

export interface DuelPlace {
  /** 1 is the winner; exact ties (same score and the same timing) share a place. */
  place: number;
  /** In first place with a score. */
  winner: boolean;
  /** More than one player is in first place. */
  tied: boolean;
}

/**
 * Places for a duel, in the players' own order: highest score first, ties on score broken by the timing
 * closer to the beat (smaller absolute lag), a missing score last. A missing lag is null, never 0, so a
 * player with no timing never wins a tie by default.
 */
export function duelPlaces(scores: readonly (number | null)[], lags: readonly (number | null)[]): DuelPlace[] {
  const ranked = rankDuel(scores.map((score, i) => ({ id: String(i), score, lagMs: score === null ? null : lags[i] ?? null })));
  const placeOf = new Map(ranked.map((r) => [r.id, r.place]));
  const firsts = ranked.filter((r) => r.place === 1 && r.score !== null).length;
  return scores.map((score, i) => {
    const place = placeOf.get(String(i))!;
    return { place, winner: place === 1 && score !== null, tied: firsts > 1 };
  });
}

/**
 * The podium: who stands where, and their place. A duel lists players by the place finishGame gave them, so the
 * crowned player is first even when timing broke a tie on score. Any other game keeps the order it is given (best
 * score first) and counts higher scores, so tied scores share a place, exactly as before duels.
 */
export function podiumOrder<R extends { score: number | null; duel?: boolean; place?: number }>(rows: readonly R[]): { row: R; place: number }[] {
  if (!rows.some((r) => r.duel)) return rows.map((row) => ({ row, place: 1 + rows.filter((o) => (o.score ?? -1) > (row.score ?? -1)).length }));
  return [...rows].sort((a, b) => (a.place ?? Infinity) - (b.place ?? Infinity)).map((row) => ({ row, place: row.place ?? rows.length }));
}

/** The results and crowning headline for a duel. */
export function duelHeadline(winners: readonly string[]): string {
  if (winners.length === 0) return "Everyone played!";
  return winners.length === 1 ? `${winners[0]} wins the duel!` : "It's a tie!";
}

/** The award line under the duel's winner on the podium. */
export const DUEL_WINNER_AWARD = "Duel winner";
